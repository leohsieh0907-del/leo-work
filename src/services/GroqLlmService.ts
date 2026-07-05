// ════════════════════════════════════════════════════════════════════
//  GroqLlmService — Groq（OpenAI 相容、LPU 超快、免費額度大）
//
//  定位：Gemini 的「後援」。當 Gemini 過載(503)/限流(429) 失敗時接手文字任務
//  （分析 / 行動方針 / 翻譯 / 聊天）＋整檔精修（Whisper 轉錄）。與 GeminiLlmService 輸出同形狀。
//
//  用 Groq 的 OpenAI 相容 chat/completions：結構化任務用 response_format
//  json_object（需在 prompt 提到 JSON）。隱私同 Gemini：逐字稿會傳到 Groq。
//
//  註：即時逐字稿(Live WS) 是 Gemini 專屬；整檔精修(聽音訊)現可由本服務的
//      transcribeAudio（whisper-large-v3）接手（Gemini 失敗時由 server 端切換）。
// ════════════════════════════════════════════════════════════════════

import {
  AppError,
  ErrorCode,
  type ProactiveAnalysis,
  type ActionItem,
  type ChatTurn,
  type ComposeExportRequest,
  type ComposedDoc,
} from "../shared/types";
import type { LlmService } from "./llm/types";
import { analysisSystemPrompt, analysisUserPrompt } from "./llm/prompts";
import { normalizeComposedDoc } from "./GeminiLlmService";
import { chunkWavByBytes } from "./wavChunk";

export interface GroqLlmOptions {
  apiKey: string;
  /** 模型，預設 llama-3.3-70b-versatile（品質/中文較佳；可用 GROQ_MODEL 覆寫）。 */
  model?: string;
  /** 整檔精修後援模型，預設 whisper-large-v3（可用 GROQ_WHISPER_MODEL 覆寫）。 */
  whisperModel?: string;
}

const DEFAULT_MODEL = "llama-3.3-70b-versatile";
const DEFAULT_STT_MODEL = "whisper-large-v3";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_STT_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_STT_TRANSLATE_URL = "https://api.groq.com/openai/v1/audio/translations";
// 單次請求的音檔上限（Groq 免費層約 25MB，留安全邊際）。超過的長錄音由 chunkWavByBytes
// 切成多段、逐段轉錄、時間戳位移後接起來（16kHz 單聲道下每段約 13 分鐘）。
const STT_MAX_BYTES = 24 * 1024 * 1024;

/** chat 回應的「後續建議」標記（與 Gemini 端一致）。 */
const CHAT_SUGGEST_MARKER = "###建議###";

function todayString(): string {
  return new Date().toISOString().slice(0, 10);
}

function languageName(code: string): string {
  switch (code) {
    case "zh": return "繁體中文";
    case "en": return "English";
    case "ja": return "日本語";
    case "ko": return "한국어";
    default: return "繁體中文";
  }
}

/** 秒數 → mm:ss。 */
function mmss(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Whisper verbose_json 的 segments → `[mm:ss] 發言人: 內容` 逐行（Whisper 無發言人辨識，統一標「發言人」）。
 * offsetSec：分段轉錄時把本段時間戳位移到整段錄音的絕對位置。
 */
export function formatWhisperSegments(segments: { start?: number; text?: string }[], offsetSec = 0): string {
  return segments
    .map((s) => {
      const t = (s.text ?? "").trim();
      return t ? `[${mmss((s.start ?? 0) + offsetSec)}] 發言人: ${t}` : "";
    })
    .filter(Boolean)
    .join("\n");
}

/** 粗判文字是否含拉丁字母詞（英文等）→ auto 模式才需補中譯，全中文可省一次 API。 */
export function hasLatinText(text: string): boolean {
  return /[A-Za-z]{2,}/.test(text);
}

function toStrArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter((s) => s.length > 0);
  if (typeof v === "string" && v.trim()) return [v.trim()];
  return [];
}

/** 寬鬆解析 JSON 物件：容忍 ```json 圍欄與前後雜訊，失敗回 {}。 */
function safeJsonObject(raw: string): Record<string, unknown> {
  let s = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  try {
    const o = JSON.parse(s);
    if (o && typeof o === "object") return o as Record<string, unknown>;
  } catch {
    const a = s.indexOf("{");
    const b = s.lastIndexOf("}");
    if (a >= 0 && b > a) {
      try {
        const o = JSON.parse(s.slice(a, b + 1));
        if (o && typeof o === "object") return o as Record<string, unknown>;
      } catch { /* fall through */ }
    }
  }
  return {};
}

