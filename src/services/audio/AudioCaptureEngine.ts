// ════════════════════════════════════════════════════════════════════
//  AudioCaptureEngine — 雙源收音協調器
//
//  把「系統混音」與「手機 WSS」兩種收音來源統一成同一條管線：
//
//    來源 onChunk ─▶ [手機才做] AudioSync 去重/補位
//                 ─▶ AGC 平滑增益
//                 ─▶ VuMeter 算音量（節流推 vu 事件給前端訊號條）
//                 ─▶ StreamingTranscriber.push（背景轉寫）
//
//  另開一個計時器週期性 flush 轉寫器，把 Whisper 吐出的片段以 transcript
//  事件推給前端。所有對外事件都經由 emit() 安全送出（onEvent 可不存在）。
//
//  狀態機很簡單：active 表示是否正在收音；切換來源前一定先 stop()，
//  stop() 可重複呼叫不出錯（清計時器、停來源、收尾 flush）。
// ════════════════════════════════════════════════════════════════════

import type {
  AudioChunk,
  AudioEngineStatus,
  AudioEvent,
  AudioSourceKind,
  CaptureSource,
  PhoneBridge,
  PhoneSession,
} from "./types";
import { TARGET_SAMPLE_RATE } from "./types";
import type { Agc } from "./Agc";
import type { StreamingTranscriber } from "./StreamingTranscriber";
import { AudioSync } from "./AudioSync";
import { computeVu } from "./VuMeter";

/** 轉寫器可能額外暴露的視窗秒數（非契約必要欄位，故以可選方式探測）。 */
type TranscriberWithWindow = StreamingTranscriber & { windowSec?: number };

/** flush 轉寫器的預設週期（秒）；轉寫器若有 windowSec 則以它為準。 */
const DEFAULT_FLUSH_SEC = 5;

/** VU 事件節流間隔（毫秒）：每塊都算 VU，但最多每 100ms 推一次給前端。 */
const VU_THROTTLE_MS = 100;

export interface AudioEngineDeps {
  system: CaptureSource;
  phone: PhoneBridge;
  agc: Agc;
  transcriber?: StreamingTranscriber;
  onEvent?: (e: AudioEvent) => void;
}

export class AudioCaptureEngine {
  private readonly deps: AudioEngineDeps;
  private readonly sync = new AudioSync();

  /** 目前是否收音中。 */
  private active = false;
  /** 目前來源種類（null = 未收音）。 */
  private currentKind: AudioSourceKind | null = null;
  /** 目前作用中的來源物件（stop 時要對它呼叫 stop）。 */
  private activeSource: CaptureSource | null = null;
  /** 週期性 flush 轉寫器的計時器。 */
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  /** 上次推送 VU 事件的時間戳（節流用）。 */
  private lastVuAt = 0;

  constructor(deps: AudioEngineDeps) {
    this.deps = deps;
  }

  /**
   * 開始收音。若已在收音會先 stop() 收尾再切換來源。
   * phone 來源時重置同步器 / AGC / 轉寫器，避免沿用上個 session 的狀態。
   */
  async start(source: AudioSourceKind): Promise<void> {
    // 切換來源或重複 start：先乾淨停掉舊的
    if (this.active) {
      await this.stop();
    }

    const chosen: CaptureSource = source === "phone" ? this.deps.phone : this.deps.system;

    // 手機來源每次連線都視為全新 session：清掉序號基準、增益與轉寫累積
    if (source === "phone") {
      this.sync.reset();
      this.deps.agc.reset();
      this.deps.transcriber?.reset();
    }

    this.activeSource = chosen;
    this.currentKind = source;
    this.lastVuAt = 0;

    // 注入回呼後啟動來源（來源負責把原始音訊正規化成 AudioChunk）
    await chosen.start(
      (chunk) => this.onChunk(chunk),
      (err) => this.onError(err),
    );

    this.active = true;

    // 週期性 flush 轉寫器，把吐出的片段推給前端
    const flushSec = this.resolveFlushSec();
    this.flushTimer = setInterval(() => {
      void this.flushTranscriber();
    }, flushSec * 1000);

    // 發一次狀態事件，讓前端立即反映「已開始收音」
    this.emitStatus();
  }

