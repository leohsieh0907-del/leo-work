// ════════════════════════════════════════════════════════════════════
//  ResumableTransfer — 斷點續傳核心（與裝置 / 傳輸層解耦，可單元測試）
//
//  目標：透過注入的 BleTransport 收一個檔案，處理「亂序 / 重複 / 斷線續傳」，
//  最後回傳重組好的完整 Buffer。完全不認 noble，也不認 PM01-9 的私有 GATT
//  協定——那是 NobleBleTransport 的整合點。本模組只在 BleTransport 之上，
//  跑我們自定的 framing。
//
//  ── 自定 framing（收方與裝置雙向；本檔同時提供「解析」與測試用「組裝」helper）──
//    資料塊（裝置→收方）：[uint8 type=0x01][uint32 LE chunkIndex][payload bytes]
//    RESUME（收方→裝置）：[uint8 type=0x02][uint32 LE fromChunkIndex]   請求自某塊續傳
//    ACK   （收方→裝置）：[uint8 type=0x03][uint32 LE upToChunkIndex]   已連續收到某塊（節流回報）
//
//  ⚠️ 裝置端如何回應 RESUME / ACK 為 PM01-9 私有協定；本模組假設一個合理語意：
//     裝置收到 RESUME(n) 後從第 n 塊起依序重送尚未送達的塊。實際封包格式需原廠
//     文件對接（在 NobleBleTransport / 裝置韌體側），本層不變。
//
//  ── receiveFile 邏輯 ──
//    依 manifest.totalBytes / chunkSize 算總塊數；用 Set 記已收塊；收到塊→寫進
//    對應 offset、標記、必要時送 ACK、回報 progress；重複塊忽略；亂序塊放對位置；
//    湊齊所有塊→組 Buffer 回傳。
//
//  ── 斷線續傳 ──
//    監看 transport.connected。斷線時 receiveFile 不炸，等 connect() 重連後送
//    RESUME(第一個未收到的塊) 要求裝置從缺口續傳。逾時（預設 30s 無任何進展）
//    才拋 AppError(IO_ERROR,"傳輸逾時")。
//
//  ── 節流 ──
//    throttleMs > 0 時，每處理完一塊 await delay，讓背景傳輸不搶前景（WebRTC 即時
//    串流）的 CPU / IO；可由 setThrottle 動態調整（優先級切換用）。
// ════════════════════════════════════════════════════════════════════

import { AppError, ErrorCode } from "../../shared/types";
import type { BleTransport, TransferManifest, TransferResult } from "./types";

// ─────────────── framing 常數 ───────────────

/** frame 類型：資料塊（裝置→收方）。 */
export const FRAME_DATA = 0x01;
/** frame 類型：RESUME（收方→裝置，請求自某塊續傳）。 */
export const FRAME_RESUME = 0x02;
/** frame 類型：ACK（收方→裝置，已連續收到至某塊）。 */
export const FRAME_ACK = 0x03;

/** 資料塊 / 控制 frame 的固定表頭長度：1(type) + 4(uint32 index)。 */
export const FRAME_HEADER_LEN = 5;

export interface ResumableTransferOptions {
  /** 每收到幾塊送一次 ack（節流），預設 8 */
  ackEvery?: number;
  /** 背景低優先時，塊之間插入的延遲毫秒（節流讓出資源），預設 0 */
  throttleMs?: number;
  /**
   * 無任何進展（沒收到新塊、也沒重連成功）多久即視為逾時（毫秒），預設 30000。
   * 規格要求逾時才拋 IO_ERROR；其餘斷線一律靜默等待重連續傳。
   */
  stallTimeoutMs?: number;
  onProgress?: (received: number, total: number) => void;
}

/** 解析後的資料塊 frame。 */
interface ParsedDataFrame {
  chunkIndex: number;
  payload: Buffer;
}

// ─────────────── framing helper（解析 + 組裝；組裝供測試與續傳指令共用）───────────────

/** 組裝資料塊 frame：[0x01][uint32 LE chunkIndex][payload]。 */
export function encodeDataFrame(chunkIndex: number, payload: Buffer | Uint8Array): Buffer {
  const head = Buffer.allocUnsafe(FRAME_HEADER_LEN);
  head.writeUInt8(FRAME_DATA, 0);
  head.writeUInt32LE(chunkIndex >>> 0, 1);
  return Buffer.concat([head, Buffer.from(payload)]);
}

/** 組裝 RESUME frame：[0x02][uint32 LE fromChunkIndex]。 */
export function encodeResumeFrame(fromChunkIndex: number): Buffer {
  const buf = Buffer.allocUnsafe(FRAME_HEADER_LEN);
  buf.writeUInt8(FRAME_RESUME, 0);
  buf.writeUInt32LE(fromChunkIndex >>> 0, 1);
  return buf;
}

/** 組裝 ACK frame：[0x03][uint32 LE upToChunkIndex]。 */
export function encodeAckFrame(upToChunkIndex: number): Buffer {
  const buf = Buffer.allocUnsafe(FRAME_HEADER_LEN);
  buf.writeUInt8(FRAME_ACK, 0);
  buf.writeUInt32LE(upToChunkIndex >>> 0, 1);
  return buf;
}

