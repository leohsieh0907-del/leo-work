// ════════════════════════════════════════════════════════════════════
//  BluetoothHardwareSource — 藍牙硬體音訊源（實作 AudioSource）
//
//  模式：這是【檔案同步】來源（非即時逐字稿）。PM01-9 錄音卡把整段錄音存在
//  裝置上，透過 BLE 推「有新檔案」的 MANIFEST 通知；本來源對每個檔案跑
//  ResumableTransfer.receiveFile（自定 framing，含亂序 / 重複 / 斷線續傳），
//  傳完若為密文則就地解密成明文 Buffer，再觸發 onFileSynced —— 這就是
//  「傳完自動解密、送 Claude 批次摘要」的接點（批次摘要本身由上層 Router /
//  server 負責，本來源只負責把明文交出去）。
//
//  與即時來源（WebRtcSoftwareSource）的差異：
//   • onDataReceived 不發即時逐字塊（檔案同步沒有逐幀串流的語意）；重點是
//     onFileSynced + status 進度。仍保留 onDataReceived 介面以符合 AudioSource 契約。
//   • setPriority("background") → 加大 ResumableTransfer 的節流，讓 WebRTC 即時
//     串流不被藍牙傳輸搶資源；"foreground" → 節流歸 0。
//
//  ── 裝置→PC 的 MANIFEST framing（與 ResumableTransfer 的資料塊 framing 同層自定）──
//    [uint8 type=0x10][uint8 encrypted(0/1)][uint32 LE totalBytes][uint32 LE chunkSize]
//    [uint16 LE fileIdLen][fileId UTF-8 bytes]
//  ⚠️ 實際 PM01-9 如何宣告「有新檔」為私有協定；此 framing 是我們與裝置韌體的
//     對接約定，需原廠文件確認。收到 MANIFEST → 啟動一次 receiveFile。
//
//  ── 解密 ──
//    SecurityManager 是檔案版（encryptToFile / decryptFromFile）；本情境密文在記憶體
//    Buffer，故此處自寫對應的 decryptBuffer（同格式 [MAGIC 'PRV1'][IV(12)][tag(16)]
//    [cipher]，AES-256-GCM、scrypt(salt) 推導金鑰）。需 secretKey + encryptionSalt。
// ════════════════════════════════════════════════════════════════════

import { createDecipheriv, scryptSync } from "node:crypto";

import { AppError, ErrorCode } from "../../shared/types";
import type { BluetoothTransferStatus, SourcePriority } from "../../shared/types";
import type {
  AudioChunk,
  AudioSource,
  BleTransport,
  TransferManifest,
  TransferResult,
} from "./types";
import { ResumableTransfer } from "./ResumableTransfer";

/** MANIFEST frame 類型（裝置→PC，宣告有新錄音檔）。 */
const FRAME_MANIFEST = 0x10;

/** 背景優先級時，ResumableTransfer 的節流毫秒（讓出資源給 WebRTC 即時串流）。 */
const BACKGROUND_THROTTLE_MS = 15;

// 解密格式常數（對齊 SecurityManager 的檔案格式）。
const MAGIC = Buffer.from("PRV1", "ascii"); // 4 bytes
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const HEADER_LENGTH = MAGIC.length + IV_LENGTH + AUTH_TAG_LENGTH; // 32

export interface BluetoothSourceOptions {
  transport: BleTransport;
  /** 傳完的（解密後）檔案回呼，上層拿去送 Claude 批次摘要。 */
  onFileSynced?: (file: { fileId: string; data: Buffer }) => void;
  /** 解密用（可選；密文檔才需要）。缺則收到 encrypted 檔會報錯。 */
  secretKey?: string;
  encryptionSalt?: string;
}

export class BluetoothHardwareSource implements AudioSource {
  readonly id = "bluetooth" as const;

  private readonly transport: BleTransport;
  private readonly onFileSynced?: (file: { fileId: string; data: Buffer }) => void;
  private readonly secretKey?: string;
  private readonly encryptionSalt?: string;

  private readonly transfer: ResumableTransfer;

  private errorCb?: (err: Error) => void;

  private _streaming = false;
  private priority: SourcePriority = "foreground";

  // ── 進度狀態（供 status() 回報）──
  private transferring = false;
  private receivedBytes = 0;
  private totalBytes: number | null = null;

  /** 同一時間只處理一個檔案：序列化 MANIFEST，避免並行傳輸互踩 transport。 */
  private fileQueue: Promise<void> = Promise.resolve();