function mapActionItems(arr: unknown): ActionItem[] {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null)
    .map((x) => ({
      task: String(x.task ?? "").trim(),
      assignee: String(x.assignee ?? "未指定").trim() || "未指定",
      deadline: String(x.deadline ?? "未指定").trim() || "未指定",
    }))
    .filter((a) => a.task.length > 0);
}

function splitChatSuggestions(raw: string): { answer: string; suggestions: string[] } {
  const idx = raw.indexOf(CHAT_SUGGEST_MARKER);
  if (idx === -1) return { answer: raw.trim(), suggestions: [] };
  const answer = raw.slice(0, idx).trim();
  const suggestions = raw
    .slice(idx + CHAT_SUGGEST_MARKER.length)
    .split("\n")
    .map((l) => l.replace(/^[-*•\d.、)\s]+/, "").trim())
    .filter((l) => l.length > 0)
    .slice(0, 3);
  return { answer, suggestions };
}

export class GroqLlmService implements LlmService {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly sttModel: string;

  constructor(opts: GroqLlmOptions) {
    if (!opts?.apiKey) {
      throw new AppError(ErrorCode.CONFIG_MISSING, "未設定 GROQ_API_KEY");
    }
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? DEFAULT_MODEL;
    this.sttModel = opts.whisperModel ?? DEFAULT_STT_MODEL;
  }

