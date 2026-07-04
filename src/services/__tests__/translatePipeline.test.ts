import { describe, it, expect, vi } from "vitest";
import { translateChunked, type LineTranslator } from "../translatePipeline";

describe("translateChunked", () => {
  it("短逐字稿 → 單批（一次呼叫）", async () => {
    const translate: LineTranslator = vi.fn(async (t) => t + "(EN)");
    const out = await translateChunked(translate, "[00:00] A: 你好", "en", { chunkChars: 100 });
    expect(translate).toHaveBeenCalledTimes(1);
    expect(out).toBe("[00:00] A: 你好(EN)");
  });

  it("長逐字稿 → 逐批翻、每一行都在、依原順序接回", async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `[${String(i).padStart(2, "0")}:00] A: 內容${i}`);
    const text = lines.join("\n");
    // 每批把收到的整段標記為已翻（原文照回＋標記），驗證所有行都被涵蓋且順序不變
    const translate: LineTranslator = vi.fn(async (t) => t);
    const out = await translateChunked(translate, text, "en", { chunkChars: 40, concurrency: 3 });
    expect((translate as any).mock.calls.length).toBeGreaterThan(1); // 有切多批
    const outLines = out.split("\n");
    expect(outLines).toHaveLength(20); // 一行都沒少
    expect(outLines[0]).toBe(lines[0]); // 順序不變
    expect(outLines[19]).toBe(lines[19]);
  });

  it("某批翻譯失敗 → 保留該批原文、不丟整份", async () => {
    const lines = Array.from({ length: 12 }, (_, i) => `[${String(i).padStart(2, "0")}:00] A: 行${i}`);
    const text = lines.join("\n");
    const translate: LineTranslator = vi.fn(async (t) => {
      if (t.includes("行5")) throw new Error("這批掛了");
      return t + " [OK]";
    });
    const out = await translateChunked(translate, text, "en", { chunkChars: 30, concurrency: 1 });
    expect(out).toContain("行5"); // 失敗批的原文仍在
    expect(out).toContain("[OK]"); // 其他批照常翻
    expect(out.split("\n")).toHaveLength(12); // 行數不變
  });
});
