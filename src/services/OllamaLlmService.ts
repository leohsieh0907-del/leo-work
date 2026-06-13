// ════════════════════════════════════════════════════════════════════
//  OllamaLlmService — 本地 LLM（完全免費、離線、$0 token）
//
//  透過本機 Ollama（http://localhost:11434）跑開源模型（預設 qwen2.5:3b，
//  中文強、CPU 也跑得動）。結構化任務用 Ollama 的 format:"json" 強制 JSON，
//  再用 zod 驗證 + 容錯解析，補足本地小模型輸出不夠穩的問題。
//
//  與 ClaudeService 方法簽名一致（皆實作 LlmService），server.ts 可互換。
// ════════════════════════════════════════════════════════════════════

import {
  AppError,
  ErrorCode,
  type ProactiveAnalysis,
  type ActionItem,
} from "../shared/types";
import type { LlmService } from "./llm/types";

export interface OllamaLlmOptions {
  /** Ollama 服務位址，預設 http://localhost:11434 */
  baseUrl?: string;
  /** 模型名稱，預設 qwen2.5:3b（無 GPU 也能跑） */
  model?: string;
}

const DEFAULT_BASE_URL = "http://localhost:11434";
const DEFAULT_MODEL = "qwen2.5:3b";

// ─────────────── 寬鬆解析輔助（本地小模型輸出不一定嚴謹）───────────────

/** 任意值轉乾淨字串陣列：陣列→逐項轉字串；字串→單元素；其它→空陣列。 */
function toStrArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter((s) => s.length > 0);
  if (typeof v === "string" && v.trim()) return [v.trim()];
  return [];
}

/** 從解析結果取出「項目陣列」：本身是陣列就用；是物件就找第一個陣列屬性（如 items）。 */
function pickArray(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.items)) return obj.items;
    for (const v of Object.values(obj)) if (Array.isArray(v)) return v;
  }
  return [];
}

/** zh/en/ja/ko → 語言全名；非預期值預設繁中。 */
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

