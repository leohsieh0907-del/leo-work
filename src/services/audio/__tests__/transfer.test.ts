// ════════════════════════════════════════════════════════════════════
//  斷點續傳核心測試（vitest）— 用 FakeBleTransport 實跑
//
//  FakeBleTransport 可腳本化「推送哪些塊、何時斷線 / 重連」，不需要真實 BLE。
//  涵蓋：
//    1. 順序送齊所有塊 → receiveFile 回正確完整 Buffer（位元組正確）。
//    2. 亂序 + 重複塊 → 仍正確重組、重複被忽略。
//    3. 斷線續傳 → 送一半、disconnect、reconnect → 驗證有送出 RESUME(正確
//       fromChunkIndex) → 補齊剩餘 → 完整還原。
//    4. throttleMs 生效（背景節流不影響正確性）。
//  另含 BluetoothHardwareSource 端到端：MANIFEST→傳輸→（加密則）解密→onFileSynced。
// ════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi } from "vitest";
import { createCipheriv, randomBytes, scryptSync } from "node:crypto";

import {
  ResumableTransfer,
  encodeDataFrame,
  parseDataFrame,
  FRAME_RESUME,
  FRAME_ACK,
} from "../ResumableTransfer";
import {
  BluetoothHardwareSource,
  encodeManifestFrame,
  parseManifestFrame,
} from "../BluetoothHardwareSource";
import type { BleTransport, TransferManifest } from "../types";

// ════════════════ FakeBleTransport ════════════════

/** 收方送出的控制 frame 解碼（驗證 RESUME / ACK）。 */
interface SentFrame {
  type: number;
  index: number;
}

function decodeControl(data: Uint8Array): SentFrame {
  const buf = Buffer.from(data);
  return { type: buf.readUInt8(0), index: buf.readUInt32LE(1) };
}

/**
 * 可腳本化的假 BLE 傳輸。
 * - onData 採「覆蓋」語意（後註冊覆蓋前者），與 NobleBleTransport 一致。
 * - pushChunk / pushManifest 模擬裝置推送。
 * - dropConnection / restoreConnection 模擬斷線 / 重連。
 * - 記錄所有收方送出的 frame（sent）供斷言。
 * - 可選 onResume：收到 RESUME 時自動從該塊起補送剩餘塊（模擬裝置韌體續傳）。
 */
class FakeBleTransport implements BleTransport {
  private cb?: (data: Uint8Array) => void;
  private _connected = false;
  /** connect() 是否成功（模擬重連失敗可設 false）。 */
  connectShouldSucceed = true;

  readonly sent: SentFrame[] = [];
  /** 收到 RESUME(from) 時觸發；裝置端據此續傳。 */
  onResume?: (from: number) => void;
  /** connect() 被呼叫次數（驗證重連）。 */
  connectCalls = 0;

  get connected(): boolean {
    return this._connected;
  }

  async connect(): Promise<void> {
    this.connectCalls++;
    if (!this.connectShouldSucceed) throw new Error("模擬連線失敗");
    this._connected = true;
  }

  async disconnect(): Promise<void> {
    this._connected = false;
  }

  onData(callback: (data: Uint8Array) => void): void {
    this.cb = callback; // 覆蓋語意
  }

  async send(data: Uint8Array): Promise<void> {
    const frame = decodeControl(data);
    this.sent.push(frame);
    if (frame.type === FRAME_RESUME) this.onResume?.(frame.index);
  }

  // ── 測試操控 ──

  /** 模擬裝置推送一個資料塊。 */
  pushChunk(chunkIndex: number, payload: Buffer): void {
    if (!this._connected) return; // 斷線時推送丟失（模擬真實掉包）
    this.cb?.(new Uint8Array(encodeDataFrame(chunkIndex, payload)));
  }

  /** 模擬裝置推送 MANIFEST。 */
  pushRaw(data: Uint8Array): void {
    this.cb?.(data);
  }

  dropConnection(): void {
    this._connected = false;
  }

  restoreConnection(): void {
    this._connected = true;
  }

  /** 取目前註冊的 onData（給端到端測試手動驅動）。 */
  emit(data: Uint8Array): void {
    this.cb?.(data);
  }
}

// ─────────────── 輔助：切塊 ───────────────

/** 把整檔切成 chunkSize 的塊陣列（最後一塊可能不足）。 */
function sliceChunks(data: Buffer, chunkSize: number): Buffer[] {
  const chunks: Buffer[] = [];
  for (let off = 0; off < data.length; off += chunkSize) {
    chunks.push(data.subarray(off, Math.min(off + chunkSize, data.length)));
  }
  return chunks;
}

