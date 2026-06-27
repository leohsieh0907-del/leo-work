import { describe, it, expect } from "vitest";
import { parseWavPcm, wrapPcmAsWav, chunkWavByBytes } from "../wavChunk";

const RATE = 16_000; // 16kHz 單聲道 16-bit → 32 bytes/ms，32000 bytes/s

/** 產生 seconds 秒的假 PCM16（每 frame 值遞增，方便驗證切片內容連續）。 */
function fakePcm(seconds: number): Buffer {
  const frames = RATE * seconds;
  const buf = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) buf.writeInt16LE((i % 30000) - 15000, i * 2);
  return buf;
}

describe("wavChunk", () => {
  it("wrapPcmAsWav + parseWavPcm round-trip 保留格式與資料", () => {
    const pcm = fakePcm(1);
    const wav = wrapPcmAsWav(pcm, RATE, 1, 16);
    expect(wav.length).toBe(44 + pcm.length);
    const parsed = parseWavPcm(wav);
    expect(parsed).not.toBeNull();
    expect(parsed!.sampleRate).toBe(RATE);
    expect(parsed!.numChannels).toBe(1);
    expect(parsed!.bitsPerSample).toBe(16);
    expect(parsed!.data.equals(pcm)).toBe(true);
  });

  it("非 WAV / 壞檔回 null", () => {
    expect(parseWavPcm(Buffer.from("not a wav at all"))).toBeNull();
    expect(parseWavPcm(Buffer.alloc(4))).toBeNull();
  });

  it("檔案在上限內 → 單一段、startSec=0、原 buffer", () => {
    const wav = wrapPcmAsWav(fakePcm(2), RATE, 1, 16);
    const chunks = chunkWavByBytes(wav, 10 * 1024 * 1024);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].startSec).toBe(0);
    expect(chunks[0].wav).toBe(wav);
  });

  it("超過上限 → 切多段、每段可解析、startSec 遞增且資料無縫接合", () => {
    const pcm = fakePcm(10); // 10 秒 = 320,000 bytes 資料
    const wav = wrapPcmAsWav(pcm, RATE, 1, 16);
    // 上限設約 4 秒（含 header）：128KB → 每段資料約 4 秒
    const maxBytes = 44 + RATE * 4 * 2;
    const chunks = chunkWavByBytes(wav, maxBytes);
    expect(chunks.length).toBeGreaterThan(1);

    // 每段都是合法 WAV，且每段 <= 上限
    let rebuilt = Buffer.alloc(0);
    let expectStart = 0;
    for (const c of chunks) {
      expect(c.wav.length).toBeLessThanOrEqual(maxBytes);
      const p = parseWavPcm(c.wav)!;
      expect(p).not.toBeNull();
      expect(c.startSec).toBeCloseTo(expectStart, 5);
      expectStart += p.data.length / (RATE * 2);
      rebuilt = Buffer.concat([rebuilt, p.data]);
    }
    // 把各段 PCM 接回來 = 原始 PCM（切片無損、無重疊無遺漏）
    expect(rebuilt.equals(pcm)).toBe(true);
  });

  it("切點對齊 frame（不會切在半個 sample 上）", () => {
    const wav = wrapPcmAsWav(fakePcm(6), RATE, 1, 16);
    const chunks = chunkWavByBytes(wav, 44 + 12345); // 故意給非 frame 對齊的上限
    for (const c of chunks.slice(0, -1)) {
      expect((c.wav.length - 44) % 2).toBe(0); // 每段資料位元組為偶數（16-bit frame）
    }
  });
});
