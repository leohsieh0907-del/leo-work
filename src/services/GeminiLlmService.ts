// ════════════════════════════════════════════════════════════════════
//  GeminiLlmService — Google Gemini（雲端、有免費額度、不吃 GPU）
//
//  用 Google AI Studio 的 generativelanguage API。結構化任務用
//  responseMimeType:"application/json" + responseSchema 強制輸出固定 JSON，
//  比本地小模型穩定太多（不會回 {}、不會腦補、不會跳簡體）。
//
//  隱私註記：逐字稿會傳到 Google（非本地）。錄音/加密/儲存仍全本地。
//
//  與 ClaudeService / OllamaLlmService 方法簽名一致（皆實作 LlmService）。
// ════════════════════════════════════════════════════════════════════

import {
  AppError,
  ErrorCode,
  type ProactiveAnalysis,
  type ActionItem,
  type ChatTurn,
  type ComposedDoc,
  type ComposeExportRequest,
  type DocBlock,
} from "../shared/types";
import type { LlmService } from "./llm/types";

export interface GeminiLlmOptions {
  apiKey: string;
  /** 模型，預設 gemini-2.5-flash（免費額度、快、中文強） */
  model?: string;
}

const DEFAULT_MODEL = "gemini-2.5-flash";
const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// responseSchema（OpenAPI 子集）：強制 Gemini 回固定結構。
const ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    theme: { type: "string" },
    key_summary: { type: "array", items: { type: "string" } },
    historical_conflicts: { type: "array", items: { type: "string" } },
  },
  required: ["theme", "key_summary", "historical_conflicts"],
};

const ACTION_ITEMS_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          task: { type: "string" },
          assignee: { type: "string" },
          deadline: { type: "string" },
        },
        required: ["task", "assignee", "deadline"],
      },
    },
  },
  required: ["items"],
};

// 客製匯出：通用文件區塊（扁平結構利於 Gemini 穩定輸出）。
const COMPOSED_DOC_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    blocks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["heading", "paragraph", "bullets", "table"] },
          text: { type: "string" },
          items: { type: "array", items: { type: "string" } },
          columns: { type: "array", items: { type: "string" } },
          rows: { type: "array", items: { type: "array", items: { type: "string" } } },
        },
        required: ["type"],
      },
    },
  },
  required: ["title", "blocks"],
};

function languageName(code: string): string {
  switch (code) {
    case "zh":
      return "繁體中文";
    case "en":
      return "English";
    case "ja":
      return "日本語";
    case "ko":
      return "한국어";
    default:
      return "繁體中文";
  }
}

function todayString(): string {
  return new Date().toISOString().slice(0, 10);
}

function toStrArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter((s) => s.length > 0);
  if (typeof v === "string" && v.trim()) return [v.trim()];
  return [];
}

export class GeminiLlmService implements LlmService {
  private readonly apiKey: string;
  private readonly model: string;

  constructor(opts: GeminiLlmOptions) {
    if (!opts?.apiKey) {
      throw new AppError(ErrorCode.CONFIG_MISSING, "未設定 GEMINI_API_KEY，請於 .env 填入");
    }
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? DEFAULT_MODEL;
  }

  /** 呼叫 Gemini generateContent。json=true 時帶 responseSchema 強制結構化輸出。 */
  private async generate(
    system: string,
    user: string,
    schema?: object,
  ): Promise<string> {
    const url = `${API_BASE}/${this.model}:generateContent?key=${this.apiKey}`;
    const body: Record<string, unknown> = {
      system_instruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: {
        temperature: 0.2,
        ...(schema
          ? { responseMimeType: "application/json", responseSchema: schema }
          : {}),
      },
    };

    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new AppError(
        ErrorCode.CLAUDE_API_ERROR,
        `無法連線到 Gemini API：${e instanceof Error ? e.message : String(e)}`,
      );
    }

    const data = (await resp.json().catch(() => null)) as
      | {
          candidates?: { content?: { parts?: { text?: string }[] } }[];
          error?: { message?: string };
        }
      | null;

