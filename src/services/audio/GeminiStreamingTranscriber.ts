// ════════════════════════════════════════════════════════════════════
//  GeminiStreamingTranscriber — 用 Gemini Live 當「即時轉寫器」
//
//  與 StreamingTranscriber（whisper）實作同一個 TranscriberLike 契約，但底層改走
//  GeminiLiveService 的雲端即時逐字稿：把 router 餵進來的 16kHz Float32 PCM 轉成
//  Int16LE base64 串給 Gemini Live，背景累積它回吐的 inputTranscription 文字；
//  flush() 時把累積文字當「一段 segment」吐出（時間軸用「已餵入樣本數 / 16kHz」推算）。
//
//  用途：本機沒裝 whisper（WHISPER_BIN 未設）但有 GEMINI_API_KEY 時，讓「電腦系統 /
//  手機收音」這條 router 收音管線也能即時出字（粗稿；非整檔精修）。
//
//  容錯：即時轉寫只是收音的加值，連線層錯誤吞掉、不中斷收音（沿用 GeminiLiveService
//  自身的 15 分鐘重連機制）。Live session 首次 push 才 lazy 開，reset/停止收音時關。
// ════════════════════════════════════════════════════════════════════

import { GeminiLiveService } from "../GeminiLiveService";
import type { AudioChunk, TranscriberLike } from "./types";
import { TARGET_SAMPLE_RATE } from "./types";
import type { TranscriptSegment } from "../../shared/types";

/** GeminiStreamingTranscriber 真正用到的 Live 後端能力（抽介面方便測試注入假後端）。 */
export interface LiveTranscriptBackend {
  start(onText: (t: string) => void, onError: (m: string) => void): void;
  pushAudio(pcmBase64: string): void;
  stop(): void;
}

export interface GeminiStreamingTranscriberOptions {
  apiKey?: string;
  model?: string;
  /** flush 視窗秒數（給 router 決定 flush 週期）；預設 2。 */
  windowSec?: number;
  /** 注入用：預設自建 GeminiLiveService；測試可塞假後端。 */
  backend?: LiveTranscriptBackend;
}

export class GeminiStreamingTranscriber implements TranscriberLike {
  private readonly backend: LiveTranscriptBackend;
  private readonly hasKey: boolean;
  readonly windowSec: number;

  /** Live session 是否已開（首次 push 才 lazy 開，reset 後關）。 */
  private started = false;
  /** 已回吐、尚未被 flush 取走的文字。 */
  private pendingText = "";
  /** 已餵入的 16kHz 樣本總數，用來推算時間軸。 */
  private fedSamples = 0;
  /** 上次 flush 對應的音訊秒數（下一段的起點）。 */
  private lastFlushSec = 0;

  constructor(opts: GeminiStreamingTranscriberOptions) {
    this.hasKey = Boolean(opts.backend) || Boolean(opts.apiKey);
    this.windowSec = opts.windowSec && opts.windowSec > 0 ? opts.windowSec : 2;
    this.backend =
      opts.backend ?? new GeminiLiveService({ apiKey: opts.apiKey ?? "", model: opts.model });
  }

  /** 有金鑰（或注入後端）才啟用；否則 router 不會餵、flush 一律回 []。 */
  get enabled(): boolean {
    return this.hasKey;
  }

  push(chunk: AudioChunk): void {
    if (!this.enabled || !chunk || chunk.samples.length === 0) return;
    this.ensureStarted();
    this.fedSamples += chunk.samples.length;
    this.backend.pushAudio(floatToPcmBase64(chunk.samples));
  }

  async flush(): Promise<TranscriptSegment[]> {
    const text = cleanCjkSpaces(this.pendingText).trim();
    if (!text) return [];
    this.pendingText = "";
    const endSec = round3(this.fedSamples / TARGET_SAMPLE_RATE);
    const startSec = Math.min(this.lastFlushSec, endSec);
    this.lastFlushSec = endSec;
    return [{ start: startSec, end: endSec, text }];
  }

  reset(): void {
    this.pendingText = "";
    this.fedSamples = 0;
    this.lastFlushSec = 0;
    if (this.started) {
      this.backend.stop();
      this.started = false;
    }
  }

  private ensureStarted(): void {
    if (this.started) return;
    this.started = true;
    this.backend.start(
      (t) => {
        this.pendingText += t;
      },
      () => {
        // 即時轉寫只是加值；連線層錯誤吞掉，不中斷收音（router 自身另有錯誤事件）。
      },
    );
  }
}

// ─────────────── 純函式工具 ───────────────

/** Float32(-1..1) → Int16LE PCM → base64（Gemini Live 期望的 16kHz/mono PCM）。 */
function floatToPcmBase64(samples: Float32Array): string {
  const buf = Buffer.allocUnsafe(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    let s = samples[i];
    if (s > 1) s = 1;
    else if (s < -1) s = -1;
    buf.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), i * 2);
  }
  return buf.toString("base64");
}

/** 收掉 CJK 字之間的空白（STT 粗稿常見字間空格）。 */
function cleanCjkSpaces(s: string): string {
  return s.replace(/([一-鿿぀-ヿ])\s+(?=[一-鿿぀-ヿ])/g, "$1");
}

/** 四捨五入到 3 位小數。 */
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
