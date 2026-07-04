// 長逐字稿翻譯：整份一次翻會撞 Groq 每分鐘 token 上限。翻譯必須保留「每一行」（不能像聊天只挑片段），
// 故改「逐批翻」——依行邊界切成小批、各批分別翻、再依原順序接回。每批夠小任一供應商都吃得下。
// 分段邊界皆在整行處，行內 [mm:ss]/發言人 由翻譯提示原樣保留，接回不錯位。

import { splitTranscript } from "./analyzePipeline";

/** 翻一段（保留 [mm:ss] 與發言人）。Gemini/Groq 皆實作 translateWithTimestamps。 */
export type LineTranslator = (transcript: string, targetLanguage: string) => Promise<string>;

export interface TranslateChunkedOpts {
  /** 每批字數上限（要小到 Groq 單次吃得下）。 */
  chunkChars?: number;
  /** 並行批數。 */
  concurrency?: number;
}

const CHUNK_CHARS = 5000;
const CONCURRENCY = 3;

/**
 * 逐批翻譯並依原順序接回。短逐字稿直接單批（行為不變）。
 * 某批失敗 → 保留該批原文（不整份失敗、也不遺失行），其餘照常。
 */
export async function translateChunked(
  translate: LineTranslator,
  transcript: string,
  targetLanguage: string,
  opts: TranslateChunkedOpts = {},
): Promise<string> {
  const text = transcript.trim();
  const chunkChars = opts.chunkChars ?? CHUNK_CHARS;
  if (text.length <= chunkChars) return translate(text, targetLanguage);

  const chunks = splitTranscript(text, chunkChars);
  const parts = new Array<string>(chunks.length);
  const conc = Math.max(1, Math.min(opts.concurrency ?? CONCURRENCY, chunks.length));
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= chunks.length) break;
      try {
        parts[i] = (await translate(chunks[i], targetLanguage)).trim();
      } catch {
        parts[i] = chunks[i]; // 該批翻譯失敗 → 保留原文，不丟整份
      }
    }
  }
  await Promise.all(Array.from({ length: conc }, () => worker()));
  return parts.join("\n").trim();
}
