// ════════════════════════════════════════════════════════════════════
//  SecurityManager — 本地 AES-256-GCM 檔案加密 / 解密
//
//  安全設計重點（規格要求）：
//  • 演算法：AES-256-GCM（同時提供機密性與完整性驗證，竄改會在 final() 失敗）。
//  • 金鑰推導：scryptSync(secretKey, salt, 32)，salt 由建構子帶入（來自
//    環境變數 ENCRYPTION_SALT），讓相同密碼在不同部署產出不同金鑰。
//  • 記憶體管理：JS 的 string 是不可變（immutable）物件，無法手動清零，
//    一旦進入記憶體就只能等 GC，期間可能被 memory dump 擷取。故所有敏感
//    中間值（推導出的金鑰、必要時的明文副本）一律以 Buffer 承載，用畢
//    立即呼叫 .fill(0) 主動歸零，降低明文殘留在 heap 的風險；同時避免把
//    明文長期保存在閉包或全域變數中。
//
//  檔案格式（bytes）：
//    [ MAGIC(4 'PRV1') ][ IV(12) ][ authTag(16) ][ ciphertext... ]
// ════════════════════════════════════════════════════════════════════

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { AppError, ErrorCode } from "../shared/types";

/** 檔頭魔術字串，用來辨識本系統產出的加密檔。 */
const MAGIC = Buffer.from("PRV1", "ascii"); // 4 bytes
const IV_LENGTH = 12; // GCM 建議的 nonce 長度
const AUTH_TAG_LENGTH = 16; // GCM authTag 固定 16 bytes
const KEY_LENGTH = 32; // AES-256 → 32 bytes
const HEADER_LENGTH = MAGIC.length + IV_LENGTH + AUTH_TAG_LENGTH; // 32

export class SecurityManager {
  /** scrypt 推導用的 salt（字串原文，來自 ENCRYPTION_SALT）。 */
  private readonly salt: string;

  constructor(salt: string) {
    if (typeof salt !== "string" || salt.length === 0) {
      throw new AppError(ErrorCode.CONFIG_MISSING, "SecurityManager 需要非空的 salt（ENCRYPTION_SALT）");
    }
    this.salt = salt;
  }

  /**
   * 將 data 以 AES-256-GCM 加密後寫入 filePath。
   * 自動建立上層目錄；寫入後清除推導金鑰。
   */
  async encryptToFile(filePath: string, data: Buffer, secretKey: string): Promise<void> {
    // ─── 防呆 ───
    if (typeof filePath !== "string" || filePath.length === 0) {
      throw new AppError(ErrorCode.INVALID_INPUT, "filePath 不可為空");
    }
    if (!Buffer.isBuffer(data)) {
      throw new AppError(ErrorCode.INVALID_INPUT, "data 必須為 Buffer");
    }
    if (typeof secretKey !== "string" || secretKey.length === 0) {
      throw new AppError(ErrorCode.INVALID_INPUT, "secretKey 不可為空");
    }

    // 推導 32-byte 金鑰；scryptSync 在參數異常（如記憶體不足）時會丟錯
    let key: Buffer;
    try {
      key = scryptSync(secretKey, this.salt, KEY_LENGTH);
    } catch (err) {
      throw new AppError(
        ErrorCode.CRYPTO_KEY_INVALID,
        "金鑰推導失敗",
        err instanceof Error ? err.message : err,
      );
    }

    try {
      const iv = randomBytes(IV_LENGTH);
      const cipher = createCipheriv("aes-256-gcm", key, iv);

      // 分段加密，最後取得 authTag（必須在 final() 之後才有效）
      const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
      const authTag = cipher.getAuthTag(); // 16 bytes

      const out = Buffer.concat([MAGIC, iv, authTag, encrypted]);

      // 確保上層目錄存在（mkdir -p）
      const dir = path.dirname(filePath);
      await fs.mkdir(dir, { recursive: true });

      try {
        await fs.writeFile(filePath, out);
      } catch (err) {
        throw new AppError(
          ErrorCode.IO_ERROR,
          `寫入加密檔失敗：${filePath}`,
          err instanceof Error ? err.message : err,
        );
      }
    } finally {
      // 敏感金鑰用畢立即歸零，避免殘留於記憶體
      key.fill(0);
    }
  }

  /**
   * 讀取 filePath、驗證完整性後回傳解密的明文 Buffer。
   * 回傳的 Buffer 為明文，呼叫端用畢應自行 .fill(0)（server.ts 已示範）。
   */
  async decryptFromFile(filePath: string, secretKey: string): Promise<Buffer> {
    // ─── 防呆 ───
    if (typeof filePath !== "string" || filePath.length === 0) {
      throw new AppError(ErrorCode.INVALID_INPUT, "filePath 不可為空");
    }
    if (typeof secretKey !== "string" || secretKey.length === 0) {
      throw new AppError(ErrorCode.INVALID_INPUT, "secretKey 不可為空");
    }

    // ─── 讀檔（檔案不存在 / 無法讀取 → 結構化錯誤） ───
    let raw: Buffer;
    try {
      raw = await fs.readFile(filePath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") {
        throw new AppError(ErrorCode.CRYPTO_FILE_CORRUPT, `加密檔不存在：${filePath}`, code);
      }
      throw new AppError(
        ErrorCode.IO_ERROR,
        `讀取加密檔失敗：${filePath}`,
        err instanceof Error ? err.message : err,
      );
    }

    // ─── 結構驗證：至少要容得下檔頭 ───
    if (raw.length < HEADER_LENGTH) {
      throw new AppError(ErrorCode.CRYPTO_FILE_CORRUPT, "加密檔長度不足，檔案已損壞");
    }

    // ─── 驗 MAGIC ───
    const magic = raw.subarray(0, MAGIC.length);
    if (!magic.equals(MAGIC)) {
      throw new AppError(ErrorCode.CRYPTO_FILE_CORRUPT, "檔頭不符（非本系統加密檔或已損壞）");
    }

    // ─── 切出 IV / authTag / ciphertext ───
    const iv = raw.subarray(MAGIC.length, MAGIC.length + IV_LENGTH);
    const authTag = raw.subarray(MAGIC.length + IV_LENGTH, HEADER_LENGTH);
    const ciphertext = raw.subarray(HEADER_LENGTH);

    // 推導金鑰（同加密路徑）
    let key: Buffer;
    try {
      key = scryptSync(secretKey, this.salt, KEY_LENGTH);
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

      // GCM：金鑰錯誤或內容/標籤遭竄改時，final() 會丟出
      // "Unsupported state or unable to authenticate data" 例外
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return plaintext;
    } catch {
      // 不外洩底層細節，統一回報為解密失敗
      throw new AppError(
        ErrorCode.CRYPTO_DECRYPT_FAILED,
        "解密失敗：金鑰錯誤或檔案遭竄改",
      );
    } finally {
      // 敏感金鑰用畢立即歸零
      key.fill(0);
    }
  }
}
