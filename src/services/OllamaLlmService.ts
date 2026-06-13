// ════════════════════════════════════════════════════════════════════
//  OllamaLlmService — 本地 LLM（完全免費、離線、$0 token）
//
//  透過本機 Ollama（http://localhost:11434）跑開源模型（預設 qwen2.5:3b，
//  中文強、CPU 也跑得動）。結構化任務用 Ollama 的 format:"json" 強制 JSON，
//  再用 zod 驗證 + 容錯解析，補足本地小模型輸出不夠穩的問題。
//
//  與 ClaudeService 方法簽名一致（皆實作 LlmService），server.ts 可互換。
// ════════════════════════════════════════════════════════════════════

import { z } from "zod";
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

// ─────────────── zod 結構驗證 ───────────────

const ProactiveAnalysisSchema = z.object({
  theme: z.string(),
  key_summary: z.array(z.string()),
  historical_conflicts: z.array(z.string()),
});

const ActionItemArraySchema = z.array(
  z.object({
    task: z.string(),
    assignee: z.string(),
    deadline: z.string(),
  }),
);

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
      "你是專業的會議分析助理。請同時閱讀「當前會議逐字稿」與「歷史會議背景」，做橫向比對分析，" +
      "並主動指出與歷史的衝突點（例如：歷史記錄客戶要 A 功能，今天卻要求 B 功能）。\n" +
      "只輸出一個 JSON 物件，結構嚴格為：\n" +
      '{"theme": "一句話會議主題", "key_summary": ["重點1","重點2"], "historical_conflicts": ["衝突描述1"]}\n' +
      "無衝突時 historical_conflicts 給空陣列 []。除了這個 JSON 外不要輸出任何其他文字。";

    const user =
      "=== 當前會議逐字稿 ===\n" +
      currentTranscript +
      "\n\n=== 歷史會議背景 ===\n" +
      (historicalContext.trim() || "（無歷史背景）");

    const raw = await this.chat(system, user, true);
    const parsed = parseJsonLoose(raw);
    const result = ProactiveAnalysisSchema.safeParse(parsed);
    if (!result.success) {
      throw new AppError(ErrorCode.CLAUDE_BAD_JSON, "本地模型回傳的分析 JSON 格式不正確", {
        issues: result.error.issues,
        raw,
      });
    }
    return result.data;
  }

  async extractActionItems(transcript: string): Promise<ActionItem[]> {
    const system =
      `今天日期：${todayString()}。\n` +
      "你是專業的會議助理。請從逐字稿中精準提取待辦事項，深度理解語意（不要只抓關鍵字）。\n" +
      "每項需含：task（任務內容）、assignee（負責人，語意不明填「未指定」）、" +
      "deadline（截止日；把「下週五/三天後/月底前」等相對時間，依今天日期換算成具體 YYYY-MM-DD；無法判斷填「未指定」）。\n" +
      '只輸出一個 JSON 陣列，結構嚴格為：[{"task":"","assignee":"","deadline":""}]。無待辦時輸出 []。' +
      "除了這個 JSON 陣列外不要輸出任何其他文字。";

    const raw = await this.chat(system, transcript, true);
    const parsed = parseJsonLoose(raw);
    const result = ActionItemArraySchema.safeParse(parsed);
    if (!result.success) {
      throw new AppError(ErrorCode.CLAUDE_BAD_JSON, "本地模型回傳的行動方針 JSON 格式不正確", {
        issues: result.error.issues,
        raw,
      });
    }
    return result.data;
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
