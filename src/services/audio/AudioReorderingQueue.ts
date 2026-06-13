// ════════════════════════════════════════════════════════════════════
//  AudioReorderingQueue — RTP 封包重組佇列（純邏輯、可單元測試）
//
//  WebRTC over UDP 不保證封包順序，也可能重複/遺失。此佇列依「序號」
//  (RTP sequenceNumber) 重新排序，把亂序到達的封包緩衝起來，等缺口補齊後
//  才「依序」往下游釋放，確保 Opus 解碼器拿到的是連續、單調遞增的封包流。
//
//  設計要點（deterministic，好測）：
//    - 第一個 push 的 seq 當成基準 nextSeq；之後永遠從 nextSeq 連續釋放。
//    - seq < nextSeq → 遲到/重複封包，直接丟棄並計數（dropped++）。
//    - 否則放進以 seq 為鍵的緩衝；接著盡可能從 nextSeq 連續吐出。
//    - 緩衝深度超過 maxDepth → 代表前面缺了一個遲遲不來的封包，為了不無限
//      等待而卡死即時串流，強制把「目前緩衝中最小序號」當作新的 nextSeq
//      釋放（跳過中間的缺口），被跳過的封包數一律計入 dropped。
//
//  本佇列對 item 型別無假設（泛型 T），故與 RTP/Opus 細節完全解耦，
//  WebRtcSoftwareSource 用它裝 RtpPacket，測試則可裝任意標記值。
// ════════════════════════════════════════════════════════════════════

export interface ReorderQueueOptions {
  /** 緩衝最大封包數，超過就強制釋放最小序號（跳過缺口避免無限等待），預設 32 */
  maxDepth?: number;
}

/** maxDepth 預設值：約對應數百毫秒的 Opus 封包（每包 20ms），足以吸收抖動。 */
const DEFAULT_MAX_DEPTH = 32;

export class AudioReorderingQueue<T> {
  /** 緩衝：序號 → 封包。用 Map 保留插入彈性，釋放時自行找最小鍵。 */
  private readonly buffer = new Map<number, T>();
  /** 下一個「該釋放」的序號；首個 push 時以該封包 seq 初始化。 */
  private nextSeq: number | null = null;
  /** 累計丟棄（遲到/重複 + 強制跳過缺口）的封包數。 */
  private droppedCount = 0;
  private readonly maxDepth: number;

  constructor(opts: ReorderQueueOptions = {}) {
    // maxDepth 必須 ≥ 1，否則無法緩衝任何亂序封包；非法值退回預設。
    const d = opts.maxDepth;
    this.maxDepth = typeof d === "number" && d >= 1 ? Math.floor(d) : DEFAULT_MAX_DEPTH;
  }

  /**
   * 放入序號 seq 的封包；回傳「此刻可依序釋放」的封包陣列（可能 0..N 個）。
   *
   * 流程：
   *   1. 首包：以其 seq 設定 nextSeq 基準。
   *   2. seq < nextSeq：遲到/重複 → 丟棄、dropped++、回傳空陣列。
   *   3. 重複佔用同一個 seq（已在緩衝且尚未釋放）：視為重複 → 丟棄。
   *   4. 入緩衝，從 nextSeq 連續釋放。
   *   5. 若緩衝仍超過 maxDepth，強制跳過缺口（把最小序號當 nextSeq）再釋放。
   */
  push(seq: number, item: T): T[] {
    // 防呆：seq 必須是有限整數，否則無從排序，當作非法輸入丟棄。
    if (!Number.isFinite(seq)) {
      this.droppedCount++;
      return [];
    }
    const s = Math.floor(seq);

    // 首包：建立基準。
    if (this.nextSeq === null) {
      this.nextSeq = s;
    }

    // 遲到/重複（序號已經過了釋放點）：丟棄。
    if (s < this.nextSeq) {
      this.droppedCount++;
      return [];
    }

    // 同序號重複到達（已在緩衝中、尚未釋放）：丟棄，避免覆蓋先到的。
    if (this.buffer.has(s)) {
      this.droppedCount++;
      return [];
    }

    this.buffer.set(s, item);

    const released: T[] = [];

    // 先盡可能從 nextSeq 連續釋放。
    this.drainContiguous(released);

    // 緩衝過深代表前面有個缺口遲遲不來：強制跳過以免卡死即時串流。
    // 每跳一次都把「當前最小序號」設為 nextSeq，被跳過的序號計入 dropped，
    // 然後再連續釋放；重複到緩衝深度回到 maxDepth 以內。
    while (this.buffer.size > this.maxDepth) {
      const minSeq = this.minBufferedSeq();
      // minSeq 理論上必存在（size>maxDepth≥1），保險起見仍判斷。
      if (minSeq === null) break;
      // 從現在的 nextSeq 跳到 minSeq，中間的缺口全部算丟棄。
      if (this.nextSeq !== null && minSeq > this.nextSeq) {
        this.droppedCount += minSeq - this.nextSeq;
      }
      this.nextSeq = minSeq;
      this.drainContiguous(released);
    }

    return released;
  }

  /** 停止時把剩餘緩衝依序全部吐出（不再等待任何缺口）。 */
  flush(): T[] {
    const out: T[] = [];
    // 依序號由小到大全部吐出；缺口直接略過（不計 dropped，因為是正常收尾）。
    const seqs = Array.from(this.buffer.keys()).sort((a, b) => a - b);
    for (const s of seqs) {
      out.push(this.buffer.get(s) as T);
    }
    this.buffer.clear();
    // 收尾後把基準推進到最後一個序號之後，避免 flush 後又 push 舊包誤收。
    if (seqs.length > 0) {
      this.nextSeq = seqs[seqs.length - 1] + 1;
    }
    return out;
  }

  /** 目前緩衝深度（尚未釋放的封包數）。 */
  get depth(): number {
    return this.buffer.size;
  }

  /** 累計丟棄（遲到/重複/被強制跳過）數。 */
  get dropped(): number {
    return this.droppedCount;
  }

  /** 全部歸零，回到「尚未收到首包」的初始狀態。 */
  reset(): void {
    this.buffer.clear();
    this.nextSeq = null;
    this.droppedCount = 0;
  }

  // ─────────────── 內部 ───────────────

  /** 從 nextSeq 起，把緩衝中連續存在的封包逐一吐到 released，並推進 nextSeq。 */
  private drainContiguous(released: T[]): void {
    if (this.nextSeq === null) return;
    while (this.buffer.has(this.nextSeq)) {
      released.push(this.buffer.get(this.nextSeq) as T);
      this.buffer.delete(this.nextSeq);
      this.nextSeq++;
    }
  }

  /** 找出目前緩衝中最小的序號；空緩衝回 null。 */
  private minBufferedSeq(): number | null {
    let min: number | null = null;
    for (const s of this.buffer.keys()) {
      if (min === null || s < min) min = s;
    }
    return min;
  }
}
