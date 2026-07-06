// ════════════════════════════════════════════════════════════════════
//  AudioIngestionRouter — 雙軌路由（四態狀態機 + 優先權管理 + 非同步鎖）
//
//  把三個統一音訊來源（皆實作 AudioSource）整合成一條可路由的輸入：
//
//    webrtc / local  →「前景即時串流」高優先（餵 Whisper、即時轉寫 + VU）
//    bluetooth       →「背景檔案同步」低優先（斷點續傳，不走即時管線）
//
//  前景即時源（webrtc 與 local）互斥：同一時刻只會有一個在跑；切換前一定先
//  停掉另一個。藍牙則可與前景源「並存」——但只要前景即時串流在跑，藍牙就被
//  降為 background 優先（setPriority("background")），讓它節流、不跟即時轉寫
//  搶 CPU/IO，確保「即時轉寫不掉幀」。沒有前景時藍牙才可升為 foreground、
//  自己當前景同步（BLUETOOTH_SYNCING）。
//
//  四態狀態機（AudioSourceState）：
//    無前景且藍牙未傳         → DISCONNECTED
//    前景 = webrtc            → WEBRTC_STREAMING
//    前景 = local             → LOCAL_RECORDING
//    無即時前景、但藍牙在同步  → BLUETOOTH_SYNCING
//
//  ─ 為何要 AsyncMutex ─
//  Node 是單執行緒，沒有 Rust 那種真正的資料競爭；但「非同步區段」之間會交錯
//  （await 之間其他 callback 會插隊）。activate/deactivate/syncBluetooth 都含
//  await（startStream/stopStream），若兩個切換交錯執行，會造成「目前前景源指標」
//  被雙寫、狀態機錯亂（如 local 還沒停乾淨 webrtc 就接上）。因此所有狀態轉換與
//  對「前景源指標」的讀寫一律用 this.lock.runExclusive(...) 序列化——等同把規格
//  要求的 Arc<Mutex<...>> 語意對應到 TS runtime。音訊資料回呼（onDataReceived）
//  本身不進鎖（高頻、不可阻塞），但它只讀取在轉換時設妥的不可變參照，不改狀態機。
// ════════════════════════════════════════════════════════════════════

import type {
  AudioChunk,
  AudioEvent,
  AudioSource,
  AudioSourceId,
  BluetoothTransferStatus,
  RouterStatus,
  TranscriberLike,
  WebRtcStatus,
} from "./types";
import { AudioSourceState, TARGET_SAMPLE_RATE } from "./types";
import type { Agc } from "./Agc";
import { AudioSync } from "./AudioSync";
import { computeVu } from "./VuMeter";
import { AsyncMutex } from "./AsyncMutex";
import { encodeWavPcm16 } from "./WavEncoder";

/** VU 事件節流間隔（毫秒）：每塊都算 VU，但最多每 100ms 推一次給前端訊號條。 */
const VU_THROTTLE_MS = 100;

/**
 * 收音「整檔精修」緩衝上限（秒）。前景 session 期間累積 AGC 後的 PCM，停止後可編成
 * WAV 交 Gemini 整檔精修。大檔已改走 Gemini Files API 上傳（見 GeminiLlmService.transcribeAudio），
 * 不再受 inline ~20MB 請求上限約束；此上限主要保護記憶體與上傳/轉錄耗時。
 * 超過上限就停止累積，recording 事件帶 truncated=true 提醒前端「只精修前 N 分鐘」。
 * 注意：Float32 緩衝約 64KB/秒，3600 秒 ≈ 230MB；要再加長需評估記憶體與上傳時間。
 */
const MAX_RECORD_SECONDS = 3600; // 60 分鐘（硬上限；設了 onSegmentReady 會在此之前自動分段，不會走到截斷）
const MAX_RECORD_SAMPLES = MAX_RECORD_SECONDS * TARGET_SAMPLE_RATE;

// 自動分段門檻（秒）預設：錄到這個長度就「背景抽取」——drain 目前緩衝交整檔精修、緩衝清空繼續收音，
// 使用者不必自己停。留 15 分安全邊際在 60 分硬上限前，且每段精修量適中（不過久/不易撞限流）。可由 deps 覆寫。
const AUTO_SEGMENT_SECONDS = 2700; // 45 分鐘

