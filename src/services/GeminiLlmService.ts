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
          : "用原始說話語言逐字轉錄（講中文用繁體中文、講英文用英文）。" +
            "若某句不是中文，請在該句內容後面用全形括號附上繁體中文翻譯，" +
            "例如 `[00:05] 發言人1: Let's ship it next week.（下週就上線。）`；講中文的句子不必加翻譯。";
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
