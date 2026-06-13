// ════════════════════════════════════════════════════════════════════
//  StreamingTranscriber — 滑動視窗串流轉寫（whisper.cpp）
//
//  上層管線把正規化後的 AudioChunk 持續 push 進來，本模組在內部累積成一個
//  Float32 視窗。當呼叫 flush 時，把目前視窗寫成暫存 WAV，spawn whisper.cpp
//  的 CLI（whisper-cli / main）對它轉寫，解析輸出成 TranscriptSegment[]。
//
//  斷字防護：每次 flush 後保留視窗尾端約 1 秒 PCM 當作下一視窗的「重疊」，
//  其餘清掉。這樣跨視窗邊界的字不會被硬切成兩半。
//
//  容錯原則（重要）：轉寫只是錄音流程的「加值」，單次失敗（whisper 沒設好、
//  CLI 掛掉、JSON 壞掉）絕不能炸掉整個收音。失敗時 console.warn 後回 []。
//  唯有「設定不全」（whisperBin/modelPath 缺一）時，enabled=false，flush 直接
//  回 [] 連 spawn 都不做。
// ════════════════════════════════════════════════════════════════════

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

import { AppError, ErrorCode, type TranscriptSegment } from "../../shared/types";
import type { AudioChunk } from "./types";
import { TARGET_SAMPLE_RATE } from "./types";
import { writeWavFile } from "./WavEncoder";

export interface StreamingTranscriberOptions {
  /** whisper.cpp 模型路徑（ggml/gguf）；對應 env WHISPER_MODEL_PATH。 */
  modelPath?: string;
  /** whisper.cpp 執行檔（whisper-cli 或 main）；對應 env WHISPER_BIN。 */
  whisperBin?: string;
  /** 每累積這麼多秒就「可以」flush 一次；預設 6。 */
  windowSec?: number;
}

/** 視窗尾端保留作為重疊的秒數（避免斷字）。 */
const OVERLAP_SEC = 1;
/** whisper CLI 等待上限（毫秒）；超時即視為失敗並降級回 []。 */
const TRANSCRIBE_TIMEOUT_MS = 60_000;

/** whisper -oj 產出的 JSON 形狀（只取我們需要的欄位，其餘忽略）。 */
interface WhisperJson {
  transcription?: Array<{
    text?: string;
    offsets?: { from?: number; to?: number }; // 毫秒
    timestamps?: { from?: string; to?: string }; // "HH:MM:SS,mmm"
  }>;
}

export class StreamingTranscriber {
  private readonly modelPath?: string;
  private readonly whisperBin?: string;
  /** 視窗長度（秒）；公開供上層引擎決定 flush 週期（AudioCaptureEngine 會讀此值）。 */
  readonly windowSec: number;
  private readonly sampleRate = TARGET_SAMPLE_RATE;

  /** 累積中的 PCM 視窗。 */
  private buffer: Float32Array = new Float32Array(0);
  /** 視窗第一個樣本對應的「全域時間軸秒數」，用來回填 segment 時間（隨視窗推進累加）。 */
  private windowStartSec = 0;

  constructor(opts: StreamingTranscriberOptions = {}) {
    this.modelPath = opts.modelPath?.trim() || undefined;
    this.whisperBin = opts.whisperBin?.trim() || undefined;
    this.windowSec = opts.windowSec && opts.windowSec > 0 ? opts.windowSec : 6;
  }

  /** whisperBin 與 modelPath 都有設定才為 true；否則 flush 直接回 []。 */
  get enabled(): boolean {
    return Boolean(this.whisperBin && this.modelPath);
  }

  /**
   * 累積一塊 PCM（不立即轉寫）。
   * 全域時間軸由 windowStartSec（隨視窗推進累加）決定，故只需把樣本接到 buffer 尾端。
   */
  push(chunk: AudioChunk): void {
    if (!chunk || chunk.samples.length === 0) return;

    // 接到內部 buffer 尾端
    const next = new Float32Array(this.buffer.length + chunk.samples.length);
    next.set(this.buffer, 0);
    next.set(chunk.samples, this.buffer.length);
    this.buffer = next;
  }