/**
 * 前景即時源 flush 轉寫器的週期上限（秒）。
 * 規格要求 WebRTC「每 1–2 秒餵 Whisper」→ 取 2 秒上限；若轉寫器 windowSec 更小
 * 則以較小者為準（更頻繁 flush，逐字稿延遲更低）。
 */
const FLUSH_MAX_SEC = 2;

/**
 * 來源可選地暴露自己的子狀態（AudioSource 契約未強制要求 status()）。
 * 若實作有提供就取，否則 router 給合理預設。
 */
type WithBtStatus = AudioSource & { status?: () => BluetoothTransferStatus };
type WithWebRtcStatus = AudioSource & { status?: () => WebRtcStatus };

export interface AudioRouterDeps {
  bluetooth: AudioSource;
  webrtc: AudioSource;
  local: AudioSource;
  /** 只麥克風來源（面對面會議）；與 local/webrtc 同為前景即時源、三者互斥。 */
  mic: AudioSource;
  agc: Agc;
  transcriber?: TranscriberLike;
  onEvent?: (e: AudioEvent) => void;
  /** 自動分段門檻（秒）；預設 AUTO_SEGMENT_SECONDS。測試可調小以觸發。 */
  autoSegmentSeconds?: number;
}

export class AudioIngestionRouter {
  private readonly deps: AudioRouterDeps;

  /** webrtc 源用的序號去重 / 補位器（webrtc 走網路，可能丟包/亂序）。 */
  private readonly sync = new AudioSync();

  /** 序列化所有狀態轉換與前景源指標讀寫的鎖（對應規格的 Arc<Mutex>）。 */
  private readonly lock = new AsyncMutex();

  // ── 受鎖保護的狀態 ──

  /** 目前前景即時源 id（webrtc / local）；null = 無前景即時串流。 */
  private foregroundId: AudioSourceId | null = null;
  /** 目前前景即時源物件（deactivate 時要對它 stopStream）。 */
  private foregroundSource: AudioSource | null = null;
  /** 藍牙是否正在背景/前景同步檔案。 */
  private bluetoothTransferring = false;

  // ── 不受鎖保護（僅資料回呼讀寫，皆為節流/累積用，非狀態機）──

  /** 前景源 flush 轉寫器的計時器。 */
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  /** 上次推送 VU 事件的時間戳（節流用）。 */
  private lastVuAt = 0;

  /** 前景 session 累積的（AGC 後）PCM，停止後可編 WAV 做整檔精修。 */
  private recordedChunks: Float32Array[] = [];
  private recordedSamples = 0;
  /** 是否因超過上限而截斷錄音（前端可據以提醒「只精修前 N 分鐘」）。 */
  private recordingTruncated = false;
  /** 本 session 已被「自動分段」抽走並精修的累計秒數（給後續段/最終段時間戳位移，接續不從 00:00 重來）。 */
  private drainedSeconds = 0;
  /** 已觸發自動分段、等待 drain 中（防重複觸發）。 */
  private segmentPending = false;
  /**
   * 自動分段回呼（由 server 設定）：錄音累積達門檻時觸發。
   * server 應在此**同步** drainRecordingWav() 取走該段，再背景精修＋broadcast，收音期間不中斷。
   */
  onSegmentReady?: () => void;
  /** 自動分段門檻（樣本數）；由 deps.autoSegmentSeconds 覆寫，預設 AUTO_SEGMENT_SECONDS。 */
  private readonly autoSegmentSamples: number;

  /** 每個來源是否已綁定 onDataReceived/onError（避免重複註冊）。 */
  private readonly wiredSources = new WeakSet<AudioSource>();

  constructor(deps: AudioRouterDeps) {
    this.deps = deps;
    this.autoSegmentSamples = Math.max(
      1,
      Math.round((deps.autoSegmentSeconds ?? AUTO_SEGMENT_SECONDS) * TARGET_SAMPLE_RATE),
    );
    // 一次性綁定三個源的資料/錯誤回呼。回呼內部會以 foregroundId 判斷該塊是否
    // 屬於目前前景源——避免在每次 activate/deactivate 重新註冊造成回呼疊加。
    this.wire(deps.webrtc);
    this.wire(deps.local);
    this.wire(deps.mic);
    this.wire(deps.bluetooth);
  }

