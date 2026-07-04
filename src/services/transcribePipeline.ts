// 分段混合轉錄管線：把（PCM16 WAV）音訊切段，逐段先用主力（Gemini）、失敗改後援（Groq Whisper），
// 時間戳位移後接回。單段全敗只補「缺漏標記」不拖垮整檔；只有全部段皆敗才拋。附進度回報。
//
// 純函式、與具體服務解耦（transcriber 由呼叫端注入）→ 可單元測試；ffmpeg 轉檔在 AudioDecoder，
// 這裡只吃已可解析的 PCM16 WAV（呼叫端先確保）。

import { chunkWavByBytes } from "./wavChunk";
import { AppError, ErrorCode, type TranscribeLang } from "../shared/types";

/** 單段音訊轉錄器：輸入 base64 WAV，回帶 `[mm:ss] 發言人: …` 時間戳的逐字稿。 */
export type ChunkTranscriber = (
  wavBase64: string,
  mimeType: string,
  lang: TranscribeLang,
) => Promise<string>;

export interface TranscribeChunkedOpts {
  /** 主力轉錄器（品質優先，通常 Gemini）。 */
  primary: ChunkTranscriber;
  /** 後援轉錄器（主力該段失敗時接手，通常 Groq Whisper）。 */
  fallback?: ChunkTranscriber;
  /** 每段位元組上限；預設讓 Gemini 可 inline（避開較不穩的 Files API）。 */
  chunkBytes?: number;
  /** 同時並行轉錄的段數（加速長檔；預設 3，兼顧速度與免費層限流）。 */
  concurrency?: number;
  /** 進度回報：開頭發一次 (0,total)，之後每完成一段發 (done,total)。 */
  onProgress?: (done: number, total: number) => void;
}

// 每段 ~3 分鐘（16kHz 單聲道）：落在 Gemini inline 安全上限內、Groq 單次也吃得下；
// 切小一點 → 更快看到第一段完成、進度條增量更細（體感有在動），並可多段並行加速。
const DEFAULT_CHUNK_BYTES = 6 * 1024 * 1024;
// 同時並行的段數：長檔加速的主力（依序做太慢）；免費層有 RPM 限，3 條平衡速度/限流/記憶體。
const DEFAULT_CONCURRENCY = 3;

/** 秒 → mm:ss（分鐘可超過 59，長錄音接合用）。 */
export function mmss(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

// 行首時間戳：[mm:ss] 或 [h:mm:ss]（分鐘 1~3 位）。
const STAMP_RE = /^\s*\[(\d{1,3}):(\d{2})(?::(\d{2}))?\]/;

/** 把逐字稿每行開頭的時間戳整體位移 offsetSec 秒（分段接合時把各段對回整段絕對時間）。 */
export function shiftTimestamps(text: string, offsetSec: number): string {
  const off = Math.floor(offsetSec);
  if (!off) return text;
  return text
    .split("\n")
    .map((line) => {
      const m = line.match(STAMP_RE);
      if (!m) return line;
      const sec =
        m[3] != null
          ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
          : Number(m[1]) * 60 + Number(m[2]);
      return line.replace(STAMP_RE, `[${mmss(sec + off)}]`);
    })
    .join("\n");
}

/**
 * 分段混合轉錄。呼叫端須先確保傳入的是可解析的 PCM16 WAV（非 WAV 請先經 AudioDecoder 轉檔）。
 * 回接合後的完整逐字稿；整段皆失敗才拋 AppError。
 */
export async function transcribeChunked(
  wav: Buffer,
  lang: TranscribeLang,
  opts: TranscribeChunkedOpts,
): Promise<string> {
  const chunks = chunkWavByBytes(wav, opts.chunkBytes ?? DEFAULT_CHUNK_BYTES);
  const total = chunks.length;
  const results = new Array<string>(total); // 依索引存放，接合時保留原始時間順序
  let anySuccess = false;
  let completed = 0;

  // 先發一個「0/N 段」讓前端進度條立刻出現（否則第一段做完前一片空白；單段檔更是完全看不到）。
  opts.onProgress?.(0, total);

  /** 轉錄第 i 段：主力 → 失敗 per-chunk 後援 → 都失敗補缺漏標記（不拖垮整檔）。 */
  async function runChunk(i: number): Promise<void> {
    const c = chunks[i];
    const b64 = c.wav.toString("base64");
    let seg = "";
    try {
      seg = shiftTimestamps((await opts.primary(b64, "audio/wav", lang)).trim(), c.startSec);
    } catch {
      if (opts.fallback) {
        try {
          seg = shiftTimestamps((await opts.fallback(b64, "audio/wav", lang)).trim(), c.startSec);
        } catch {
          seg = "";
        }
      }
    }
    if (seg) {
      results[i] = seg;
      anySuccess = true;
    } else {
      results[i] = `[${mmss(c.startSec)}] 發言人: （此段轉錄失敗，未取得內容）`;
    }
    completed += 1;
    opts.onProgress?.(completed, total);
  }

  // 多段並行（限流閥）：workers 共搶下一個未做的段索引；順序靠 results[i] 保留。
  const workerCount = Math.max(1, Math.min(opts.concurrency ?? DEFAULT_CONCURRENCY, total));
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= total) break;
      await runChunk(i);
    }
  }
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  if (!anySuccess) {
    throw new AppError(ErrorCode.CLAUDE_API_ERROR, "整段音訊皆轉錄失敗（可能是網路、限流或格式問題）");
  }
  return results.join("\n").trim();
}
