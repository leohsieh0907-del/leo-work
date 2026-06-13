// ════════════════════════════════════════════════════════════════════
//  AudioSync — 重連不錯位的序號對齊器
//
//  手機透過 WSS 傳音訊，網路可能丟封包、重送、亂序。本類別以 chunk.seq
//  （session 內單調遞增）為唯一依據做兩件事：
//    1) 去重 / 丟舊：seq <= lastSeq 的封包是重送或亂序的舊包 → 丟棄。
//    2) 補位對齊：中間掉了 N 幀（seq 跳號），回報應補入的靜音樣本數，
//       讓時間軸不會因為缺口而整段往前縮（否則逐字稿時間戳會錯位）。
//
//  純邏輯、無 I/O、可單元測試。實際要不要把靜音塞進管線由協調器決定。
// ════════════════════════════════════════════════════════════════════

import type { AudioChunk, SyncResult } from "./types";

export class AudioSync {
  /** 最後一個被接受的 seq；-1 代表尚未收到任何塊。 */
  private _lastSeq = -1;

  /**
   * 依 seq 判斷是否接受此塊，並算出為對齊需補的靜音樣本數。
   *
   * - 第一塊（lastSeq===-1）：接受，記下 seq，補 0。
   * - seq <= lastSeq：重複 / 亂序舊包 → 丟棄（accepted:false，補 0）。
   * - seq === lastSeq+1：正常下一幀 → 接受，補 0。
   * - seq > lastSeq+1：中間掉了 missing = seq-lastSeq-1 幀 →
   *     用「本塊長度」估算每幀樣本數，insertedSilence = missing * 本塊長度，
   *     接受並把 lastSeq 推進到 seq（不因缺口卡住後續封包）。
   */
  accept(chunk: AudioChunk): SyncResult {
    const seq = chunk.seq;

    // 第一塊：建立基準
    if (this._lastSeq === -1) {
      this._lastSeq = seq;
      return { accepted: true, insertedSilence: 0 };
    }

    // 重複或亂序的舊包：丟棄
    if (seq <= this._lastSeq) {
      return { accepted: false, insertedSilence: 0 };
    }

    // 正常的下一幀
    if (seq === this._lastSeq + 1) {
      this._lastSeq = seq;
      return { accepted: true, insertedSilence: 0 };
    }

    // 跳號：中間有缺口，用本塊長度估算每幀樣本數來補靜音
    const missing = seq - this._lastSeq - 1;
    const insertedSilence = missing * chunk.samples.length;
    this._lastSeq = seq;
    return { accepted: true, insertedSilence };
  }

  /** 重置回初始狀態（換 session / 重連時呼叫）。 */
  reset(): void {
    this._lastSeq = -1;
  }

  /** 最後接受的 seq（-1 = 尚未收到）。 */
  get lastSeq(): number {
    return this._lastSeq;
  }
}