  /**
   * 啟用某來源為「前景」。
   * - webrtc / local：前景即時串流（互斥；會先停掉另一個即時源）。
   * - bluetooth：背景檔案同步（不搶前景即時資源；若有前景即時源在跑則降為
   *   background 優先，狀態維持前景的 WEBRTC_STREAMING/LOCAL_RECORDING）。
   */
  activate(id: AudioSourceId): Promise<void> {
    return this.lock.runExclusive(async () => {
      if (id === "bluetooth") {
        await this.startBluetoothLocked();
        return;
      }
      await this.activateRealtimeLocked(id);
    });
  }

  /**
   * 停止前景即時來源。
   * 藍牙背景同步（若正在跑）不受影響——停掉前景後，若藍牙仍在傳，狀態回到
   * BLUETOOTH_SYNCING 並把藍牙升回 foreground 優先；否則回 DISCONNECTED。
   */
  deactivate(): Promise<void> {
    return this.lock.runExclusive(async () => {
      await this.stopForegroundLocked();
      // 前景已停：若藍牙還在背景傳，讓它升為前景同步（獨佔資源、可全速）。
      if (this.bluetoothTransferring) {
        this.deps.bluetooth.setPriority("foreground");
      }
      this.emitRouter();
      this.emitRecording(); // 通知前端這段收音是否可精修帶入會議（ready + 秒數）
    });
  }

  /**
   * 觸發一次藍牙背景同步。
   * 與 activate("bluetooth") 等價（共用同一條受鎖路徑），語意上強調「不搶前景
   * 即時串流資源」：有前景即時源在跑時藍牙固定為 background 優先。
   */
  syncBluetooth(): Promise<void> {
    return this.lock.runExclusive(async () => {
      await this.startBluetoothLocked();
    });
  }

  /** 組目前整體狀態快照（供 /router/status 與前端 /events 推播）。 */
  status(): RouterStatus {
    return {
      state: this.computeState(),
      activeSourceId: this.foregroundId,
      bluetooth: this.bluetoothStatus(),
      webrtc: this.webrtcStatus(),
      gain: this.deps.agc.gain,
    };
  }

  // ════════════════ 受鎖臨界區（名稱以 Locked 結尾）════════════════

  /**
   * 啟用一個前景即時源（webrtc / local）。互斥：先停掉「另一個」即時源，
   * 再起目標源。藍牙背景同步不動，但若藍牙在跑，確保它維持 background 優先
   * （前景即時串流不能被檔案傳輸搶資源）。
   */
  private async activateRealtimeLocked(id: AudioSourceId): Promise<void> {
    const target =
      id === "webrtc" ? this.deps.webrtc : id === "mic" ? this.deps.mic : this.deps.local;

    // 已是同一個前景源在跑：視為冪等，僅重發狀態。
    if (this.foregroundId === id && this.foregroundSource === target) {
      this.emitRouter();
      return;
    }

    // 互斥：停掉目前在跑的「另一個」即時前景源（webrtc 與 local 不可並存）。
    await this.stopForegroundLocked();

    // 換源視為新 session：清掉序號基準與增益，避免沿用上個源的狀態。
    this.sync.reset();
    this.deps.agc.reset();
    this.deps.transcriber?.reset();
    this.lastVuAt = 0;
    this.resetRecording(); // 新 session 重開精修錄音緩衝
    this.drainedSeconds = 0; // 新 session 時間戳位移歸零（自動分段接續才不會延續上一場）
    this.segmentPending = false;
    this.emitRecording(); // 通知前端：尚無可精修的錄音（ready=false）

    // 設妥前景指標「之後」才 startStream——資料回呼一旦觸發就能正確認領該塊。
    this.foregroundId = id;
    this.foregroundSource = target;

    try {
      await target.startStream();
    } catch (err) {
      // 起串流失敗：回滾前景指標，狀態不留下「半啟用」的髒值。
      this.foregroundId = null;
      this.foregroundSource = null;
      this.emitError(err);
      this.emitRouter();
      return;
    }

    // 前景即時串流既已就緒：若藍牙在背景傳，壓成 background 優先，保護即時轉寫。
    if (this.bluetoothTransferring) {
      this.deps.bluetooth.setPriority("background");
    }

    // 起週期 flush：把 Whisper 吐出的片段以 transcript 事件推給前端。
    this.startFlushTimer();
    this.emitRouter();
  }