  /**
   * 停止收音：清計時器、停來源、做收尾 flush（殘留片段也推出）、發狀態事件。
   * 可重複呼叫而安全（未在收音時為 no-op，但仍確保計時器被清）。
   */
  async stop(): Promise<void> {
    // 先清計時器，避免 stop 過程中又觸發 flush
    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    const source = this.activeSource;
    this.activeSource = null;

    if (source) {
      // 即使來源 stop 拋錯也要把引擎狀態歸位，故包在 try/finally
      try {
        await source.stop();
      } finally {
        // 收尾：把轉寫器裡殘留的最後片段 flush 出去
        await this.flushTranscriber();
      }
    }

    this.active = false;
    this.currentKind = null;
    this.lastVuAt = 0;
    this.emitStatus();
  }

  /** 目前引擎狀態快照（供 /audio/status 與前端輪詢）。 */
  status(): AudioEngineStatus {
    return {
      active: this.active,
      source: this.currentKind,
      phoneConnected: this.deps.phone.connected,
      sampleRate: TARGET_SAMPLE_RATE,
      gain: this.deps.agc.gain,
    };
  }

  /** 取得手機連線 session（QR / token / 網址）；會啟動 WSS 橋接伺服器。 */
  getPhoneSession(): Promise<PhoneSession> {
    return this.deps.phone.getSession();
  }

  // ─────────────── 內部：每塊音訊處理 ───────────────

  private onChunk(chunk: AudioChunk): void {
    // 手機來源才做序號去重 / 補位（系統混音是本機直取，無封包問題）
    if (this.currentKind === "phone") {
      const r = this.sync.accept(chunk);
      if (!r.accepted) {
        return; // 重複 / 亂序舊包：丟棄
      }
      // r.insertedSilence > 0 代表網路掉了幾幀。這裡選擇「不」回填靜音樣本給
      // 轉寫器：Whisper 以各 chunk 自帶的 timestampMs 對齊時間軸，缺口本身
      // 就是真實的靜默，補零反而可能讓轉寫器把靜音誤判成語句邊界。保留此值
      // 主要供同步器維持 lastSeq 推進與未來做時間軸補償之用。
    }

    // 平滑增益（回傳新陣列，不動原始 samples）
    const processed = this.deps.agc.process(chunk.samples);

    // VU：每塊都算，但節流推送（前端訊號條不需要超過 ~10fps）
    const now = Date.now();
    if (now - this.lastVuAt >= VU_THROTTLE_MS) {
      this.lastVuAt = now;
      const level = computeVu(processed);
      this.emit({ type: "vu", level, source: chunk.source });
    }

    // 餵給轉寫器：沿用原 chunk 的 seq/timestamp，但換成增益處理後的樣本
    this.deps.transcriber?.push({ ...chunk, samples: processed });
  }

  private onError(err: Error): void {
    this.emit({ type: "error", message: err.message });
  }

  // ─────────────── 內部：輔助 ───────────────

  /** flush 轉寫器並把片段以 transcript 事件推出（無片段則不發）。 */
  private async flushTranscriber(): Promise<void> {
    const t = this.deps.transcriber;
    if (!t) return;
    const segments = await t.flush();
    if (segments.length > 0) {
      // AudioEvent.transcript 只要 {start,end,text}，去掉可能的 speaker 等多餘欄位
      this.emit({
        type: "transcript",
        segments: segments.map((s) => ({ start: s.start, end: s.end, text: s.text })),
      });
    }
  }

  /** 決定 flush 週期（秒）：優先用轉寫器的 windowSec，否則退回預設 5 秒。 */
  private resolveFlushSec(): number {
    const t = this.deps.transcriber as TranscriberWithWindow | undefined;
    const w = t?.windowSec;
    return typeof w === "number" && w > 0 ? w : DEFAULT_FLUSH_SEC;
  }

  /** 推一次目前狀態事件。 */
  private emitStatus(): void {
    this.emit({ type: "status", status: this.status() });
  }

  /** 安全發事件：onEvent 不存在則靜默忽略。 */
  private emit(e: AudioEvent): void {
    this.deps.onEvent?.(e);
  }
}