/** 產生可辨識內容的測試檔（每 byte = index % 256）。 */
function makeFile(bytes: number): Buffer {
  const buf = Buffer.allocUnsafe(bytes);
  for (let i = 0; i < bytes; i++) buf[i] = i % 256;
  return buf;
}

// ════════════════ framing helper 測試 ════════════════

describe("framing helpers", () => {
  it("encodeDataFrame / parseDataFrame 來回一致", () => {
    const payload = Buffer.from([1, 2, 3, 4, 5]);
    const frame = encodeDataFrame(42, payload);
    const parsed = parseDataFrame(new Uint8Array(frame));
    expect(parsed).not.toBeNull();
    expect(parsed!.chunkIndex).toBe(42);
    expect(parsed!.payload.equals(payload)).toBe(true);
  });

  it("parseDataFrame 對非資料塊 / 過短 frame 回 null", () => {
    expect(parseDataFrame(new Uint8Array([0x02, 0, 0, 0, 0]))).toBeNull(); // RESUME 類型
    expect(parseDataFrame(new Uint8Array([0x01, 0, 0]))).toBeNull(); // 表頭不足
  });

  it("encodeManifestFrame / parseManifestFrame 來回一致", () => {
    const m: TransferManifest = {
      fileId: "rec-2026-0613-001",
      totalBytes: 12345,
      chunkSize: 512,
      encrypted: true,
    };
    const parsed = parseManifestFrame(new Uint8Array(encodeManifestFrame(m)));
    expect(parsed).toEqual(m);
  });
});

// ════════════════ 1. 順序送齊 ════════════════

describe("ResumableTransfer — 順序傳輸", () => {
  it("順序送齊所有塊 → 回正確完整 Buffer", async () => {
    const file = makeFile(1000);
    const chunkSize = 128;
    const chunks = sliceChunks(file, chunkSize);

    const t = new FakeBleTransport();
    await t.connect();
    const rt = new ResumableTransfer(t, { ackEvery: 4 });

    const manifest: TransferManifest = {
      fileId: "f1",
      totalBytes: file.length,
      chunkSize,
      encrypted: false,
    };
    const p = rt.receiveFile(manifest);

    // 依序推送
    for (let i = 0; i < chunks.length; i++) t.pushChunk(i, chunks[i]);

    const result = await p;
    expect(result.bytes).toBe(file.length);
    expect(result.data.equals(file)).toBe(true);
    expect(result.fileId).toBe("f1");

    // 有送過 ACK（節流）
    expect(t.sent.some((f) => f.type === FRAME_ACK)).toBe(true);
  });

  it("回報 progress 至 100%", async () => {
    const file = makeFile(500);
    const chunkSize = 100; // 5 塊
    const chunks = sliceChunks(file, chunkSize);
    const t = new FakeBleTransport();
    await t.connect();

    const progress: Array<[number, number]> = [];
    const rt = new ResumableTransfer(t, {
      onProgress: (r, tot) => progress.push([r, tot]),
    });
    const p = rt.receiveFile({ fileId: "f", totalBytes: file.length, chunkSize, encrypted: false });
    for (let i = 0; i < chunks.length; i++) t.pushChunk(i, chunks[i]);
    await p;

    expect(progress[progress.length - 1]).toEqual([5, 5]);
  });
});

// ════════════════ 2. 亂序 + 重複 ════════════════

describe("ResumableTransfer — 亂序與重複", () => {
  it("亂序 + 重複塊 → 正確重組、重複被忽略", async () => {
    const file = makeFile(1024);
    const chunkSize = 100; // 11 塊（最後一塊 24 bytes）
    const chunks = sliceChunks(file, chunkSize);
    expect(chunks.length).toBe(11);

    const t = new FakeBleTransport();
    await t.connect();
    const rt = new ResumableTransfer(t);
    const p = rt.receiveFile({ fileId: "f2", totalBytes: file.length, chunkSize, encrypted: false });

    // 打亂順序，並插入重複塊
    const order = [3, 0, 3, 7, 1, 2, 10, 10, 5, 4, 6, 0, 8, 9, 7];
    for (const i of order) t.pushChunk(i, chunks[i]);

    const result = await p;
    expect(result.data.equals(file)).toBe(true);
    expect(result.bytes).toBe(file.length);
  });

  it("最後一塊不足 chunkSize 也正確", async () => {
    const file = makeFile(257); // 257 = 2*128 + 1，最後一塊 1 byte
    const chunkSize = 128;
    const chunks = sliceChunks(file, chunkSize);
    expect(chunks.length).toBe(3);
    expect(chunks[2].length).toBe(1);

    const t = new FakeBleTransport();
    await t.connect();
    const rt = new ResumableTransfer(t);
    const p = rt.receiveFile({ fileId: "f", totalBytes: file.length, chunkSize, encrypted: false });
    for (let i = chunks.length - 1; i >= 0; i--) t.pushChunk(i, chunks[i]); // 反序
    const result = await p;
    expect(result.data.equals(file)).toBe(true);
  });
});