  /**
   * 啟用 / 觸發藍牙同步。
   * 優先權核心：
   *   - 有前景即時源在跑 → 藍牙為 background（背景傳，狀態維持前景態），
   *     status().bluetooth.transferring = true。
   *   - 無前景即時源     → 藍牙為 foreground，狀態 = BLUETOOTH_SYNCING。
   * 不論何者，startStream 藍牙源（可重複呼叫安全）。
   */
  private async startBluetoothLocked(): Promise<void> {
    const hasForeground = this.foregroundId !== null;
    // 依「是否有前景即時串流」決定優先級——這是「藍牙傳輸不讓即時轉寫掉幀」的關鍵。
    this.deps.bluetooth.setPriority(hasForeground ? "background" : "foreground");

    try {
      await this.deps.bluetooth.startStream();
    } catch (err) {
      // 藍牙起傳失敗不該炸掉 router，也不該影響前景即時串流。
      this.emitError(err);
      this.emitRouter();
      return;
    }

    this.bluetoothTransferring = true;
    // 反映進度給前端（細項進度由 status().bluetooth 帶出；此處先發一次起傳事件）。
    this.emitTransfer(false);
    this.emitRouter();
  }

  /**
   * 停掉目前前景即時源（若有）。清 flush 計時器、停來源、收尾 flush 殘留片段。
   * 即使來源 stopStream 拋錯也把前景指標歸位，避免卡在「停不掉」的髒狀態。
   * 注意：本方法只動前景即時源，不碰藍牙背景同步。
   */
  private async stopForegroundLocked(): Promise<void> {
    this.clearFlushTimer();

    const source = this.foregroundSource;
    this.foregroundSource = null;
    this.foregroundId = null;

    if (!source) {
      return; // 本就無前景即時源：no-op（藍牙態與 DISCONNECTED 由 computeState 決定）。
    }

    try {
      await source.stopStream();
    } catch (err) {
      // 停源失敗只記事件，狀態已歸位，不再 rethrow（避免讓單一源錯誤炸掉切換）。
      this.emitError(err);
    } finally {
      // 收尾：把轉寫器裡殘留的最後片段 flush 出去（不漏尾句）。
      await this.flushTranscriber();
    }
  }

  // ════════════════ 音訊資料回呼（高頻、不進鎖）════════════════

  /** 一次性綁定某源的 onDataReceived / onError。 */
  private wire(source: AudioSource): void {
    if (this.wiredSources.has(source)) return;
    this.wiredSources.add(source);
    source.onDataReceived((chunk) => this.onData(source, chunk));
    source.onError((err) => this.emitError(err));
  }

  /**
   * 收到某源的音訊塊。
   * - 只有「目前前景即時源」送來的塊才走即時管線（AGC → VU → 轉寫）。
   *   非前景或藍牙（背景檔案同步）送來的塊在此忽略——藍牙不走即時管線，
   *   但仍綁了回呼以「容錯接住」其偶發發塊，不讓它影響即時源。
   * - webrtc 前景源先過 AudioSync 去重 / 補位；不接受（重複/亂序）就丟。
   */
  private onData(source: AudioSource, chunk: AudioChunk): void {
    // 認領：非當前前景源的塊一律不進即時管線（含藍牙背景同步塊）。
    if (source !== this.foregroundSource || this.foregroundId === null) {
      return;
    }

    // webrtc 走網路：序號去重 / 補位（local 為本機直取，無封包問題）。
    if (this.foregroundId === "webrtc") {
      const r = this.sync.accept(chunk);
      if (!r.accepted) {
        return; // 重複 / 亂序舊包：丟棄，保護即時轉寫不被汙染。
      }
      // r.insertedSilence 僅供同步器推進 lastSeq；此處不回填靜音給轉寫器——
      // 缺口本身就是真實靜默，補零反而可能讓 Whisper 誤判語句邊界。
    }

    // 平滑增益（回傳新陣列，不動原始 samples）。
    const processed = this.deps.agc.process(chunk.samples);

    // VU：每塊都算，但節流推送（前端訊號條 ~10fps 足矣）。以 AudioSourceId 標示來源。
    const now = Date.now();
    if (now - this.lastVuAt >= VU_THROTTLE_MS) {
      this.lastVuAt = now;
      const level = computeVu(processed);
      this.emit({ type: "vu", level, source: this.foregroundId });
    }

    // 餵轉寫器：沿用原 chunk 的 seq/timestamp，但換成增益處理後的樣本。
    this.deps.transcriber?.push({ ...chunk, samples: processed });

    // 累積整檔錄音（停止後可編 WAV 交 Gemini 整檔精修，補足即時粗稿的不足）。
    this.appendRecording(processed);
  }