/** 今天日期 YYYY-MM-DD（給相對日期換算用）。 */
function todayString(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * 容錯解析 LLM 回傳的 JSON：先剝 ```json 圍欄 → 直接 parse →
 * 失敗則抓第一個 {...} 或 [...] 區塊再 parse。全失敗回 null。
 */
function parseJsonLoose(raw: string): unknown {
  const cleaned = raw.replace(/```json/gi, "").replace(/```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    /* 繼續嘗試抓區塊 */
  }
  const firstObj = cleaned.indexOf("{");
  const lastObj = cleaned.lastIndexOf("}");
  const firstArr = cleaned.indexOf("[");
  const lastArr = cleaned.lastIndexOf("]");
  // 取較早出現、且成對的那種
  const candidates: string[] = [];
  if (firstArr !== -1 && lastArr > firstArr) candidates.push(cleaned.slice(firstArr, lastArr + 1));
  if (firstObj !== -1 && lastObj > firstObj) candidates.push(cleaned.slice(firstObj, lastObj + 1));
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      /* 試下一個 */
    }
  }
  return null;
}

export class OllamaLlmService implements LlmService {
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(opts: OllamaLlmOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.model = opts.model ?? DEFAULT_MODEL;
  }

  /** 共用：呼叫 Ollama /api/chat，回傳模型輸出純文字。json=true 時強制 JSON 輸出。 */
  private async chat(system: string, user: string, json: boolean): Promise<string> {
    let resp: Response;
    try {
      resp = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          stream: false,
          ...(json ? { format: "json" } : {}),
          options: { temperature: json ? 0.1 : 0.3, num_ctx: 8192 },
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
      });
    } catch {
      throw new AppError(
        ErrorCode.CLAUDE_API_ERROR,
        `無法連線到本機 Ollama（${this.baseUrl}）。請確認已啟動 Ollama，並執行過 \`ollama pull ${this.model}\`。`,
      );
    }

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      // 常見：模型未下載
      if (resp.status === 404) {
        throw new AppError(
          ErrorCode.CLAUDE_API_ERROR,
          `Ollama 找不到模型「${this.model}」，請先執行 \`ollama pull ${this.model}\`。`,
        );
      }
      throw new AppError(ErrorCode.CLAUDE_API_ERROR, `Ollama 回傳錯誤（${resp.status}）：${body}`);
    }

    const data = (await resp.json().catch(() => null)) as { message?: { content?: string } } | null;
    const text = data?.message?.content;
    if (typeof text !== "string" || text.length === 0) {
      throw new AppError(ErrorCode.CLAUDE_API_ERROR, "Ollama 回應格式非預期（缺少 message.content）");
    }
    return text;
  }

  async generateProactiveAnalysis(
    currentTranscript: string,
    historicalContext: string,
  ): Promise<ProactiveAnalysis> {
    const system =
      "你是專業的會議分析助理。只能根據下方提供的『當前會議逐字稿』的實際內容做分析，" +
      "所有結論都必須有逐字稿依據，嚴禁虛構、嚴禁照抄本說明裡的字。\n" +
      "輸出一個 JSON 物件，三個欄位：\n" +
      "- theme：用一句話總結這場會議在談什麼（反映逐字稿真實內容）。\n" +
      "- key_summary：字串陣列，逐字稿中的關鍵決定與討論重點，每點一句、要具體。\n" +
      "- historical_conflicts：字串陣列，『當前逐字稿』與『歷史會議背景』明顯不一致之處；" +
      "若沒有歷史背景或找不到不一致，一律給空陣列 []。\n" +
      "只輸出這個 JSON 物件，不要輸出任何其他文字。";

    const user =
      "=== 當前會議逐字稿 ===\n" +
      currentTranscript +
      "\n\n=== 歷史會議背景 ===\n" +
      (historicalContext.trim() || "（無歷史背景）");

    const raw = await this.chat(system, user, true);
    const parsed = parseJsonLoose(raw);
    const obj =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    // 寬鬆組裝：本地小模型偶爾把陣列寫成字串或漏欄位，這裡一律安全轉型。
    return {
      theme: String(obj.theme ?? "").trim() || "（未能產生主題）",
      key_summary: toStrArray(obj.key_summary),
      historical_conflicts: toStrArray(obj.historical_conflicts),
    };
  }

  async extractActionItems(transcript: string): Promise<ActionItem[]> {
    const system =
      `今天是 ${todayString()}。你是會議助理，負責從逐字稿抽出「要有人去執行的待辦/行動項」。\n` +
      "判斷原則：只要有人被指派、或會中決定『某人要做某事』『某事要在某時間前完成』，就是一筆待辦。\n" +
      "每筆需有 task（要做什麼，具體）、assignee（誰負責，沒明講就寫 未指定）、" +
      "deadline（什麼時候前完成；把『下週五』『月底前』『三天後』依今天日期換算成 YYYY-MM-DD，沒提到就寫 未指定）。\n" +
      // 用物件包一層 items：Ollama 的 JSON 模式對「物件」比「裸陣列」穩定得多（小模型常把裸陣列回成 {}）。
      '輸出 JSON 物件：{"items":[{"task":"...","assignee":"...","deadline":"..."}]}。' +
      "逐字稿真的完全沒有任何人要做的事，才給空 items。只輸出這個 JSON 物件，不要其他文字。";

    const user = "會議逐字稿如下，請逐句找出所有待辦/行動項：\n\n" + transcript;
    const raw = await this.chat(system, user, true);
    const arr = pickArray(parseJsonLoose(raw));
    // 寬鬆組裝：逐項安全轉型、補預設、丟掉沒有 task 的雜訊，永不硬性 throw。
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
      "嚴格要求：\n" +
      "1. 完整保留每一行開頭的 `[mm:ss]` 時間戳記與「發言人:」標籤，原封不動。\n" +
      "2. 只翻譯標籤之後的內容文字，不要更動時間戳記與發言人標籤本身。\n" +
      "3. 不要新增、刪除或合併任何一行，輸出行數須與輸入完全相同。\n" +
      "4. 不要輸出任何翻譯說明或前言，直接輸出翻譯後的逐字稿。";

    const raw = await this.chat(system, transcript, false);
    return raw.trim();
  }
}
