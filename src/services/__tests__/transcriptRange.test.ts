import { describe, it, expect } from "vitest";
import {
  lineMinute,
  lastMinuteOf,
  filterTranscriptByRange,
  parseRanges,
  formatRanges,
  filterTranscriptByRanges,
} from "../../shared/transcriptRange";

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

  describe("多段", () => {
    it("parseRanges：解析多段、單一分鐘、起迄顛倒正規化、忽略雜訊", () => {
      expect(parseRanges("1-3, 5-7, 10-12")).toEqual([[1, 3], [5, 7], [10, 12]]);
      expect(parseRanges("5~15")).toEqual([[5, 15]]);
      expect(parseRanges("8")).toEqual([[8, 8]]);
      expect(parseRanges("7-5")).toEqual([[5, 7]]); // 顛倒
      expect(parseRanges("1-3、abc、5-7")).toEqual([[1, 3], [5, 7]]); // 頓號 + 忽略 abc
      expect(parseRanges("  ")).toEqual([]);
    });

    it("formatRanges：可讀字串", () => {
      expect(formatRanges([[1, 3], [5, 7], [10, 12]])).toBe("1–3, 5–7, 10–12 分");
      expect(formatRanges([[8, 8]])).toBe("8 分");
      expect(formatRanges([])).toBe("");
    });

    it("filterTranscriptByRanges：取多段聯集（0、1、30 三段各命中一句）", () => {
      const out = filterTranscriptByRanges(T, [[0, 0], [1, 1], [30, 30]]);
      expect(out).toBe(
        "[00:05] A: 開場\n[00:40] A: 還在第0分\n[01:10] B: 第1分\n[30:46] A: 三十分這句很長\n續句沒有時間戳",
      );
    });

    it("filterTranscriptByRanges：空區間回空字串", () => {
      expect(filterTranscriptByRanges(T, [])).toBe("");
    });
  });
});