// ════════════════ 3. 斷線續傳 ════════════════

describe("ResumableTransfer — 斷線續傳", () => {
  it("送一半→斷線→重連→送出正確 RESUME→補齊→完整還原", async () => {
    const file = makeFile(2000);
    const chunkSize = 200; // 10 塊（0..9）
    const chunks = sliceChunks(file, chunkSize);
    expect(chunks.length).toBe(10);

    const t = new FakeBleTransport();
    await t.connect();

    // 裝置韌體模擬：收到 RESUME(from) → 從 from 起把剩餘塊全送上來。
    t.onResume = (from) => {
      t.restoreConnection(); // 確保推送通道已恢復
      for (let i = from; i < chunks.length; i++) t.pushChunk(i, chunks[i]);
    };

    const rt = new ResumableTransfer(t, { stallTimeoutMs: 5000 });
    const p = rt.receiveFile({ fileId: "f3", totalBytes: file.length, chunkSize, encrypted: false });

    // 送前 4 塊（0..3）
    for (let i = 0; i < 4; i++) t.pushChunk(i, chunks[i]);

    // 斷線（第 4 塊起遺失）
    t.dropConnection();

    // 等重連監看輪詢（500ms 間隔）觸發 connect → RESUME → 補送
    await p;

    // 驗證：曾送出 RESUME(4)，因為前 4 塊（0..3）已收，第一個缺口是 4
    const resumes = t.sent.filter((f) => f.type === FRAME_RESUME);
    expect(resumes.length).toBeGreaterThanOrEqual(1);
    expect(resumes[0].index).toBe(4);

    // 曾重連
    expect(t.connectCalls).toBeGreaterThanOrEqual(2);

    // 內容完整還原（後續以結果斷言）
    const result = await p;
    expect(result.data.equals(file)).toBe(true);
  });

  it("斷線後若一直無進展 → 逾時拋 IO_ERROR（不卡死）", async () => {
    const file = makeFile(800);
    const chunkSize = 200; // 4 塊
    const chunks = sliceChunks(file, chunkSize);

    const t = new FakeBleTransport();
    await t.connect();
    const rt = new ResumableTransfer(t, { stallTimeoutMs: 300 });
    const p = rt.receiveFile({ fileId: "f", totalBytes: file.length, chunkSize, encrypted: false });

    // 只送 1 塊就永久斷線，且重連也失敗
    t.pushChunk(0, chunks[0]);
    t.connectShouldSucceed = false;
    t.dropConnection();

    await expect(p).rejects.toMatchObject({ code: "IO_ERROR", message: "傳輸逾時" });
  });
});

// ════════════════ 4. 節流 ════════════════

describe("ResumableTransfer — 節流", () => {
  it("throttleMs 生效（背景節流不影響正確性，且確實變慢）", async () => {
    const file = makeFile(800);
    const chunkSize = 100; // 8 塊
    const chunks = sliceChunks(file, chunkSize);

    const t = new FakeBleTransport();
    await t.connect();
    const rt = new ResumableTransfer(t, { throttleMs: 20 });
    const start = Date.now();
    const p = rt.receiveFile({ fileId: "f4", totalBytes: file.length, chunkSize, encrypted: false });
    for (let i = 0; i < chunks.length; i++) t.pushChunk(i, chunks[i]);
    const result = await p;
    const elapsed = Date.now() - start;

    // 正確性
    expect(result.data.equals(file)).toBe(true);
    // 節流：8 塊 * 20ms ≈ 至少 100ms（保守下界，避免 CI 抖動誤判）
    expect(elapsed).toBeGreaterThanOrEqual(100);
  });

  it("setThrottle 可動態調整", async () => {
    const t = new FakeBleTransport();
    await t.connect();
    const rt = new ResumableTransfer(t);
    // 不丟錯即可（純驗 API 存在與不炸）
    rt.setThrottle(50);
    rt.setThrottle(0);
    expect(true).toBe(true);
  });
});

