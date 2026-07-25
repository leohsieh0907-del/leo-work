import { describe, it, expect } from "vitest";
import { lineMinute, lastMinuteOf, filterTranscriptByRange } from "../../shared/transcriptRange";

describe("transcriptRange（時段裁切）", () => {
  const T = [
    "[00:05] A: 開場",
    "[00:40] A: 還在第0分",
    "[01:10] B: 第1分",
    "[30:46] A: 三十分這句很長",
    "續句沒有時間戳", // 沿用 30 分
    "[45:59] B: 第45分尾",
    "[143:02] A: 很後面",
  ].join("\n");

  it("lineMinute：解析分鐘（含 >59 的總分鐘）、無時間戳回 null", () => {
    expect(lineMinute("[30:46] A: x")).toBe(30);
    expect(lineMinute("[143:02] A: x")).toBe(143);
    expect(lineMinute("續句沒有時間戳")).toBeNull();
  });

  it("lastMinuteOf：取最後時間戳分鐘；全無時間戳回 0", () => {
    expect(lastMinuteOf(T)).toBe(143);
    expect(lastMinuteOf("沒有任何時間戳")).toBe(0);
  });

  it("裁 [0,1]：含第 0、第 1 分整分", () => {
    expect(filterTranscriptByRange(T, 0, 1).split("\n")).toEqual([
      "[00:05] A: 開場",
      "[00:40] A: 還在第0分",
      "[01:10] B: 第1分",
    ]);
  });

  it("裁 [30,30]：續句沿用上一行時間一併保留", () => {
    expect(filterTranscriptByRange(T, 30, 30)).toBe("[30:46] A: 三十分這句很長\n續句沒有時間戳");
  });

  it("起迄顛倒自動正規化；尾端整分(45:59) 含入", () => {
    expect(filterTranscriptByRange(T, 45, 45)).toBe("[45:59] B: 第45分尾");
    expect(filterTranscriptByRange(T, 45, 30)).toBe(
      "[30:46] A: 三十分這句很長\n續句沒有時間戳\n[45:59] B: 第45分尾",
    );
  });

  it("範圍內無內容回空字串（供上層擋下）", () => {
    expect(filterTranscriptByRange(T, 200, 300)).toBe("");
  });
});