/**
 * 解析一個資料塊 frame。非 0x01 類型、或長度不足表頭 → 回 null（忽略，不炸）。
 * 收方只解析資料塊；RESUME / ACK 是我們送出去的，不會回收。
 */
export function parseDataFrame(data: Uint8Array): ParsedDataFrame | null {
  if (data.length < FRAME_HEADER_LEN) return null;
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (buf.readUInt8(0) !== FRAME_DATA) return null;
  const chunkIndex = buf.readUInt32LE(1);
  // 複製 payload，避免共享底層 ArrayBuffer 在後續被覆寫
  const payload = Buffer.from(buf.subarray(FRAME_HEADER_LEN));
  return { chunkIndex, payload };
}

// ─────────────── ResumableTransfer ───────────────

export class ResumableTransfer {
  private readonly transport: BleTransport;
  private readonly ackEvery: number;
  private readonly stallTimeoutMs: number;
  private readonly onProgress?: (received: number, total: number) => void;

  /** 可動態調整（setThrottle）；故非 readonly。 */
  private throttleMs: number;

  constructor(transport: BleTransport, opts: ResumableTransferOptions = {}) {
    this.transport = transport;
    this.ackEvery = opts.ackEvery && opts.ackEvery > 0 ? Math.floor(opts.ackEvery) : 8;
    this.throttleMs = opts.throttleMs && opts.throttleMs > 0 ? opts.throttleMs : 0;
    this.stallTimeoutMs =
      opts.stallTimeoutMs && opts.stallTimeoutMs > 0 ? opts.stallTimeoutMs : 30_000;
    this.onProgress = opts.onProgress;
  }

  /** 動態調整節流（給優先級切換用）。foreground→0、background→較大值。 */
  setThrottle(ms: number): void {
    this.throttleMs = ms > 0 ? ms : 0;
  }

  /**
   * 接收一個檔案：處理亂序 / 重複 / 斷線續傳，回完整 Buffer。
   *
   * 流程：
   *   1. 算總塊數，配置接收緩衝（依 totalBytes），訂閱 transport.onData。
   *   2. 收到資料塊 → parseDataFrame → 寫進對應 offset、標記已收、回報 progress；
   *      重複塊忽略，亂序塊放對位置。每 ackEvery 塊送一次 ACK(連續已收到的最後一塊)。
   *   3. 若中途斷線（transport.connected 轉 false）：不炸，等重連；重連成功後送
   *      RESUME(第一個缺口塊) 要求裝置續傳。
   *   4. 全部塊湊齊 → 解除訂閱、回傳重組 Buffer。
   *   5. stallTimeoutMs 內毫無進展（沒新塊、也沒成功重連）→ 拋 AppError(IO_ERROR,"傳輸逾時")。
   */
  receiveFile(manifest: TransferManifest): Promise<TransferResult> {
    this.validateManifest(manifest);

    const { fileId, totalBytes, chunkSize } = manifest;
    const totalChunks = totalBytes === 0 ? 0 : Math.ceil(totalBytes / chunkSize);

    // 邊界：空檔直接完成（無塊可收）。
    if (totalChunks === 0) {
      this.onProgress?.(0, 0);
      return Promise.resolve({ fileId, data: Buffer.alloc(0), bytes: 0 });
    }

    const out = Buffer.alloc(totalBytes);
    const received = new Set<number>();
    /** 連續已收到的最後一塊（用於 ACK）；-1 代表連第 0 塊都還沒到。 */
    let contiguousUpTo = -1;
    let sinceLastAck = 0;

    return new Promise<TransferResult>((resolve, reject) => {
      let settled = false;
      // 監看「是否有進展」：收到新塊或重連成功都算進展，會重置逾時計時器。
      let stallTimer: ReturnType<typeof setTimeout> | undefined;
      // 重連輪詢計時器（斷線時啟動）。
      let reconnectTimer: ReturnType<typeof setInterval> | undefined;
      // 正在嘗試重連，避免重入。
      let reconnecting = false;
      // 串接處理鏈：確保 throttle / 寫入按序進行，不會因 notify 連發而交錯。
      let chain: Promise<void> = Promise.resolve();

      const cleanup = (): void => {
        if (stallTimer) clearTimeout(stallTimer);
        if (reconnectTimer) clearInterval(reconnectTimer);
        stallTimer = undefined;
        reconnectTimer = undefined;
      };

      const fail = (err: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(
          err instanceof AppError
            ? err
            : new AppError(
                ErrorCode.IO_ERROR,
                `藍牙傳輸失敗：${err instanceof Error ? err.message : String(err)}`,
              ),
        );
      };

      const succeed = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ fileId, data: out, bytes: totalBytes });
      };