// ════════════════ BluetoothHardwareSource 端到端 ════════════════

/** 用與 SecurityManager 相同格式加密成記憶體 Buffer（測解密路徑）。 */
function encryptBuffer(plain: Buffer, secretKey: string, salt: string): Buffer {
  const MAGIC = Buffer.from("PRV1", "ascii");
  const key = scryptSync(secretKey, salt, 32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  key.fill(0);
  return Buffer.concat([MAGIC, iv, tag, enc]);
}

/**
 * 真實時序模擬：裝置先發 MANIFEST，PC 端處理（佇列推進、receiveFile 註冊好資料塊
 * onData）後，裝置才開始送資料塊。測試裡 MANIFEST 與塊不能同步連發（onData 尚未
 * 切換），故等 src.status().transferring 為 true 再推塊。
 */
async function pushFileWhenReady(
  t: FakeBleTransport,
  src: BluetoothHardwareSource,
  manifest: TransferManifest,
  chunks: Buffer[],
): Promise<void> {
  t.pushRaw(new Uint8Array(encodeManifestFrame(manifest)));
  await vi.waitFor(() => expect(src.status().transferring).toBe(true), { timeout: 2000 });
  for (let i = 0; i < chunks.length; i++) t.pushChunk(i, chunks[i]);
}

describe("BluetoothHardwareSource — 端到端檔案同步", () => {
  it("明文檔：MANIFEST→傳輸→onFileSynced 拿到正確 Buffer", async () => {
    const file = makeFile(900);
    const chunkSize = 128;
    const chunks = sliceChunks(file, chunkSize);

    const t = new FakeBleTransport();
    const synced: Array<{ fileId: string; data: Buffer }> = [];
    const src = new BluetoothHardwareSource({
      transport: t,
      onFileSynced: (f) => synced.push(f),
    });

    await src.startStream();
    expect(src.streaming).toBe(true);

    const manifest: TransferManifest = {
      fileId: "rec1",
      totalBytes: file.length,
      chunkSize,
      encrypted: false,
    };
    // 推送 MANIFEST → 等傳輸就緒（onData 切成資料塊 handler）→ 推送資料塊
    await pushFileWhenReady(t, src, manifest, chunks);

    // 等佇列處理完成
    await vi.waitFor(() => expect(synced.length).toBe(1), { timeout: 2000 });

    expect(synced[0].fileId).toBe("rec1");
    expect(synced[0].data.equals(file)).toBe(true);

    const st = src.status();
    expect(st.connected).toBe(true);
    expect(st.progress).toBe(1);

    await src.stopStream();
    expect(src.streaming).toBe(false);
  });

  it("加密檔：傳完自動解密成明文交給 onFileSynced", async () => {
    const secretKey = "test-secret-key";
    const salt = "test-salt-value";
    const plain = makeFile(640);
    const blob = encryptBuffer(plain, secretKey, salt);
    const chunkSize = 100;
    const chunks = sliceChunks(blob, chunkSize);

    const t = new FakeBleTransport();
    const synced: Array<{ fileId: string; data: Buffer }> = [];
    const src = new BluetoothHardwareSource({
      transport: t,
      secretKey,
      encryptionSalt: salt,
      onFileSynced: (f) => synced.push(f),
    });
    await src.startStream();

    const manifest: TransferManifest = {
      fileId: "enc1",
      totalBytes: blob.length,
      chunkSize,
      encrypted: true,
    };
    await pushFileWhenReady(t, src, manifest, chunks);

    await vi.waitFor(() => expect(synced.length).toBe(1), { timeout: 2000 });
    // 解密後應等於原始明文（而非密文）
    expect(synced[0].data.equals(plain)).toBe(true);

    await src.stopStream();
  });

  it("setPriority background → 傳輸仍正確（節流不破壞內容）", async () => {
    const file = makeFile(600);
    const chunkSize = 100;
    const chunks = sliceChunks(file, chunkSize);

    const t = new FakeBleTransport();
    const synced: Array<{ fileId: string; data: Buffer }> = [];
    const src = new BluetoothHardwareSource({ transport: t, onFileSynced: (f) => synced.push(f) });
    await src.startStream();
    src.setPriority("background");
    expect(src.status().priority).toBe("background");

    await pushFileWhenReady(t, src, {
      fileId: "bg",
      totalBytes: file.length,
      chunkSize,
      encrypted: false,
    }, chunks);

    await vi.waitFor(() => expect(synced.length).toBe(1), { timeout: 3000 });
    expect(synced[0].data.equals(file)).toBe(true);

    await src.stopStream();
  });
});
