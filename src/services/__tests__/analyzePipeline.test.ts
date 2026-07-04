import { describe, it, expect, vi } from "vitest";
import { splitTranscript, analyzeTranscript, type AnalyzeResult } from "../analyzePipeline";

describe("splitTranscript", () => {
  it("短文字 → 單一段", () => {
    expect(splitTranscript("一行\n兩行", 100)).toEqual(["一行\n兩行"]);
  });

  it("依行邊界切段、不切斷行", () => {
    const text = ["[00:00] A: 1234", "[00:05] B: 5678", "[00:10] C: 9012"].join("\n");
    const chunks = splitTranscript(text, 18); // 每段約放得下 1 行
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.join("\n")).toBe(text); // 內容不遺失、順序不變
    expect(chunks.every((c) => c.includes("["))).toBe(true);
  });
});

describe("analyzeTranscript", () => {
  const partial = (theme: string, kp: string, task: string): AnalyzeResult => ({
    analysis: { theme, key_summary: [kp], historical_conflicts: [] },
    actionItems: [{ task, assignee: "未指定", deadline: "未指定" }],
  });

  it("短逐字稿 → 單次分析（不 map-reduce）", async () => {
    const analyzeAll = vi.fn(async () => partial("主題", "重點", "待辦"));
    const out = await analyzeTranscript({ analyzeAll }, "短短的一段", "", { singleMaxChars: 100 });
    expect(analyzeAll).toHaveBeenCalledTimes(1);
    expect(out.analysis.theme).toBe("主題");
  });

  // 每段做成「長輸入」（>chunkChars），但摘要很短 → reduceInput 遠小於 singleMax，單層 reduce 收斂。
  const longLine = (marker: string, filler: string) => `[00:00] ${marker}: ` + filler.repeat(200);

  it("長逐字稿 → map 每段 + reduce 合併；行動方針聯集去重", async () => {
    // reduce 呼叫的輸入含「【第」標記 → 用來區分 map / reduce。
    const analyzeAll = vi.fn(async (t: string): Promise<AnalyzeResult> => {
      if (t.includes("【第")) {
        return {
          analysis: { theme: "整合主題", key_summary: ["整合重點"], historical_conflicts: ["整合衝突"] },
          actionItems: [{ task: "共同待辦", assignee: "A", deadline: "未指定" }],
        };
      }
      // map：依內容給不同待辦；讓其中兩段有相同待辦以驗證去重。
      if (t.includes("aaa")) return partial("段1", "重點1", "共同待辦");
      if (t.includes("bbb")) return partial("段2", "重點2", "待辦2");
      return partial("段3", "重點3", "待辦3");
    });

    const text = [longLine("aaa", "甲"), longLine("bbb", "乙"), longLine("ccc", "丙")].join("\n");
    const out = await analyzeTranscript({ analyzeAll }, text, "歷史背景", {
      singleMaxChars: 300, // 原文 ~650 > 300 → 觸發；摘要 reduceInput ~120 < 300 → 單層 reduce
      chunkChars: 250,
    });

    // 3 段 map + 1 reduce = 4 次
    expect(analyzeAll).toHaveBeenCalledTimes(4);
    // 最終主題/衝突來自 reduce
    expect(out.analysis.theme).toBe("整合主題");
    expect(out.analysis.historical_conflicts).toContain("整合衝突");
    // 行動方針：3 段(其中一個與 reduce 同為「共同待辦」)→ 去重後不重覆
    const tasks = out.actionItems.map((a) => a.task);
    expect(tasks).toContain("共同待辦");
    expect(tasks).toContain("待辦2");
    expect(tasks).toContain("待辦3");
    expect(tasks.filter((t) => t === "共同待辦")).toHaveLength(1); // 去重
  });

  it("reduce 帶 historicalContext；map 段不帶", async () => {
    const seenHist: string[] = [];
    const analyzeAll = vi.fn(async (t: string, hist: string): Promise<AnalyzeResult> => {
      seenHist.push(hist);
      if (t.includes("【第")) return partial("整合", "r", "rt");
      return partial("段", "k", "at");
    });
    const text = [longLine("aaa", "甲"), longLine("bbb", "乙")].join("\n");
    await analyzeTranscript({ analyzeAll }, text, "跨會議記憶", {
      singleMaxChars: 300,
      chunkChars: 250,
    });
    // map 段的 hist 皆為空、reduce 那次才帶入「跨會議記憶」
    expect(seenHist).toContain("跨會議記憶");
    expect(seenHist.filter((h) => h === "").length).toBeGreaterThanOrEqual(2);
  });
});