  /**
   * 對目前累積視窗轉寫，回傳新增 segments，並保留尾端約 1 秒重疊避免斷字。
   * - enabled=false → 直接回 []（不報錯、不 spawn）。
   * - 任何轉寫/解析失敗 → console.warn 後回 []（不炸掉收音流程）。
   */
  async flush(): Promise<TranscriptSegment[]> {
    if (!this.enabled) return [];
    if (this.buffer.length === 0) return [];

    // 取出目前視窗的快照（避免轉寫期間 push 進來的資料汙染本次結果）
    const windowSamples = this.buffer;
    const windowStartSec = this.windowStartSec;

    const tmpWav = this.makeTempWavPath();
    try {
      await writeWavFile(tmpWav, windowSamples, this.sampleRate);
      const segments = await this.runWhisper(tmpWav, windowStartSec);
      this.advanceWindow(windowSamples);
      return segments;
    } catch (err) {
      // 容錯：單次失敗不該中斷整個收音；仍要前進視窗，否則壞掉的音檔會一直卡著
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[StreamingTranscriber] 轉寫失敗，略過本視窗：${message}`);
      this.advanceWindow(windowSamples);
      return [];
    } finally {
      await this.safeUnlink(tmpWav);
    }
  }

  /** 清空所有累積狀態（換 session / 停止收音時呼叫）。 */
  reset(): void {
    this.buffer = new Float32Array(0);
    this.windowStartSec = 0;
  }

  // ─────────────── 私有 ───────────────

  /**
   * 轉寫後推進視窗：保留尾端 OVERLAP_SEC 秒的 PCM 當下一視窗開頭，其餘丟棄，
   * 並把 windowStartSec 往前推「被丟棄的時間長度」。
   *
   * 傳入「本次實際轉寫的視窗」而非 this.buffer，因為轉寫期間可能又 push 了
   * 新資料；我們只丟棄「已轉寫且不重疊」的部分，新資料完整保留。
   */
  private advanceWindow(transcribed: Float32Array): void {
    const overlapSamples = Math.min(
      transcribed.length,
      Math.round(OVERLAP_SEC * this.sampleRate),
    );
    const droppedSamples = transcribed.length - overlapSamples;

    // 從目前 buffer 砍掉「已轉寫且非重疊」的前段；轉寫期間新 push 的資料在尾端，原樣保留。
    if (droppedSamples > 0 && this.buffer.length >= droppedSamples) {
      this.buffer = this.buffer.slice(droppedSamples);
      this.windowStartSec += droppedSamples / this.sampleRate;
    } else if (droppedSamples > 0) {
      // 理論上不會發生（buffer 至少含 transcribed），保險：整段清掉
      this.buffer = new Float32Array(0);
      this.windowStartSec += droppedSamples / this.sampleRate;
    }
  }

  /**
   * spawn whisper.cpp CLI 對 wav 轉寫，產 JSON 後解析。
   * 參數：`-m <model> -f <wav> -oj -of <outBase>`（產 <outBase>.json）。
   * 失敗（非 0 退出、逾時、找不到 JSON、JSON 壞掉）一律拋 AppError(IO_ERROR)，
   * 由 flush 攔下並降級。
   */
  private async runWhisper(wavPath: string, baseSec: number): Promise<TranscriptSegment[]> {
    const bin = this.whisperBin!;
    const model = this.modelPath!;
    const outBase = wavPath.replace(/\.wav$/i, "");
    const jsonPath = `${outBase}.json`;

    const args = ["-m", model, "-f", wavPath, "-oj", "-of", outBase];

    let stderrBuf = "";
    const exitCode = await new Promise<number>((resolve, reject) => {
      let settled = false;
      const finish = (code: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(code);
      };

      let proc: ReturnType<typeof spawn>;
      try {
        proc = spawn(bin, args);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      proc.stderr?.on("data", (d: Buffer) => {
        stderrBuf += d.toString("utf8");
        if (stderrBuf.length > 32_000) stderrBuf = stderrBuf.slice(-16_000);
      });
      proc.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
      proc.on("close", (code) => finish(code ?? -1));

      const timer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // 已結束
        }
        if (settled) return;
        settled = true;
        reject(new Error(`whisper 轉寫逾時（>${TRANSCRIBE_TIMEOUT_MS}ms）`));
      }, TRANSCRIBE_TIMEOUT_MS);
    });

    if (exitCode !== 0) {
      throw new AppError(
        ErrorCode.IO_ERROR,
        `whisper 退出碼非 0（${exitCode}）`,
        stderrBuf.trim().split("\n").slice(-6).join("\n"),
      );
    }

    // 讀 JSON 輸出
    let raw: string;
    try {
      raw = await fs.readFile(jsonPath, "utf8");
    } catch (err) {
      throw new AppError(
        ErrorCode.IO_ERROR,
        "找不到 whisper JSON 輸出",
        err instanceof Error ? err.message : err,
      );
    } finally {
      await this.safeUnlink(jsonPath);
    }

    let parsed: WhisperJson;
    try {
      parsed = JSON.parse(raw) as WhisperJson;
    } catch (err) {
      throw new AppError(
        ErrorCode.IO_ERROR,
        "whisper JSON 解析失敗",
        err instanceof Error ? err.message : err,
      );
    }

    return this.toSegments(parsed, baseSec);
  }

  /**
   * 把 whisper JSON 轉成 TranscriptSegment[]，並把每段時間加上視窗起始（baseSec）
   * 回填到全域時間軸。
   * - 有 offsets（毫秒）→ 直接用。
   * - 退而求其次有 timestamps（"HH:MM:SS,mmm"）→ 解析。
   * - 兩者皆無（如 -otxt 模式）→ 以視窗起始時間估算（整段落在 baseSec）。
   * 空白 / 純空字串片段一律略過。
   */
  private toSegments(parsed: WhisperJson, baseSec: number): TranscriptSegment[] {
    const rows = parsed.transcription;
    if (!Array.isArray(rows) || rows.length === 0) return [];

    const segments: TranscriptSegment[] = [];
    for (const row of rows) {
      const text = (row.text ?? "").trim();
      if (!text) continue;

      let startSec: number;
      let endSec: number;

      if (row.offsets && typeof row.offsets.from === "number") {
        startSec = row.offsets.from / 1000;
        endSec = typeof row.offsets.to === "number" ? row.offsets.to / 1000 : startSec;
      } else if (row.timestamps && row.timestamps.from) {
        startSec = parseWhisperTimestamp(row.timestamps.from);
        endSec = row.timestamps.to ? parseWhisperTimestamp(row.timestamps.to) : startSec;
      } else {
        // 無時間資訊（如 -otxt）：整段歸到視窗起點
        startSec = 0;
        endSec = 0;
      }

      segments.push({
        start: round3(baseSec + startSec),
        end: round3(baseSec + Math.max(startSec, endSec)),
        text,
      });
    }
    return segments;
  }

  /** 在系統暫存目錄產生唯一的 wav 路徑。 */
  private makeTempWavPath(): string {
    const token = randomBytes(8).toString("hex");
    return path.join(os.tmpdir(), `proactor-asr-${token}.wav`);
  }

  /** 刪檔但吞錯（清理用）。 */
  private async safeUnlink(p: string): Promise<void> {
    try {
      await fs.unlink(p);
    } catch {
      // 不存在或已刪皆無妨
    }
  }
}

// ─────────────── 模組層級工具 ───────────────

/** 解析 whisper 的時間戳字串 "HH:MM:SS,mmm" → 秒（含小數）。失敗回 0。 */
function parseWhisperTimestamp(ts: string): number {
  const m = ts.match(/^(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})$/);
  if (!m) return 0;
  const h = Number(m[1]);
  const min = Number(m[2]);
  const s = Number(m[3]);
  const ms = Number(m[4].padEnd(3, "0"));
  return h * 3600 + min * 60 + s + ms / 1000;
}

/** 四捨五入到 3 位小數（毫秒級時間戳，避免浮點長尾）。 */
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
