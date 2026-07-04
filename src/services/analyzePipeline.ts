// 長逐字稿分析 map-reduce：整份太長時（單次會撞 Groq 每分鐘 token 上限），
// 先「分段各自摘要」(map，並行、每段夠小任一供應商都吃得下) → 再「合併成最終分析」(reduce)。
// reduce 輸入還太長時階層式再 reduce（summaries 遠小於原文，很快收斂）。
//
// 純函式、與供應商解耦（analyzeAll 由呼叫端注入，通常是 FallbackLlmService＝Gemini 主力→Groq 後援）→ 可單元測試。

import type { ProactiveAnalysis, ActionItem } from "../shared/types";

export interface AnalyzeResult {
  analysis: ProactiveAnalysis;
  actionItems: ActionItem[];
}

/** 分析一段文字（主題/重點/衝突/行動方針）。Gemini 與 Groq 皆實作。 */
export interface AnalyzeLike {
  analyzeAll(transcript: string, historicalContext: string): Promise<AnalyzeResult>;
}

export interface AnalyzeChunkedOpts {
  /** ≤ 此字數直接單次分析（保留短會議原行為）。 */
  singleMaxChars?: number;
  /** 超過時每段字數上限（要小到 Groq 單次吃得下）。 */
  chunkChars?: number;
  /** map 並行段數。 */
  concurrency?: number;
}

// 6000 字以內單次分析；超過切 5000 字/段（中文約 1~1.6 token/字，留安全邊際壓在 Groq 12000 TPM 內）。
const SINGLE_MAX_CHARS = 6000;
const CHUNK_CHARS = 5000;
const CONCURRENCY = 3;

/** 依行邊界把長逐字稿切成 ≤maxChars 的段（不切斷 `[mm:ss]` 行）。 */
export function splitTranscript(text: string, maxChars: number): string[] {
  const lines = text.split("\n");
  const chunks: string[] = [];
  let cur = "";
  for (const line of lines) {
    const candidate = cur ? cur + "\n" + line : line;
    if (candidate.length > maxChars && cur) {
      chunks.push(cur);
      cur = line; // 單行本身就超長 → 下一輪自成一段
    } else {
      cur = candidate;
    }
  }
  if (cur.trim()) chunks.push(cur);
  return chunks.length ? chunks : [text];
}

/** 行動方針去重（依正規化後的 task 文字）。 */
function dedupeActionItems(items: ActionItem[]): ActionItem[] {
  const seen = new Set<string>();
  const out: ActionItem[] = [];
  for (const it of items) {
    const key = (it.task ?? "").trim().toLowerCase().replace(/\s+/g, "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

/** 把一段的摘要壓成精簡文字（給 reduce 用，控制長度避免 reduce 又太大）。 */
function formatPartial(p: AnalyzeResult, i: number): string {
  const kp = p.analysis.key_summary.slice(0, 6).map((s) => "・" + s).join("\n");
  const cf = p.analysis.historical_conflicts.slice(0, 4).map((s) => "・" + s).join("\n");
  const ai = p.actionItems
    .slice(0, 8)
    .map((a) => `・${a.task}（${a.assignee}／${a.deadline}）`)
    .join("\n");
  return [
    `【第${i + 1}段】主題：${p.analysis.theme}`,
    kp ? `重點：\n${kp}` : "",
    cf ? `衝突：\n${cf}` : "",
    ai ? `待辦：\n${ai}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * 分析逐字稿：短則單次；長則 map-reduce（分段摘要→合併）。回 { analysis, actionItems }。
 * 每次呼叫 analyzeAll 都各自享有主力→後援（呼叫端注入的 FallbackLlmService），小段不會撞 Groq TPM。
 */
export async function analyzeTranscript(
  llm: AnalyzeLike,
  transcript: string,
  historicalContext: string,
  opts: AnalyzeChunkedOpts = {},
): Promise<AnalyzeResult> {
  const text = transcript.trim();
  const singleMax = opts.singleMaxChars ?? SINGLE_MAX_CHARS;
  if (text.length <= singleMax) {
    return llm.analyzeAll(text, historicalContext); // 短：原行為
  }

  // map：各段各自摘要（並行；分段不帶歷史，reduce 時才做跨會議衝突比對）。
  const chunks = splitTranscript(text, opts.chunkChars ?? CHUNK_CHARS);
  const partials = new Array<AnalyzeResult>(chunks.length);
  const conc = Math.max(1, Math.min(opts.concurrency ?? CONCURRENCY, chunks.length));
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= chunks.length) break;
      partials[i] = await llm.analyzeAll(chunks[i], "");
    }
  }
  await Promise.all(Array.from({ length: conc }, () => worker()));

  // reduce：各段摘要合成精簡文字再整合；還太長就階層式再 reduce（summaries 遠小於原文，會收斂）。
  const reduceInput = partials.map((p, i) => formatPartial(p, i)).join("\n\n");
  const final =
    reduceInput.length <= singleMax
      ? await llm.analyzeAll(reduceInput, historicalContext)
      : await analyzeTranscript(llm, reduceInput, historicalContext, opts);

  // 行動方針：各段聯集 + reduce 結果，去重（避免 reduce 漏抓真正出現在原文的待辦）。
  const actionItems = dedupeActionItems([...partials.flatMap((p) => p.actionItems), ...final.actionItems]);
  return { analysis: final.analysis, actionItems };
}