  // ════════════════ 整檔精修錄音緩衝 ════════════════

  /** 是否有可精修的錄音（前景 session 累積到的 PCM）。 */
  hasRecording(): boolean {
    return this.recordedSamples > 0;
  }

  /**
   * 把累積錄音編成 WAV（16kHz mono），**不清空緩衝**；無錄音回 null。
   * 不清空是刻意的：精修（送 Gemini）可能失敗（限流/斷網），保留緩衝才能重試，
   * 不讓使用者整段收音因一次 API 失敗而白收。成功後由呼叫端 clearRecording()。
   */
  peekRecordingWav(): Buffer | null {
    if (this.recordedSamples === 0) return null;
    const merged = new Float32Array(this.recordedSamples);
    let off = 0;
    for (const c of this.recordedChunks) {
      merged.set(c, off);
      off += c.length;
    }
    return encodeWavPcm16(merged, TARGET_SAMPLE_RATE);
  }

  /** 清空錄音緩衝並通知前端（精修成功後呼叫）。 */
  clearRecording(): void {
    this.resetRecording();
    this.emitRecording();
  }

  /**
   * 自動分段用：取走目前累積錄音（編 WAV）**並清空緩衝**（新音訊流入乾淨緩衝繼續錄），
   * 回這段的時間戳位移（秒，＝先前已抽走的累計）。無錄音回 null。與 peek 不同，peek 不清空。
   */
  drainRecordingWav(): { wav: Buffer; offsetSec: number } | null {
    this.segmentPending = false;
    if (this.recordedSamples === 0) return null;
    const merged = new Float32Array(this.recordedSamples);
    let off = 0;
    for (const c of this.recordedChunks) {
      merged.set(c, off);
      off += c.length;
    }
    const offsetSec = this.drainedSeconds;
    this.drainedSeconds += this.recordedSamples / TARGET_SAMPLE_RATE;
    this.resetRecording();
    this.emitRecording(); // 通知前端本段已抽走、緩衝歸零
    return { wav: encodeWavPcm16(merged, TARGET_SAMPLE_RATE), offsetSec };
  }

  /** 本 session 已被自動分段抽走的累計秒數（最終段精修時位移時間戳，接續分段）。 */
  get recordingOffsetSeconds(): number {
    return this.drainedSeconds;
  }

  /** 累積一塊（AGC 後）PCM；達自動分段門檻就通知 server 背景抽取；超過硬上限才截斷。 */
  private appendRecording(samples: Float32Array): void {
    if (this.recordedSamples >= MAX_RECORD_SAMPLES) {
      this.recordingTruncated = true;
      return;
    }
    this.recordedChunks.push(samples);
    this.recordedSamples += samples.length;
    // 達門檻 → 通知 server 背景抽取這段（收音不中斷）。設了 onSegmentReady 就不會走到 60 分截斷。
    if (!this.segmentPending && this.onSegmentReady && this.recordedSamples >= this.autoSegmentSamples) {
      this.segmentPending = true;
      this.onSegmentReady();
    }
  }

  /** 清空錄音緩衝（新 session 或取走後）。 */
  private resetRecording(): void {
    this.recordedChunks = [];
    this.recordedSamples = 0;
    this.recordingTruncated = false;
  }

  /** 推一次「錄音可精修狀態」事件（ready / 秒數 / 是否截斷）給前端。 */
  private emitRecording(): void {
    this.emit({
      type: "recording",
      ready: this.hasRecording(),
      seconds: Math.round(this.recordedSamples / TARGET_SAMPLE_RATE),
      truncated: this.recordingTruncated,
    });
  }

  // ════════════════ 轉寫 flush ════════════════

  /** 起週期性 flush 計時器（先清舊的，避免疊加）。 */
  private startFlushTimer(): void {
    this.clearFlushTimer();
    const flushSec = this.resolveFlushSec();
    this.flushTimer = setInterval(() => {
      void this.flushTranscriber();
    }, flushSec * 1000);
  }

