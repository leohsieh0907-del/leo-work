import { describe, it, expect } from "vitest";
import { selectRelevantContext, queryTerms } from "../relevance";

describe("queryTerms", () => {
  it("抽 CJK 2/3-gram 與 ASCII 詞", () => {
    const terms = queryTerms("分析 TSMC 資本支出");
    expect(terms).toContain("tsmc");
    expect(terms).toContain("資本");
    expect(terms).toContain("資本支"); // 3-gram
    expect(terms).toContain("支出");
  });
});

describe("selectRelevantContext", () => {
  it("短逐字稿原樣回傳", () => {
    const t = "[00:00] A: 你好\n[00:05] B: 再見";
    expect(selectRelevantContext(t, "任何問題", 1000)).toBe(t);
  });

  it("長逐字稿只留與問題相關的行（保留原順序與時間戳）", () => {
    const lines: string[] = [];
    for (let i = 0; i < 200; i++) {
      const mm = String(i).padStart(2, "0");
      // 只有少數行提到「資本支出」，其餘是雜訊
      lines.push(i === 40 || i === 120 ? `[${mm}:00] 講者: 台積電資本支出今年增加` : `[${mm}:00] 講者: 其他無關內容${i}`);
    }
    const t = lines.join("\n");
    expect(t.length).toBeGreaterThan(2000);

    const out = selectRelevantContext(t, "台積電資本支出趨勢", 800);
    expect(out.length).toBeLessThanOrEqual(800);
    // 兩行相關內容都被選中
    expect(out).toContain("[40:00]");
    expect(out).toContain("[120:00]");
    expect(out).toContain("資本支出");
    // 保留原順序：40 在 120 之前
    expect(out.indexOf("[40:00]")).toBeLessThan(out.indexOf("[120:00]"));
  });

  it("問題無關鍵詞命中 → 均勻取樣（仍回內容、不超長）", () => {
    const lines = Array.from({ length: 300 }, (_, i) => `[${String(i).padStart(2, "0")}:00] 講者: 內容行${i}`);
    const out = selectRelevantContext(lines.join("\n"), "xyz123不存在的詞", 600);
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThanOrEqual(600);
    expect(out).toContain("[00:00]"); // 從頭開始取樣
  });
});
