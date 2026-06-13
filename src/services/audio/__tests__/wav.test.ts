// ════════════════════════════════════════════════════════════════════
//  WavEncoder 單元測試（vitest）
//  純邏輯、無外部相依，可直接實跑。驗證 RIFF/WAVE 標頭欄位、data 長度、
//  Float32→Int16 的 clamp 與取樣率/聲道/位元欄位。
// ════════════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";

import { encodeWavPcm16 } from "../WavEncoder";

/** 從 WAV Buffer 的標頭讀出常用欄位，方便斷言。 */
function readHeader(buf: Buffer) {
  return {
    riff: buf.toString("ascii", 0, 4),
    chunkSize: buf.readUInt32LE(4),
    wave: buf.toString("ascii", 8, 12),
    fmt: buf.toString("ascii", 12, 16),
    subchunk1Size: buf.readUInt32LE(16),
    audioFormat: buf.readUInt16LE(20),
    numChannels: buf.readUInt16LE(22),
    sampleRate: buf.readUInt32LE(24),
    byteRate: buf.readUInt32LE(28),
    blockAlign: buf.readUInt16LE(32),
    bitsPerSample: buf.readUInt16LE(34),
    data: buf.toString("ascii", 36, 40),
    dataSize: buf.readUInt32LE(40),
  };
}

describe("encodeWavPcm16", () => {
  it("case 1：標頭欄位正確（RIFF/WAVE/fmt /data 與 fmt 內容）", () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const sampleRate = 16_000;
    const buf = encodeWavPcm16(samples, sampleRate);
    const h = readHeader(buf);

    // 魔術字
    expect(h.riff).toBe("RIFF");
    expect(h.wave).toBe("WAVE");
    expect(h.fmt).toBe("fmt ");
    expect(h.data).toBe("data");

    // fmt 內容：PCM / mono / 16-bit / 16kHz
    expect(h.subchunk1Size).toBe(16);
    expect(h.audioFormat).toBe(1);
    expect(h.numChannels).toBe(1);
    expect(h.sampleRate).toBe(sampleRate);
    expect(h.bitsPerSample).toBe(16);
    expect(h.blockAlign).toBe(2); // mono * 16bit/8
    expect(h.byteRate).toBe(sampleRate * 2); // sampleRate * blockAlign

    // 長度欄位
    const expectedDataSize = samples.length * 2;
    expect(h.dataSize).toBe(expectedDataSize);
    expect(h.chunkSize).toBe(36 + expectedDataSize);
    // 整個 Buffer = 44 標頭 + data
    expect(buf.length).toBe(44 + expectedDataSize);
  });

  it("case 2：data 區長度 = samples*2，且 Float32→Int16 值正確", () => {
    const samples = new Float32Array([0, 0.5, -0.5]);
    const buf = encodeWavPcm16(samples, 16_000);

    // data 區從 byte 44 起
    expect(buf.length - 44).toBe(samples.length * 2);

    expect(buf.readInt16LE(44)).toBe(0); // 0
    expect(buf.readInt16LE(46)).toBe(Math.round(0.5 * 32767)); // 16384（四捨五入後）
    expect(buf.readInt16LE(48)).toBe(Math.round(-0.5 * 32767)); // -16384
  });

  it("case 3：clamp — 超出 ±1 的值被夾到 ±32767，NaN/Inf 視為靜音 0", () => {
    const samples = new Float32Array([2, -2, 1.0001, -1.0001, NaN, Infinity, -Infinity]);
    const buf = encodeWavPcm16(samples, 16_000);

    expect(buf.readInt16LE(44)).toBe(32767); // 2   → clamp 1  → 32767
    expect(buf.readInt16LE(46)).toBe(-32767); // -2  → clamp -1 → -32767
    expect(buf.readInt16LE(48)).toBe(32767); // 1.0001 → 32767
    expect(buf.readInt16LE(50)).toBe(-32767); // -1.0001 → -32767
    expect(buf.readInt16LE(52)).toBe(0); // NaN → 0
    expect(buf.readInt16LE(54)).toBe(0); // Infinity → 0
    expect(buf.readInt16LE(56)).toBe(0); // -Infinity → 0
  });

  it("case 4：空樣本只產出 44 byte 標頭，dataSize=0", () => {
    const buf = encodeWavPcm16(new Float32Array(0), 44_100);
    const h = readHeader(buf);

    expect(buf.length).toBe(44);
    expect(h.dataSize).toBe(0);
    expect(h.chunkSize).toBe(36);
    expect(h.sampleRate).toBe(44_100);
  });

  it("case 5：非法取樣率拋 RangeError", () => {
    expect(() => encodeWavPcm16(new Float32Array([0]), 0)).toThrow(RangeError);
    expect(() => encodeWavPcm16(new Float32Array([0]), -1)).toThrow(RangeError);
    expect(() => encodeWavPcm16(new Float32Array([0]), Number.NaN)).toThrow(RangeError);
  });
});