  /** 清掉 flush 計時器（若有）。 */
  private clearFlushTimer(): void {
    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /** flush 轉寫器並把片段以 transcript 事件推出（無片段則不發）。容錯：吞錯不外拋。 */
  private async flushTranscriber(): Promise<void> {
    const t = this.deps.transcriber;
    if (!t) return;
    try {
      const segments = await t.flush();
      if (segments.length > 0) {
        // transcript 事件只要 {start,end,text}，去掉可能的 speaker 等多餘欄位。
        this.emit({
          type: "transcript",
          segments: segments.map((s) => ({ start: s.start, end: s.end, text: s.text })),
        });
      }
    } catch (err) {
      // 轉寫只是加值；單次 flush 失敗不該中斷收音流程。
      this.emitError(err);
    }
  }

  /**
   * 決定 flush 週期（秒）：規格要求 WebRTC 每 1–2 秒餵 Whisper，故取 2 秒上限；
   * 若轉寫器 windowSec 更小（更頻繁）則以它為準。
   */
  private resolveFlushSec(): number {
    const w = this.deps.transcriber?.windowSec;
    if (typeof w === "number" && w > 0) {
      return Math.min(w, FLUSH_MAX_SEC);
    }
    return FLUSH_MAX_SEC;
  }

  // ════════════════ 狀態組裝 ════════════════

  /** 由「前景指標 + 藍牙傳輸旗標」推導四態狀態機。 */
  private computeState(): AudioSourceState {
    if (this.foregroundId === "webrtc") return AudioSourceState.WEBRTC_STREAMING;
    if (this.foregroundId === "local") return AudioSourceState.LOCAL_RECORDING;
    if (this.foregroundId === "mic") return AudioSourceState.MIC_RECORDING;
    // 無即時前景：藍牙在傳 → BLUETOOTH_SYNCING；否則 DISCONNECTED。
    if (this.bluetoothTransferring) return AudioSourceState.BLUETOOTH_SYNCING;
    return AudioSourceState.DISCONNECTED;
  }

  /**
   * 藍牙子狀態：源若提供 status() 就取（保留它回報的 progress/bytes 等細項），
   * 否則給 router 視角的合理預設。transferring/priority 一律以 router 的權威狀態
   * 覆寫，確保與四態機一致（不被源的回報蓋掉優先權決策）。
   */
  private bluetoothStatus(): BluetoothTransferStatus {
    const bt = this.deps.bluetooth as WithBtStatus;
    const priority = this.foregroundId !== null ? "background" : "foreground";
    const base: BluetoothTransferStatus =
      typeof bt.status === "function"
        ? bt.status()
        : {
            connected: this.deps.bluetooth.streaming,
            transferring: this.bluetoothTransferring,
            progress: 0,
            priority,
            receivedBytes: 0,
            totalBytes: null,
          };
    // router 對 transferring / priority 有最終話語權（四態機與優先權核心）。
    return {
      ...base,
      transferring: this.bluetoothTransferring,
      priority,
    };
  }

  /** WebRTC 子狀態：源若提供 status() 就取，否則給合理預設。 */
  private webrtcStatus(): WebRtcStatus {
    const wr = this.deps.webrtc as WithWebRtcStatus;
    if (typeof wr.status === "function") {
      return wr.status();
    }
    return {
      connected: this.foregroundId === "webrtc" && this.deps.webrtc.streaming,
      reorderQueueDepth: 0,
      droppedPackets: 0,
    };
  }

  // ════════════════ 事件發送（皆安全：onEvent 不存在則靜默）════════════════

  /** 每次狀態變化推一次整體 router 狀態。 */
  private emitRouter(): void {
    this.emit({ type: "router", status: this.status() });
  }

  /** 推一次藍牙傳輸進度事件。 */
  private emitTransfer(done: boolean): void {
    const bt = this.bluetoothStatus();
    this.emit({ type: "transfer", sourceId: "bluetooth", progress: bt.progress, done });
  }

  /** 把任一源/管線的錯誤轉成 error 事件；絕不外拋，單一源錯誤不炸掉 router。 */
  private emitError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.emit({ type: "error", message });
  }

  /** 安全發事件：onEvent 不存在則靜默忽略。 */
  private emit(e: AudioEvent): void {
    this.deps.onEvent?.(e);
  }
}
