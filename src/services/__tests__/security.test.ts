// ════════════════════════════════════════════════════════════════════
//  SecurityManager 單元測試（vitest）
//
//  全程寫入系統暫存目錄（os.tmpdir()），測試結束清理。涵蓋：
//   1. round-trip：加密後解密還原，等於原文（含中文 UTF-8）。
//   2. 密文不含明文：.enc 檔內容不應包含原始明文字串。
//   3. 錯誤金鑰：不同 secretKey 解密 → reject，code = CRYPTO_DECRYPT_FAILED。
//   4. 竄改偵測：改檔案最後一個 byte → reject。
// ════════════════════════════════════════════════════════════════════

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

import { SecurityManager } from "../SecurityManager";
import { ErrorCode } from "../../shared/types";

const SALT = "unit-test-salt-請勿用於正式環境";
const SECRET = "correct horse battery staple";
const WRONG_SECRET = "totally-different-key";
const PLAINTEXT = "機密會議逐字稿：本季財報外洩風險 — secret payload 12345 ✅";

const manager = new SecurityManager(SALT);

// 每個測試各自的暫存檔，避免互相干擾
let tempDir: string;

beforeAll(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "proactor-sec-test-"));
});

afterAll(async () => {
  // 清理整個暫存資料夾（含巢狀的自動建立目錄）
  await fs.rm(tempDir, { recursive: true, force: true });
});

/** 在 tempDir 下產生唯一 .enc 路徑（並驗證會自動 mkdir -p 子目錄）。 */
function uniqueEncPath(): string {
  return path.join(tempDir, "nested", "dir", `${randomBytes(6).toString("hex")}.enc`);
}

describe("SecurityManager", () => {
  it("round-trip：加密後解密可還原原文（含中文 UTF-8）", async () => {
    const filePath = uniqueEncPath();
    const data = Buffer.from(PLAINTEXT, "utf8");

    await manager.encryptToFile(filePath, data, SECRET);

    // 檔案確實被建立
    const stat = await fs.stat(filePath);
    expect(stat.size).toBeGreaterThan(0);

    const decrypted = await manager.decryptFromFile(filePath, SECRET);
    expect(decrypted.equals(data)).toBe(true);
    expect(decrypted.toString("utf8")).toBe(PLAINTEXT);
  });

  it("密文不含明文：.enc 檔內容不應包含原始明文字串", async () => {
    const filePath = uniqueEncPath();
    const data = Buffer.from(PLAINTEXT, "utf8");

    await manager.encryptToFile(filePath, data, SECRET);

    const raw = await fs.readFile(filePath);

    // 檔頭應為 MAGIC 'PRV1'
    expect(raw.subarray(0, 4).toString("ascii")).toBe("PRV1");

    // 整份密文不得含原始明文（UTF-8 bytes）
    expect(raw.includes(data)).toBe(false);
    // 也不得含明文中可辨識的子字串
    expect(raw.toString("utf8").includes("secret payload")).toBe(false);
  });

  it("錯誤金鑰：以不同 secretKey 解密應 reject，code = CRYPTO_DECRYPT_FAILED", async () => {
    const filePath = uniqueEncPath();
    const data = Buffer.from(PLAINTEXT, "utf8");

    await manager.encryptToFile(filePath, data, SECRET);

    await expect(manager.decryptFromFile(filePath, WRONG_SECRET)).rejects.toMatchObject({
      code: ErrorCode.CRYPTO_DECRYPT_FAILED,
    });
  });

  it("竄改偵測：修改檔案最後一個 byte 後解密應 reject", async () => {
    const filePath = uniqueEncPath();
    const data = Buffer.from(PLAINTEXT, "utf8");

    await manager.encryptToFile(filePath, data, SECRET);

    // 手動竄改：翻轉最後一個 byte
    const raw = await fs.readFile(filePath);
    raw[raw.length - 1] = raw[raw.length - 1] ^ 0xff;
    await fs.writeFile(filePath, raw);

    await expect(manager.decryptFromFile(filePath, SECRET)).rejects.toMatchObject({
      code: ErrorCode.CRYPTO_DECRYPT_FAILED,
    });
  });

  it("檔頭不符：非本系統加密檔應拋 CRYPTO_FILE_CORRUPT", async () => {
    const filePath = uniqueEncPath();
    // 寫入夠長但 MAGIC 錯誤的內容
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, Buffer.concat([Buffer.from("XXXX"), randomBytes(64)]));

    await expect(manager.decryptFromFile(filePath, SECRET)).rejects.toMatchObject({
      code: ErrorCode.CRYPTO_FILE_CORRUPT,
    });
  });

  it("防呆：data 非 Buffer 或 secretKey 為空應拋 INVALID_INPUT", async () => {
    const filePath = uniqueEncPath();

    // data 非 Buffer
    await expect(
      // @ts-expect-error 故意傳錯型別測試防呆
      manager.encryptToFile(filePath, "not-a-buffer", SECRET),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_INPUT });

    // secretKey 為空
    await expect(
      manager.encryptToFile(filePath, Buffer.from("x"), ""),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_INPUT });
  });
});