    if (!resp.ok) {
      const msg = data?.error?.message ?? `HTTP ${resp.status}`;
      throw new AppError(ErrorCode.CLAUDE_API_ERROR, `Gemini API 錯誤：${msg}`);
    }

    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    if (!text) {
      throw new AppError(ErrorCode.CLAUDE_API_ERROR, "Gemini 回應為空（可能被安全過濾或額度用盡）");
    }
    return text;
  }

  async generateProactiveAnalysis(
    currentTranscript: string,
    historicalContext: string,
  ): Promise<ProactiveAnalysis> {
    const system =
      "你是專業的會議分析助理。只根據使用者提供的『當前會議逐字稿』實際內容做分析，所有結論都要有逐字稿依據，嚴禁虛構。\n" +
      "theme：一句話總結會議在談什麼。\n" +
      "key_summary：關鍵決定與討論重點，每點一句、要具體。\n" +
      "historical_conflicts：當前內容與『歷史會議背景』明顯不一致之處；沒有歷史或無衝突就給空陣列。\n" +
      "全程使用繁體中文。";

    const user =
      "=== 當前會議逐字稿 ===\n" +
      currentTranscript +
      "\n\n=== 歷史會議背景 ===\n" +
      (historicalContext.trim() || "（無歷史背景）");

    const raw = await this.generate(system, user, ANALYSIS_SCHEMA);
    const obj = safeJsonObject(raw);
    return {
      theme: String(obj.theme ?? "").trim() || "（未能產生主題）",
      key_summary: toStrArray(obj.key_summary),
      historical_conflicts: toStrArray(obj.historical_conflicts),
    };
  }

  async extractActionItems(transcript: string): Promise<ActionItem[]> {
    const system =
      `今天是 ${todayString()}。你是會議助理，從逐字稿抽出「要有人去執行的待辦/行動項」。\n` +
      "判斷原則：有人被指派、或會中決定某人要做某事/某事要在某時間前完成，就是一筆待辦。\n" +
      "task：具體要做什麼。assignee：誰負責，沒明講寫「未指定」。\n" +
      "deadline：把「下週五/月底前/三天後」等相對時間依今天日期換算成 YYYY-MM-DD，沒提到寫「未指定」。\n" +
      "沒有任何待辦時 items 給空陣列。全程繁體中文。";

    const raw = await this.generate(system, transcript, ACTION_ITEMS_SCHEMA);
    const obj = safeJsonObject(raw);
    const arr = Array.isArray(obj.items) ? obj.items : [];
    return arr
      .filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null)
      .map((x) => ({
        task: String(x.task ?? "").trim(),
        assignee: String(x.assignee ?? "未指定").trim() || "未指定",
        deadline: String(x.deadline ?? "未指定").trim() || "未指定",
      }))
      .filter((a) => a.task.length > 0);
  }

  async translateWithTimestamps(transcript: string, targetLanguage: string): Promise<string> {
    const lang = languageName(targetLanguage);
    const system =
      `你是專業的逐字稿翻譯員。請將逐字稿精準翻譯成「${lang}」。\n` +
      "嚴格要求：1) 完整保留每行開頭的 `[mm:ss]` 時間戳記與「發言人:」標籤不變；" +
      "2) 只翻譯標籤後的內容；3) 不增刪合併任何一行；4) 不要輸出任何說明，直接輸出翻譯後逐字稿。";

    const raw = await this.generate(system, transcript);
    return raw.trim();
  }

  /** 把錄音音訊直接轉錄成帶時間戳記的逐字稿（Gemini 聽音訊）。lang 控制輸出語言。 */
  async transcribeAudio(
    audioBase64: string,
    mimeType: string,
    lang: "auto" | "zh" | "en" = "auto",
  ): Promise<string> {
    const base =
      "你是專業的會議錄音轉錄員。每句獨立一行，" +
      "格式固定為 `[mm:ss] 發言人: 內容`（mm:ss 為該句在錄音中的大約時間）。" +
      "盡量區分不同發言人（標 發言人1、發言人2…）；無法區分時統一標 發言人。" +
      "只輸出逐字稿本身，不要任何說明或前言。";
    const langRule =
      lang === "zh"
        ? "不論原本說什麼語言，一律轉錄成繁體中文。"
        : lang === "en"
          ? "Transcribe everything into English regardless of the spoken language."
          : "用原始說話語言逐字轉錄。**中文一律輸出繁體（正體）字，絕不可輸出簡體字。**" +
            "**硬性規定：每一行只要原文不是中文，行尾就必須緊接全形括號的繁體中文翻譯（每一句都要，一句都不能漏）**。" +
            "格式：`[mm:ss] 發言人: 原文（繁中翻譯）`，例如 `[00:05] 發言人1: Let's ship it next week.（下週就上線。）`。" +
            "原文已是中文的行不加括號。漏任何一句翻譯都算錯。";
    const system = base + "\n" + langRule;
    const url = `${API_BASE}/${this.model}:generateContent?key=${this.apiKey}`;
    const body = {
      system_instruction: { parts: [{ text: system }] },
      contents: [
        {
          role: "user",
          parts: [
            { inline_data: { mime_type: mimeType, data: audioBase64 } },
            { text: "請逐字轉錄這段錄音。" },
          ],
        },
      ],
      generationConfig: { temperature: 0.1 },
    };

    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new AppError(
        ErrorCode.CLAUDE_API_ERROR,
        `無法連線到 Gemini API：${e instanceof Error ? e.message : String(e)}`,
      );
    }

    const data = (await resp.json().catch(() => null)) as
      | { candidates?: { content?: { parts?: { text?: string }[] } }[]; error?: { message?: string } }
      | null;
    if (!resp.ok) {
      throw new AppError(
        ErrorCode.CLAUDE_API_ERROR,
        `Gemini 轉錄錯誤：${data?.error?.message ?? `HTTP ${resp.status}`}`,
      );
    }
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    if (!text) {
      throw new AppError(ErrorCode.CLAUDE_API_ERROR, "Gemini 轉錄回應為空（音訊太短或格式不支援）");
    }
    return text.trim();
  }

  /**
   * AI 助理對話：結合「當前會議逐字稿 + 相關歷史記憶 + 對話脈絡」自然回答。
   */
  async chat(
    question: string,
    currentTranscript: string,
    memoryContext: string,
    history: ChatTurn[],
  ): Promise<string> {
    const system =
      "你是會議 AI 助理。請根據下方的『當前會議逐字稿』與『相關歷史記憶』，用繁體中文自然、扼要地回答使用者的問題。\n" +
      "原則：有依據才回答，沒有依據就老實說「目前資料看不出來」，不要編造；可整理重點、列待辦、做比較。\n\n" +
      "=== 當前會議逐字稿 ===\n" +
      (currentTranscript.trim() || "（尚無逐字稿）") +
      "\n\n=== 相關歷史記憶 ===\n" +
      (memoryContext.trim() || "（無相關歷史）");

    const contents = [
      ...history.slice(-8).map((h) => ({
        role: h.role === "assistant" ? "model" : "user",
        parts: [{ text: h.text }],
      })),
      { role: "user", parts: [{ text: question }] },
    ];

    const url = `${API_BASE}/${this.model}:generateContent?key=${this.apiKey}`;
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: system }] },
          contents,
          generationConfig: { temperature: 0.3 },
        }),
      });
    } catch (e) {
      throw new AppError(
        ErrorCode.CLAUDE_API_ERROR,
        `無法連線到 Gemini API：${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const data = (await resp.json().catch(() => null)) as
      | { candidates?: { content?: { parts?: { text?: string }[] } }[]; error?: { message?: string } }
      | null;
    if (!resp.ok) {
      throw new AppError(
        ErrorCode.CLAUDE_API_ERROR,
        `Gemini 對話錯誤：${data?.error?.message ?? `HTTP ${resp.status}`}`,
      );
    }
    const answer = data?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    return answer.trim() || "（沒有產生回覆，請換個方式問問看）";
  }

  /**
   * AI 客製匯出：依「目標格式 + 使用者白話指示」把會議資料重組成通用文件區塊（ComposedDoc）。
   * 前端再把 ComposedDoc 渲染成 Word / Excel / PPT。只根據提供的資料，不虛構。
   */
  async composeExportDoc(req: ComposeExportRequest): Promise<ComposedDoc> {
    const a = req.analysis;
    const fmtName =
      req.format === "docx" ? "Word 文件" : req.format === "xlsx" ? "Excel 試算表" : "PowerPoint 簡報";
    const fmtRule =
      req.format === "xlsx"
        ? "這是 Excel：盡量用 table 區塊承載結構化資料（每個 table 會變成一張工作表），少用長段落。"
        : req.format === "pptx"
          ? "這是 PPT 簡報：要精簡。用 heading 當投影片標題、bullets 當要點（每個 heading 會開一張新投影片）；文字短、條列化，不要長段落。"
          : "這是 Word 文件：可用 heading 分節、paragraph 寫敘述、bullets 列重點、table 放結構化資料。";

    const system =
      `你是專業的會議文件製作助理，要把會議資料整理成一份「${fmtName}」的內容（結構化區塊）。\n` +
      "嚴格遵守使用者指示（語氣、重點取捨、要不要新增欄位/段落等）。\n" +
      "只能依據提供的會議資料，不可虛構事實；使用者要求新增的欄位若資料沒有，留空或標『未提供』。\n" +
      fmtRule +
      "\n區塊類型：heading(填 text)、paragraph(填 text)、bullets(填 items[])、table(填 columns[] 與 rows[][])。\n" +
      "title 為文件標題。全程使用繁體中文，只輸出 JSON。";

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

    const user = `=== 使用者指示 ===\n${req.instruction}\n\n=== 會議資料 ===\n${source}`;

    const raw = await this.generate(system, user, COMPOSED_DOC_SCHEMA);
    return normalizeComposedDoc(safeJsonObject(raw), req.title);
  }
}

/** 防呆解析 Gemini 回的 ComposedDoc：濾掉空/壞區塊，欄位型別歸一。 */
function normalizeComposedDoc(obj: Record<string, unknown>, fallbackTitle: string): ComposedDoc {
  const rawBlocks = Array.isArray(obj.blocks) ? obj.blocks : [];
  const blocks: DocBlock[] = [];
  for (const b of rawBlocks) {
    if (!b || typeof b !== "object") continue;
    const r = b as Record<string, unknown>;
    if (r.type === "heading" || r.type === "paragraph") {
      const text = String(r.text ?? "").trim();
      if (text) blocks.push({ type: r.type, text });
    } else if (r.type === "bullets") {
      const items = toStrArray(r.items);
      if (items.length) blocks.push({ type: "bullets", items });
    } else if (r.type === "table") {
      const columns = toStrArray(r.columns);
      const rows = Array.isArray(r.rows)
        ? r.rows.map((row) => toStrArray(row)).filter((row) => row.length > 0)
        : [];
      if (columns.length || rows.length) blocks.push({ type: "table", columns, rows });
    }
  }
  return { title: String(obj.title ?? "").trim() || fallbackTitle, blocks };
}

/** 安全解析成物件（responseSchema 下通常已是乾淨 JSON；仍防呆）。 */
function safeJsonObject(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