      // 逾時計時器：每次「有進展」就重啟；耗盡才判逾時。
      const armStallTimer = (): void => {
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
          fail(new AppError(ErrorCode.IO_ERROR, "傳輸逾時"));
        }, this.stallTimeoutMs);
      };
      const noteProgress = (): void => {
        if (settled) return;
        armStallTimer();
      };

      // ── 斷線重連監看：整個傳輸期間持續輪詢 transport.connected ──
      //   為何「整個期間」而非「斷線時才開」：連線可能在「收不到任何資料」的情況下
      //   悄悄斷掉（例如裝置走遠），此時沒有 onData 事件可觸發監看。故啟動即常駐輪詢；
      //   已連線時 interval 內直接 no-op，幾乎零成本。斷線→嘗試 connect()→成功後送
      //   RESUME(第一個缺口塊) 要求裝置續傳。
      const ensureReconnectWatch = (): void => {
        if (reconnectTimer || settled) return;
        reconnectTimer = setInterval(() => {
          if (settled) return;
          if (this.transport.connected || reconnecting) return;
          reconnecting = true;
          this.transport
            .connect()
            .then(() => {
              reconnecting = false;
              if (settled) return;
              // 重連算「有進展」（避免在重連瞬間誤判逾時），並請求自缺口續傳。
              noteProgress();
              const from = this.firstMissing(received, totalChunks);
              if (from < totalChunks) {
                return this.transport.send(encodeResumeFrame(from));
              }
              return undefined;
            })
            .catch(() => {
              // 重連 / 送 RESUME 失敗：不炸，下一輪繼續嘗試，由 stall timer 決定是否放棄。
              reconnecting = false;
            });
        }, 500);
      };

      // ── 處理單一資料塊（在 chain 上串接，含節流）──
      const handleChunk = (frame: ParsedDataFrame): Promise<void> => {
        return (async () => {
          if (settled) return;
          const { chunkIndex, payload } = frame;

          // 防呆：越界塊（裝置送錯）忽略。
          if (chunkIndex < 0 || chunkIndex >= totalChunks) return;
          // 重複塊忽略（冪等）。
          if (received.has(chunkIndex)) return;

          // 寫進對應 offset（亂序也能放對位置）。最後一塊可能不足 chunkSize。
          const offset = chunkIndex * chunkSize;
          const writable = Math.min(payload.length, totalBytes - offset);
          if (writable > 0) payload.copy(out, offset, 0, writable);

          received.add(chunkIndex);
          noteProgress();
          this.onProgress?.(received.size, totalChunks);

          // 推進「連續已收到」游標，並節流送 ACK。
          while (received.has(contiguousUpTo + 1)) contiguousUpTo++;
          sinceLastAck++;
          if (sinceLastAck >= this.ackEvery && contiguousUpTo >= 0) {
            sinceLastAck = 0;
            // ACK 送失敗不致命（純節流回報）；吞錯續跑。
            await this.safeSend(encodeAckFrame(contiguousUpTo));
          }

          // 全收齊 → 補送最終 ACK 後完成。
          if (received.size === totalChunks) {
            await this.safeSend(encodeAckFrame(totalChunks - 1));
            succeed();
            return;
          }

          // 背景節流：讓出資源給前景。
          if (this.throttleMs > 0) await delay(this.throttleMs);
        })();
      };

      // ── 訂閱 transport 推送 ──
      this.transport.onData((data: Uint8Array) => {
        if (settled) return;
        const frame = parseDataFrame(data);
        if (!frame) return; // 非資料塊 / 壞 frame：忽略
        // 串接到 chain，保證按序處理且節流不交錯；任何例外導向 fail。
        chain = chain.then(() => handleChunk(frame)).catch(fail);
      });

      // 啟動：武裝逾時計時器，並常駐重連監看（涵蓋傳輸中無聲斷線的情況）。
      armStallTimer();
      ensureReconnectWatch();
    });
  }

  // ─────────────── 私有工具 ───────────────

  /** 找第一個尚未收到的塊索引（缺口起點）；全收齊則回 totalChunks。 */
  private firstMissing(received: Set<number>, totalChunks: number): number {
    for (let i = 0; i < totalChunks; i++) {
      if (!received.has(i)) return i;
    }
    return totalChunks;
  }

  /** 送出 frame，吞掉錯誤（ACK / 非致命指令用）。 */
  private async safeSend(frame: Buffer): Promise<void> {
    try {
      await this.transport.send(frame);
    } catch {
      // 送 ACK 失敗不影響續傳正確性，靜默略過。
    }
  }

  /** manifest 防呆：欄位合法才繼續，否則拋 INVALID_INPUT。 */
  private validateManifest(manifest: TransferManifest): void {
    if (!manifest || typeof manifest.fileId !== "string" || manifest.fileId.length === 0) {
      throw new AppError(ErrorCode.INVALID_INPUT, "manifest.fileId 不可為空");
    }
    if (!Number.isInteger(manifest.totalBytes) || manifest.totalBytes < 0) {
      throw new AppError(ErrorCode.INVALID_INPUT, "manifest.totalBytes 必須為非負整數");
    }
    if (!Number.isInteger(manifest.chunkSize) || manifest.chunkSize <= 0) {
      throw new AppError(ErrorCode.INVALID_INPUT, "manifest.chunkSize 必須為正整數");
    }
  }
}

/** 非阻塞延遲（節流用）。 */
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