  constructor(opts: BluetoothSourceOptions) {
    if (!opts || !opts.transport) {
      throw new AppError(ErrorCode.CONFIG_MISSING, "BluetoothHardwareSource 需要 transport");
    }
    this.transport = opts.transport;
    this.onFileSynced = opts.onFileSynced;
    this.secretKey = opts.secretKey;
    this.encryptionSalt = opts.encryptionSalt;

    // 進度回呼即時更新 status；節流預設 foreground=0。
    this.transfer = new ResumableTransfer(this.transport, {
      onProgress: (received, total) => {
        // received/total 為「塊數」；位元組以塊比例近似（最後一塊不滿不影響進度條語意）。
        if (this.totalBytes != null && total > 0) {
          this.receivedBytes = Math.min(
            this.totalBytes,
            Math.round((received / total) * this.totalBytes),
          );
        }
      },
    });
  }

  get streaming(): boolean {
    return this._streaming;
  }

  /**
   * connect transport，開始監聽裝置推送的 MANIFEST 通知。
   * 注意：transport.onData 同時餵給 ResumableTransfer（資料塊）與本來源（MANIFEST）。
   * 兩者用不同 type byte 區分（0x01 資料塊 vs 0x10 MANIFEST），互不干擾。
   */
  async startStream(): Promise<void> {
    if (this._streaming) return;

    // 監聽 MANIFEST（0x10）。
    // ⚠️ onData 為「覆蓋」語意：ResumableTransfer.receiveFile 期間會把 onData 覆蓋成
    //    自己的資料塊 handler 以獨佔資料塊。因檔案以序列佇列逐一處理（同時只跑一個
    //    receiveFile），傳輸期間本就該由它獨佔；傳完後 syncOneFile 會 reinstallManifestListener()
    //    把 onData 還原回 MANIFEST handler，故下一個檔案的 MANIFEST 不會漏接。
    this.reinstallManifestListener();

    try {
      await this.transport.connect();
    } catch (err) {
      const e = toError(err);
      this.errorCb?.(e);
      throw e;
    }

    this._streaming = true;
  }

  /** 把 transport.onData 設回 MANIFEST 路由器（startStream 與每次傳輸完成後呼叫）。 */
  private reinstallManifestListener(): void {
    this.transport.onData((data: Uint8Array) => {
      const manifest = parseManifestFrame(data);
      if (manifest) this.enqueueFile(manifest);
    });
  }

  /** 停止串流：斷線、清狀態。可重複呼叫安全。 */
  async stopStream(): Promise<void> {
    if (!this._streaming) {
      // 即便未在串流也嘗試斷線清理（防呆）
      try {
        await this.transport.disconnect();
      } catch {
        /* 已斷線 */
      }
      return;
    }
    this._streaming = false;
    this.transferring = false;
    try {
      await this.transport.disconnect();
    } catch (err) {
      // 斷線失敗不致命，但回報讓上層知道
      this.errorCb?.(toError(err));
    }
  }

  onDataReceived(_callback: (chunk: AudioChunk) => void): void {
    // 檔案同步模式不發即時逐字塊（重點在 onFileSynced）；保留介面相容，不儲存 callback。
  }

  onError(callback: (err: Error) => void): void {
    this.errorCb = callback;
  }

  /**
   * 調整優先級。
   * background → ResumableTransfer 加大節流（讓 WebRTC 即時串流不掉幀）；
   * foreground → 節流歸 0（全速傳）。
   */
  setPriority(priority: SourcePriority): void {
    this.priority = priority;
    this.transfer.setThrottle(priority === "background" ? BACKGROUND_THROTTLE_MS : 0);
  }

  /** 回報目前傳輸狀態（推播給前端進度條 / Router）。 */
  status(): BluetoothTransferStatus {
    const total = this.totalBytes;
    const progress = total && total > 0 ? Math.min(1, this.receivedBytes / total) : 0;
    return {
      connected: this.transport.connected,
      transferring: this.transferring,
      progress,
      priority: this.priority,
      receivedBytes: this.receivedBytes,
      totalBytes: total,
    };
  }

  // ─────────────── 私有 ───────────────

  /**
   * 把一個檔案傳輸排進序列佇列（同時只跑一個 receiveFile，避免並行互踩 transport
   * 的資料塊解析）。失敗只回報 onError，不中斷整個來源（後續檔案仍可同步）。
   */
  private enqueueFile(manifest: TransferManifest): void {
    this.fileQueue = this.fileQueue.then(() => this.syncOneFile(manifest)).catch((err) => {
      this.errorCb?.(toError(err));
    });
  }

