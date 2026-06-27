import { describe, it, expect } from "vitest";
import { formatWhisperSegments } from "../GroqLlmService";

describe("formatWhisperSegments（Groq Whisper 後援轉錄格式化）", () => {
  it("把 segments 轉成 `[mm:ss] 發言人: 內容` 逐行、收掉前後空白", () => {
    const out = formatWhisperSegments([
      { start: 0, text: " 大家好" },
      { start: 65.4, text: "開始開會 " },
    ]);
    expect(out).toBe("[00:00] 發言人: 大家好\n[01:05] 發言人: 開始開會");
  });

  it("略過空白/缺文字的片段", () => {
    const out = formatWhisperSegments([
      { start: 1, text: "  " },
      { start: 2 },
      { start: 3, text: "嗨" },
    ]);
    expect(out).toBe("[00:03] 發言人: 嗨");
  });

  it("start 缺值或負值視為 0；分鐘正確進位", () => {
    const out = formatWhisperSegments([
      { text: "甲" },
      { start: -5, text: "乙" },
      { start: 600, text: "丙" },
    ]);
    expect(out).toBe("[00:00] 發言人: 甲\n[00:00] 發言人: 乙\n[10:00] 發言人: 丙");
  });

  it("無 segments 回空字串（讓上層退回 data.text 或報空）", () => {
    expect(formatWhisperSegments([])).toBe("");
  });
});
