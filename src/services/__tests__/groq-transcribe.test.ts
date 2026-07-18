import { describe, it, expect } from "vitest";
import { formatWhisperSegments, hasLatinText, parseGroqRetryMs } from "../GroqLlmService";

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

describe("hasLatinText（auto 模式是否需補中譯的粗判）", () => {
  it("含英文詞 → true（會觸發雙語標註）", () => {
    expect(hasLatinText("[00:05] 發言人: Let's ship it next week.")).toBe(true);
    expect(hasLatinText("這是 API 的說明")).toBe(true);
  });
  it("全中文/無拉丁詞 → false（省一次 API）", () => {
    expect(hasLatinText("[00:05] 發言人: 我們下週上線")).toBe(false);
    expect(hasLatinText("純中文沒有英文")).toBe(false);
  });
});

describe("parseGroqRetryMs（Groq 429 建議重試秒數解析）", () => {
  const r = (body: unknown, headers?: Record<string, string>) =>
    new Response(JSON.stringify(body), { status: 429, headers });

  it("讀訊息「try again in 7.79s」→ 7790ms（TPM 窗口，短等待可等它過去）", async () => {
    const resp = r({ error: { message: "Rate limit reached ... Please try again in 7.79s. Need more tokens?" } });
    expect(await parseGroqRetryMs(resp)).toBe(7790);
  });

  it("無訊息秒數時退讀 retry-after 標頭（秒）", async () => {
    expect(await parseGroqRetryMs(r({ error: { message: "rate limited" } }, { "retry-after": "8" }))).toBe(8000);
  });

  it("訊息秒數優先於標頭（訊息較精確）", async () => {
    const resp = r({ error: { message: "try again in 3.2s" } }, { "retry-after": "9" });
    expect(await parseGroqRetryMs(resp)).toBe(3200);
  });

  it("都沒有 → null（改用一般退避）", async () => {
    expect(await parseGroqRetryMs(r({ error: { message: "boom" } }))).toBeNull();
  });

  it("clone 讀 body，不消費原 Response（上層仍可讀錯誤訊息）", async () => {
    const resp = r({ error: { message: "try again in 5s" } });
    await parseGroqRetryMs(resp);
    const data = (await resp.json()) as { error?: { message?: string } };
    expect(data.error?.message).toContain("try again in 5s");
  });
});