  /** 同步單一檔案：receiveFile → 必要時解密 → onFileSynced。 */
  private async syncOneFile(manifest: TransferManifest): Promise<void> {
    this.transferring = true;
    this.totalBytes = manifest.totalBytes;
    this.receivedBytes = 0;

    let result: TransferResult;
    try {
      result = await this.transfer.receiveFile(manifest);
    } finally {
      this.transferring = false;
      // receiveFile 期間把 onData 覆蓋成資料塊 handler；傳完（成功或失敗）都要還原成
      // MANIFEST 路由器，否則下一個檔案的 MANIFEST 會漏接。仍在串流中才重裝。
      if (this._streaming) this.reinstallManifestListener();
    }

    // 傳完：receivedBytes 對齊實際位元組。
    this.receivedBytes = result.bytes;

    let plaintext = result.data;
    if (manifest.encrypted) {
      plaintext = this.decryptBuffer(result.data);
    }

    // 交給上層送 Claude 批次摘要。
    this.onFileSynced?.({ fileId: result.fileId, data: plaintext });
  }

  /**
   * 記憶體版解密，對應 SecurityManager 的檔案格式：
   *   [MAGIC 'PRV1'(4)][IV(12)][authTag(16)][ciphertext...]，AES-256-GCM，
   *   金鑰 = scrypt(secretKey, salt, 32)。竄改 / 金鑰錯 → final() 拋例外 →
   *   統一回報 CRYPTO_DECRYPT_FAILED。用畢把推導金鑰歸零（降低 heap 殘留）。
   */
  private decryptBuffer(blob: Buffer): Buffer {
    if (!this.secretKey || !this.encryptionSalt) {
      throw new AppError(
        ErrorCode.CONFIG_MISSING,
        "收到加密檔但未提供 secretKey / encryptionSalt，無法解密",
      );
    }
    if (blob.length < HEADER_LENGTH) {
      throw new AppError(ErrorCode.CRYPTO_FILE_CORRUPT, "密文長度不足，內容已損壞");
    }
    if (!blob.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new AppError(ErrorCode.CRYPTO_FILE_CORRUPT, "檔頭不符（非本系統加密內容或已損壞）");
    }

    const iv = blob.subarray(MAGIC.length, MAGIC.length + IV_LENGTH);
    const authTag = blob.subarray(MAGIC.length + IV_LENGTH, HEADER_LENGTH);
    const ciphertext = blob.subarray(HEADER_LENGTH);

    let key: Buffer;
    try {
      key = scryptSync(this.secretKey, this.encryptionSalt, KEY_LENGTH);
    } catch (err) {
      throw new AppError(
        ErrorCode.CRYPTO_KEY_INVALID,
        "金鑰推導失敗",
        err instanceof Error ? err.message : err,
      );
    }

    try {
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(authTag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      throw new AppError(ErrorCode.CRYPTO_DECRYPT_FAILED, "解密失敗：金鑰錯誤或內容遭竄改");
    } finally {
      key.fill(0);
    }
  }
}

// ─────────────── 模組層級：MANIFEST framing 解析 ───────────────

/**
 * 解析 MANIFEST frame（裝置→PC 宣告有新錄音檔）。
 *   [uint8 type=0x10][uint8 encrypted][uint32 LE totalBytes][uint32 LE chunkSize]
 *   [uint16 LE fileIdLen][fileId UTF-8]
 * 非 0x10 / 長度不足 / fileIdLen 與實際不符 → 回 null（忽略，不炸）。
 */
export function parseManifestFrame(data: Uint8Array): TransferManifest | null {
  // 最短：1+1+4+4+2 = 12 bytes 表頭
  if (data.length < 12) return null;
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (buf.readUInt8(0) !== FRAME_MANIFEST) return null;

  const encrypted = buf.readUInt8(1) === 1;
  const totalBytes = buf.readUInt32LE(2);
  const chunkSize = buf.readUInt32LE(6);
  const fileIdLen = buf.readUInt16LE(10);

  if (chunkSize <= 0) return null;
  if (buf.length < 12 + fileIdLen) return null;

  const fileId = buf.subarray(12, 12 + fileIdLen).toString("utf8");
  if (fileId.length === 0) return null;

  return { fileId, totalBytes, chunkSize, encrypted };
}

/**
 * 組裝 MANIFEST frame（測試 / 裝置端模擬用）。與 parseManifestFrame 對齊。
 */
export function encodeManifestFrame(manifest: TransferManifest): Buffer {
  const fileIdBytes = Buffer.from(manifest.fileId, "utf8");
  const buf = Buffer.allocUnsafe(12 + fileIdBytes.length);
  buf.writeUInt8(FRAME_MANIFEST, 0);
  buf.writeUInt8(manifest.encrypted ? 1 : 0, 1);
  buf.writeUInt32LE(manifest.totalBytes >>> 0, 2);
  buf.writeUInt32LE(manifest.chunkSize >>> 0, 6);
  buf.writeUInt16LE(fileIdBytes.length, 10);
  fileIdBytes.copy(buf, 12);
  return buf;
}

/** 把 unknown 轉成 Error（回呼一律給 Error）。 */
function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
