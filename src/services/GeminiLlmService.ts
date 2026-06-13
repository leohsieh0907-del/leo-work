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