  /** 呼叫 Groq chat/completions。messages 由呼叫端組；json=true 走 json_object 模式。 */
  private async complete(
    messages: { role: "system" | "user" | "assistant"; content: string }[],
    json: boolean,
  ): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      temperature: 0.2,
      ...(json ? { response_format: { type: "json_object" } } : {}),
    };
    const resp = await fetchGroqWithRetry(this.apiKey, body);
    const data = (await resp.json().catch(() => null)) as
      | { choices?: { message?: { content?: string } }[]; error?: { message?: string } }
      | null;
    if (!resp.ok) {
      const msg = data?.error?.message ?? `HTTP ${resp.status}`;
      throw new AppError(ErrorCode.CLAUDE_API_ERROR, `Groq API 錯誤：${msg}`);
    }
    const text = data?.choices?.[0]?.message?.content ?? "";
    if (!text.trim()) throw new AppError(ErrorCode.CLAUDE_API_ERROR, "Groq 回應為空");
    return text;
  }

  async generateProactiveAnalysis(
    currentTranscript: string,
    historicalContext: string,
  ): Promise<ProactiveAnalysis> {
    const system =
      analysisSystemPrompt({ today: todayString(), withActionItems: false }) +
      "\n請只輸出一個 JSON 物件，欄位：theme(string)、key_summary(string[])、historical_conflicts(string[])。";
    const user = analysisUserPrompt(currentTranscript, historicalContext);
    const obj = safeJsonObject(await this.complete([
      { role: "system", content: system }, { role: "user", content: user },
    ], true));
    return {
      theme: String(obj.theme ?? "").trim() || "（未能產生主題）",
      key_summary: toStrArray(obj.key_summary),
      historical_conflicts: toStrArray(obj.historical_conflicts),
    };
  }

  async extractActionItems(transcript: string): Promise<ActionItem[]> {
    const system =
      `今天是 ${todayString()}。你是會議助理，從逐字稿抽出「要有人去執行的待辦/行動項」。全程繁體中文。\n` +
      "請只輸出一個 JSON 物件 { items: ActionItem[] }，ActionItem 欄位：\n" +
      'task(具體要做什麼)、assignee(誰負責，沒明講寫「未指定」)、' +
      'deadline(把「下週五/月底前/三天後」等相對時間依今天日期換算成 YYYY-MM-DD，沒提到寫「未指定」)。沒有待辦時 items 給空陣列。';
    const obj = safeJsonObject(await this.complete([
      { role: "system", content: system }, { role: "user", content: transcript },
    ], true));
    return mapActionItems(obj.items);
  }

  async analyzeAll(
    currentTranscript: string,
    historicalContext: string,
  ): Promise<{ analysis: ProactiveAnalysis; actionItems: ActionItem[] }> {
    const system =
      analysisSystemPrompt({ today: todayString(), withActionItems: true }) +
      "\n請只輸出一個 JSON 物件，欄位：theme(string)、key_summary(string[])、historical_conflicts(string[])、" +
      "action_items(物件陣列，每項 {task, assignee, deadline})。";
    const user = analysisUserPrompt(currentTranscript, historicalContext);
    const obj = safeJsonObject(await this.complete([
      { role: "system", content: system }, { role: "user", content: user },
    ], true));
    return {
      analysis: {
        theme: String(obj.theme ?? "").trim() || "（未能產生主題）",
        key_summary: toStrArray(obj.key_summary),
        historical_conflicts: toStrArray(obj.historical_conflicts),
      },
      actionItems: mapActionItems(obj.action_items),
    };
  }

  async translateWithTimestamps(transcript: string, targetLanguage: string): Promise<string> {
    const lang = languageName(targetLanguage);
    const system =
      `你是專業的逐字稿翻譯員。請將逐字稿精準翻譯成「${lang}」。\n` +
      "嚴格要求：1) 完整保留每行開頭的 `[mm:ss]` 時間戳記與「發言人:」標籤不變；" +
      "2) 只翻譯標籤後的內容；3) 不增刪合併任何一行；4) 不要輸出任何說明，直接輸出翻譯後逐字稿。";
    const raw = await this.complete([
      { role: "system", content: system }, { role: "user", content: transcript },
    ], false);
    return raw.trim();
  }

  /** AI 助理對話（與 GeminiLlmService.chat 同簽名/回傳）。 */
  async chat(
    question: string,
    currentTranscript: string,
    memoryContext: string,
    history: ChatTurn[],
  ): Promise<{ answer: string; suggestions: string[] }> {
    const system =
      "你是會議 AI 助理。請根據下方的『當前會議逐字稿』與『相關歷史記憶』，用繁體中文自然、扼要地回答使用者的問題。\n" +
      "原則：有依據才回答，沒有依據就老實說「目前資料看不出來」，不要編造；可整理重點、列待辦、做比較。\n" +
      "回答完畢後，另起一行只輸出標記「###建議###」，接著每行列出一個使用者接下來最可能想問或想做的事" +
      "（簡短祈使句，約 8~18 字），最多 3 個、每行一個，不要編號或多餘文字；想不到就完全不要輸出這段標記。\n\n" +
      "=== 當前會議逐字稿 ===\n" + (currentTranscript.trim() || "（尚無逐字稿）") +
      "\n\n=== 相關歷史記憶 ===\n" + (memoryContext.trim() || "（無相關歷史）");
    const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
      { role: "system", content: system },
      ...history.slice(-8).map((h) => ({
        role: (h.role === "assistant" ? "assistant" : "user") as "user" | "assistant",
        content: h.text,
      })),
      { role: "user", content: question },
    ];
    const raw = await this.complete(messages, false);
    const parsed = splitChatSuggestions(raw);
    return parsed.answer ? parsed : { answer: "（沒有產生回覆，請換個方式問問看）", suggestions: [] };
  }

  /**
   * 整檔精修後援：Groq Whisper（whisper-large-v3，OpenAI 相容、超快）。與 Gemini.transcribeAudio 同簽名。
   * 輸出 `[mm:ss] 發言人: 內容` 逐行（verbose_json 取 segments 帶時間戳）。
   * 長錄音（超過單次上限）自動切多段、逐段轉錄、時間戳位移後接起來（涵蓋整堂課等長會議）。
   * 限制：Whisper 無發言人辨識（統一標「發言人」）；中文可能輸出簡體（zh 時以繁中 prompt + language 盡量導向）；
   *      分段邊界少數字句可能因切斷略有誤差。lang="en" 走 translations 端點一律翻成英文；其餘走 transcriptions。
   */
  async transcribeAudio(
    audioBase64: string,
    mimeType: string,
    lang: "auto" | "zh" | "en" = "auto",
  ): Promise<string> {
    const bytes = Buffer.from(audioBase64, "base64");
    const chunks = chunkWavByBytes(bytes, STT_MAX_BYTES);
    const parts: string[] = [];
    // 逐段（依序，保留時間順序、不對 Groq 限流灌爆）。
    for (const c of chunks) {
      const mt = chunks.length > 1 ? "audio/wav" : mimeType || "audio/wav";
      const data = await this.transcribeOne(c.wav, mt, lang);
      const formatted = formatWhisperSegments(data.segments ?? [], c.startSec);
      if (formatted) {
        parts.push(formatted);
        continue;
      }
      // 無 segments（如 translations 端點）：用整段文字，多段時補上本段起始時間戳。
      const text = (data.text ?? "").trim();
      if (text) parts.push(chunks.length > 1 ? `[${mmss(c.startSec)}] 發言人: ${text}` : text);
    }
    const out = parts.join("\n").trim();
    if (!out) {
      throw new AppError(ErrorCode.CLAUDE_API_ERROR, "Groq Whisper 轉錄回應為空（音訊太短或格式不支援）");
    }
    // auto 模式與 Gemini 對齊：Whisper 只轉原文，這裡把非中文的行補上（繁中翻譯）→ 維持「中英並進」。
    return lang === "auto" ? this.annotateBilingualAuto(out) : out;
  }

  /**
   * auto 模式雙語標註：把「非中文的行」補上行尾（繁中翻譯），與 Gemini auto 的中英並進格式一致。
   * 全中文或過長則跳過（省 API / 防呆）；標註失敗回原文保底（不影響轉錄結果）。
   * 註：轉錄管線每段音訊都很小（~3 分），標註輸入不會撞 Groq TPM。
   */
  private async annotateBilingualAuto(transcript: string): Promise<string> {
    if (!hasLatinText(transcript) || transcript.length > 12000) return transcript;
    const system =
      "你是逐字稿雙語標註員。輸入為 `[mm:ss] 發言人: 內容` 的逐字稿。嚴格規則：\n" +
      "① 每行開頭的 `[mm:ss]` 與「發言人:」原樣保留；② 原文內容一字不改（不可翻譯掉或改寫原文）；\n" +
      "③ 只要該行內容不是中文，就在該行行尾緊接一組全形括號的繁體中文翻譯，例：`Let's ship it.（我們來上線。）`；\n" +
      "④ 原文已是中文的行不要動、不加括號；⑤ 不增刪合併任何行、不輸出任何說明，直接輸出處理後逐字稿。";
    try {
      const raw = await this.complete(
        [{ role: "system", content: system }, { role: "user", content: transcript }],
        false,
      );
      return raw.trim() || transcript;
    } catch {
      return transcript;
    }
  }

  /** 單段請求 Groq Whisper，回傳解析後資料（segments/text）。 */
  private async transcribeOne(
    wav: Buffer,
    mimeType: string,
    lang: "auto" | "zh" | "en",
  ): Promise<{ text?: string; segments?: { start?: number; text?: string }[] }> {
    const translate = lang === "en";
    const url = translate ? GROQ_STT_TRANSLATE_URL : GROQ_STT_URL;
    // 每次重建 FormData：fetch 會消費 body，重試時需要新的一份。
    const makeForm = (): FormData => {
      const form = new FormData();
      form.append("file", new Blob([wav], { type: mimeType || "audio/wav" }), "audio.wav");
      form.append("model", this.sttModel);
      form.append("response_format", "verbose_json"); // 取 segments 以產生時間戳
      form.append("temperature", "0");
      if (!translate && lang === "zh") {
        form.append("language", "zh");
        form.append("prompt", "以下為繁體中文會議錄音。"); // 盡量導向繁體用字
      }
      return form;
    };

    const resp = await fetchGroqSttWithRetry(url, this.apiKey, makeForm);
    const data = (await resp.json().catch(() => null)) as
      | { text?: string; segments?: { start?: number; text?: string }[]; error?: { message?: string } }
      | null;
    if (!resp.ok) {
      throw new AppError(
        ErrorCode.CLAUDE_API_ERROR,
        `Groq Whisper 轉錄錯誤：${data?.error?.message ?? `HTTP ${resp.status}`}`,
      );
    }
    return data ?? {};
  }

  /** AI 客製匯出（與 GeminiLlmService.composeExportDoc 同行為；共用 normalizeComposedDoc 解析）。 */
  async composeExportDoc(req: ComposeExportRequest): Promise<ComposedDoc> {
    const a = req.analysis;
    const fmtName =
      req.format === "docx" ? "Word 文件" : req.format === "xlsx" ? "Excel 試算表" : "PowerPoint 簡報";
    const fmtRule =
      req.format === "xlsx"
        ? "這是 Excel：盡量用 table 區塊承載結構化資料（每個 table 變一張工作表），少用長段落。"
        : req.format === "pptx"
          ? "這是 PPT 簡報：精簡。heading 當投影片標題、bullets 當要點、文字短；**數字一律放 table（第一欄＝項目，其餘欄＝純數值）**，系統會自動畫圖。"
          : "這是 Word 文件：可用 heading 分節、paragraph 敘述、bullets 列點、table 放結構化資料。";
    const system =
      `你是專業的會議文件製作助理，把會議資料整理成一份「${fmtName}」的內容。全程繁體中文，只輸出 JSON。\n` +
      "嚴格遵守使用者指示；只能依據提供的會議資料，不可虛構事實或捏造數字；要求新增但資料沒有的欄位留空或標『未提供』。\n" +
      fmtRule + "\n" +
      "輸出一個 JSON 物件 { title: string, blocks: Block[] }。Block 依 type 填欄位：\n" +
      'heading/paragraph→{type,text}；bullets→{type:"bullets",items:string[]}；' +
      'table→{type:"table",columns:string[],rows:string[][]}；' +
      'chart→{type:"chart",chartType:"bar"|"line"|"pie",categories:string[],series:[{name:string,values:number[]}]}。';

    const source = [
      `會議名稱：${req.title}`,
      `日期：${req.date}`,
      `會議主題：${a?.theme || "（無）"}`,
      `關鍵摘要：\n${(a?.key_summary ?? []).map((s) => "- " + s).join("\n") || "（無）"}`,
      `歷史衝突：\n${(a?.historical_conflicts ?? []).map((s) => "- " + s).join("\n") || "（無）"}`,
      `行動方針：\n${
        (req.actionItems ?? []).map((it) => `- ${it.task}｜負責人：${it.assignee}｜截止：${it.deadline}`).join("\n") ||
        "（無）"
      }`,
      req.transcript?.trim() ? `逐字稿（節錄）：\n${req.transcript.slice(0, 8000)}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    const discussion = (req.history ?? [])
      .filter((h) => h.text?.trim())
      .map((h) => `${h.role === "assistant" ? "AI" : "我"}：${h.text.trim()}`)
      .join("\n");
    const directive = req.instruction.trim() || "請依我們的討論整理出這份文件的內容。";
    const user =
      `=== 使用者指示 ===\n${directive}\n\n` +
      (discussion ? `=== 我與 AI 的討論（衝突時以討論為準）===\n${discussion}\n\n` : "") +
      `=== 會議資料 ===\n${source}`;

    const raw = await this.complete([
      { role: "system", content: system },
      { role: "user", content: user },
    ], true);
    return normalizeComposedDoc(safeJsonObject(raw), req.title);
  }
}

/** 呼叫 Groq 並對 5xx/429 短退避重試（後援自身過載就放手由上層回報）。 */
async function fetchGroqWithRetry(apiKey: string, body: unknown, retries = 2): Promise<Response> {
  const transient = new Set([429, 500, 502, 503, 504]);
  for (let attempt = 0; ; attempt++) {
    const resp = await fetch(GROQ_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
    if (!transient.has(resp.status) || attempt >= retries) return resp;
    await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
  }
}

/** Groq Whisper 轉錄：multipart 上傳，對 5xx/429 短退避重試（每次重建 FormData 以免 body 已被消費）。 */
async function fetchGroqSttWithRetry(
  url: string,
  apiKey: string,
  makeForm: () => FormData,
  retries = 2,
): Promise<Response> {
  const transient = new Set([429, 500, 502, 503, 504]);
  for (let attempt = 0; ; attempt++) {
    const resp = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` }, // 不手動設 Content-Type，讓 fetch 自帶 multipart boundary
      body: makeForm(),
    });
    if (!transient.has(resp.status) || attempt >= retries) return resp;
    await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
  }
}
