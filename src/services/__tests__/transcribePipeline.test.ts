import { describe, it, expect, vi } from "vitest";
import { shiftTimestamps, transcribeChunked, mmss, type ChunkTranscriber } from "../transcribePipeline";
import { wrapPcmAsWav } from "../wavChunk";

/** 造一段指定資料位元組數的 16kHz 單聲道 PCM16 WAV。 */
function makeWav(dataBytes: number): Buffer {
  return wrapPcmAsWav(Buffer.alloc(dataBytes), 16000, 1, 16);
}

describe("mmss", () => {
  it("分鐘可超過 59（長錄音接合用）", () => {
    expect(mmss(65)).toBe("01:05");
    expect(mmss(3783)).toBe("63:03");
    expect(mmss(-5)).toBe("00:00");
  });
});

describe("shiftTimestamps", () => {
  it("offset=0 原封不動", () => {
    const t = "[00:05] 發言人1: hi";
    expect(shiftTimestamps(t, 0)).toBe(t);
  });

  it("位移 mm:ss 時間戳", () => {
    expect(shiftTimestamps("[00:05] 發言人1: hi", 300)).toBe("[05:05] 發言人1: hi");
  });

  it("位移 h:mm:ss 時間戳（輸出改 mm:ss，分鐘可超過 59）", () => {
    expect(shiftTimestamps("[01:02:03] 發言人: x", 60)).toBe("[63:03] 發言人: x");
  });

  it("沒有時間戳的行不動、多行各自位移", () => {
    const input = "備註：這行沒有時間戳\n[00:10] 發言人1: Hello（哈囉）";
    const out = shiftTimestamps(input, 5);
    expect(out).toBe("備註：這行沒有時間戳\n[00:15] 發言人1: Hello（哈囉）");
  });
});

describe("transcribeChunked", () => {
  it("單段、主力成功：回主力結果、進度回報一次", async () => {
    const primary: ChunkTranscriber = vi.fn(async () => "[00:01] 發言人: A");
    const onProgress = vi.fn();
    const out = await transcribeChunked(makeWav(1000), "auto", { primary, onProgress });
    expect(out).toBe("[00:01] 發言人: A");
    expect(primary).toHaveBeenCalledTimes(1);
    // 開頭先發 0/1 讓進度條立刻出現，做完再發 1/1（清掉）。
    expect(onProgress).toHaveBeenNthCalledWith(1, 0, 1);
    expect(onProgress).toHaveBeenNthCalledWith(2, 1, 1);
  });

  it("多段：某段主力失敗 → per-chunk 後援接手，時間戳位移接回", async () => {
    // chunkBytes = 44 + 32000 → 每段 32000 bytes（1 秒）；資料 64000 bytes → 切 2 段（start 0s / 1s）。
    const wav = makeWav(64000);
    let n = 0;
    const primary: ChunkTranscriber = vi.fn(async () => {
      n += 1;
      if (n === 2) throw new Error("primary 第二段掛了");
      return "[00:01] 發言人: 主力";
    });
    const fallback: ChunkTranscriber = vi.fn(async () => "[00:00] 發言人: 後援");
    const onProgress = vi.fn();
    const out = await transcribeChunked(wav, "auto", {
      primary,
      fallback,
      chunkBytes: 44 + 32000,
      concurrency: 1, // 依序才好斷言「第二段」失敗
      onProgress,
    });
    const lines = out.split("\n");
    expect(lines[0]).toBe("[00:01] 發言人: 主力"); // 第一段 start 0
    expect(lines[1]).toBe("[00:01] 發言人: 後援"); // 第二段 start 1s → [00:00] 位移成 [00:01]
    expect(fallback).toHaveBeenCalledTimes(1);
    // 開頭 0/2 → 第一段完 1/2 → 第二段完 2/2。
    expect(onProgress).toHaveBeenNthCalledWith(1, 0, 2);
    expect(onProgress).toHaveBeenNthCalledWith(2, 1, 2);
    expect(onProgress).toHaveBeenNthCalledWith(3, 2, 2);
  });

  it("多段並行：結果依原始順序接回、每段各自轉錄", async () => {
    const wav = makeWav(96000); // chunkBytes 32000 → 3 段（start 0/1/2s）
    const primary: ChunkTranscriber = vi.fn(async () => "[00:00] 發言人: X");
    const onProgress = vi.fn();
    const out = await transcribeChunked(wav, "auto", {
      primary,
      chunkBytes: 44 + 32000,
      concurrency: 3,
      onProgress,
    });
    // 三段各自位移：start 0/1/2 → [00:00]/[00:01]/[00:02]，順序不受完成先後影響。
    expect(out.split("\n")).toEqual(["[00:00] 發言人: X", "[00:01] 發言人: X", "[00:02] 發言人: X"]);
    expect(primary).toHaveBeenCalledTimes(3);
    expect(onProgress).toHaveBeenCalledWith(0, 3); // 開頭
    expect(onProgress).toHaveBeenLastCalledWith(3, 3); // 收尾（清進度條）
  });

  it("某段主力失敗又沒後援 → 補缺漏標記、不拖垮整檔", async () => {
    const wav = makeWav(64000);
    let n = 0;
    const primary: ChunkTranscriber = vi.fn(async () => {
      n += 1;
      if (n === 2) throw new Error("第二段掛了");
      return "[00:01] 發言人: 好的";
    });
    const out = await transcribeChunked(wav, "auto", {
      primary,
      chunkBytes: 44 + 32000,
      concurrency: 1,
    });
    expect(out).toContain("[00:01] 發言人: 好的");
    expect(out).toContain("（此段轉錄失敗，未取得內容）");
  });

  it("全部段皆失敗 → 拋錯", async () => {
    const primary: ChunkTranscriber = vi.fn(async () => {
      throw new Error("全掛");
    });
    const fallback: ChunkTranscriber = vi.fn(async () => {
      throw new Error("後援也掛");
    });
    await expect(
      transcribeChunked(makeWav(1000), "auto", { primary, fallback }),
    ).rejects.toThrow(/皆轉錄失敗/);
  });
});
