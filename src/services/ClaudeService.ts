// ════════════════════════════════════════════════════════════════════
//  ClaudeService — 階段三「主動式分析服務」
//
//  封裝三個由 Claude 驅動的能力，全部跑在 Node sidecar（不可在 webview）：
//   1. generateProactiveAnalysis — 讀「當前逐字稿 + 歷史背景」做橫向比對，
//      主動指出歷史與當前的需求衝突，輸出嚴格 JSON。
//   2. extractActionItems       — 深度語意分析提取行動方針（任務/負責人/
//      截止日），並把「下週五」之類相對時間換算成具體日期。
//   3. translateWithTimestamps  — 翻譯逐字稿但嚴禁破壞 [mm:ss] 時間戳記與
//      「發言人:」標籤。
//
//  設計重點：
//   • 全部用 system + few-shot 引導模型穩定輸出。
//   • JSON 類輸出一律以 zod 驗證；並做「容錯抓取」（模型若包了多餘文字，
//     用正則抓出第一個 {...} / [...] 區塊再 parse），避免偶發雜訊整段失敗。
//   • 驗證失敗 → AppError(CLAUDE_BAD_JSON)；API 失敗 → AppError(CLAUDE_API_ERROR)。
// ════════════════════════════════════════════════════════════════════

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

import { AppError, ErrorCode, type ActionItem, type ProactiveAnalysis } from "../shared/types";

/** 建構參數；apiKey 必填，model 可覆寫（預設見下方常數）。 */
export interface ClaudeOptions {
  apiKey: string;
  model?: string;
}

/** 預設模型；server.ts 會把 ANTHROPIC_MODEL（可能為 undefined）帶入 model。 */
const DEFAULT_MODEL = "claude-3-5-sonnet-latest";
/** 單次輸出上限；逐字稿翻譯/摘要都在此範圍內。 */
const MAX_TOKENS = 4096;

// ─────────────── zod 驗證 schema（對應 shared/types 的形狀） ───────────────

/** ProactiveAnalysis 的執行期驗證；historical_conflicts 無衝突時為 []。 */
const ProactiveAnalysisSchema = z.object({
  theme: z.string(),
  key_summary: z.array(z.string()),
  historical_conflicts: z.array(z.string()),
});

/** 單筆行動方針；缺值由模型填 "未指定"，這裡只保證型別。 */
const ActionItemSchema = z.object({
  task: z.string(),
  assignee: z.string(),
  deadline: z.string(),
});
const ActionItemArraySchema = z.array(ActionItemSchema);

// ─────────────── 語言代碼 → 語言名稱（給翻譯提示用） ───────────────

const LANGUAGE_NAMES: Record<string, string> = {
  zh: "繁體中文",
  en: "English",
  ja: "日本語",
  ko: "한국어",
};

export class ClaudeService {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(opts: ClaudeOptions) {
    if (!opts || typeof opts.apiKey !== "string" || opts.apiKey.length === 0) {
      throw new AppError(ErrorCode.CONFIG_MISSING, "ClaudeService 需要非空的 apiKey（ANTHROPIC_API_KEY）");
    }
    this.client = new Anthropic({ apiKey: opts.apiKey });
    // 注意：server.ts 可能傳入 model: undefined（環境變數未設），故用 ?? 套預設
    this.model = opts.model ?? DEFAULT_MODEL;
  }

  // ══════════════════════════════════════════════════════════════════
  //  1. 主動式分析（摘要 + 橫向比對歷史衝突）
  // ══════════════════════════════════════════════════════════════════

  /**
   * 同時讀「當前逐字稿」與「歷史會議背景」，做橫向比對，主動指出衝突。
   * @returns 嚴格 JSON：{ theme, key_summary[], historical_conflicts[] }
   */
  async generateProactiveAnalysis(
    currentTranscript: string,
    historicalContext: string,
  ): Promise<ProactiveAnalysis> {
    if (typeof currentTranscript !== "string" || currentTranscript.trim().length === 0) {
      throw new AppError(ErrorCode.INVALID_INPUT, "currentTranscript 不可為空");
    }

    const system = [
      "你是一位資深的會議分析顧問。你的任務是：同時讀取「當前會議逐字稿」與「歷史會議背景」，",
      "做深度語意理解與【橫向比對】，主動找出歷史決策／需求與當前討論之間的【衝突或矛盾】。",
      "",
      "請特別留意這類衝突：歷史會議曾要求做 A 功能（或定下某方向／預算／規格），",
      "但當前會議卻要求改做 B、或推翻先前共識、或與既有承諾不一致——這些都必須主動點出，",
      "因為與會者往往不會自己發現。若歷史背景為空或確實無任何衝突，historical_conflicts 回傳空陣列。",
      "",
      "【輸出格式】只能輸出一個 JSON 物件，不得有任何額外文字、說明或 markdown 圍欄：",
      '{"theme": string, "key_summary": string[], "historical_conflicts": string[]}',
      "- theme：用一句話精準概括本次會議主題。",
      "- key_summary：本次會議的關鍵討論重點，每點一句，條列為字串陣列。",
      "- historical_conflicts：每點具體描述一個與歷史的衝突（點出「歷史要X、現在要Y」），無衝突則為 []。",
      "",
      "【範例】",
      "輸入：",
      "=== 當前會議逐字稿 ===",
      "[00:05] 王經理: 這次我們決定主打訂閱制，先把一次性買斷拿掉。",
      "[00:20] 李工: 那行動版優先，桌面版延後。",
      "",
      "=== 歷史會議背景 ===",
      "[2026-03-10] 王經理曾拍板：產品以一次性買斷為主，且桌面版要先上線。",
      "",
      "輸出：",
      '{"theme":"產品商業模式與上線平台優先序調整","key_summary":["改採訂閱制，移除一次性買斷","行動版優先、桌面版延後"],"historical_conflicts":["商業模式衝突：歷史（3/10）拍板以一次性買斷為主，當前卻要移除買斷改主打訂閱制","上線平台衝突：歷史要求桌面版先上線，當前改為行動版優先、桌面版延後"]}',
    ].join("\n");

    const user = [
      "=== 當前會議逐字稿 ===",
      currentTranscript.trim(),
      "",
      "=== 歷史會議背景 ===",
      historicalContext && historicalContext.trim().length > 0
        ? historicalContext.trim()
        : "（無歷史背景）",
    ].join("\n");

    const raw = await this.complete(system, user);
    const obj = this.parseJsonLoose(raw, "object");

    const parsed = ProactiveAnalysisSchema.safeParse(obj);
    if (!parsed.success) {
      throw new AppError(
        ErrorCode.CLAUDE_BAD_JSON,
        "主動式分析回傳的 JSON 格式不符預期",
        { issues: parsed.error.issues, raw },
      );
    }
    return parsed.data;
  }

  // ══════════════════════════════════════════════════════════════════
  //  2. 行動方針提取（含相對時間 → 具體日期換算）
  // ══════════════════════════════════════════════════════════════════

  /**
   * 深度語意分析提取行動方針：任務內容 / 負責人 / 截止日。
   * 相對時間（如「下週五」）會依「今天日期」換算成 YYYY-MM-DD；無法判斷標 "未指定"。
   * @returns Array<{ task, assignee, deadline }>
   */
  async extractActionItems(transcript: string): Promise<ActionItem[]> {
    if (typeof transcript !== "string" || transcript.trim().length === 0) {
      throw new AppError(ErrorCode.INVALID_INPUT, "transcript 不可為空");
    }

    const today = this.todayString(); // 例 "2026-06-13"

    const system = [
      `今天日期：${today}`,
      "你是一位嚴謹的會議記錄助理。請對逐字稿做深度語意分析，精準提取所有【行動方針／待辦事項】。",
      "每一筆都要辨識三個欄位：",
      "1. task（任務內容）：具體要做什麼，用簡潔完整的一句話描述。",
      "2. assignee（負責人）：被指派執行的人；若語意不明確標 \"未指定\"。",
      `3. deadline（截止日）：請依「今天日期：${today}」把相對時間換算成具體日期 YYYY-MM-DD，`,
      "   例如「下週五」「三天後」「月底前」都要換算成實際日期；若逐字稿沒有提到期限或無法判斷，標 \"未指定\"。",
      "",
      "【輸出格式】只能輸出一個 JSON 陣列，不得有任何額外文字、說明或 markdown 圍欄；",
      "若沒有任何行動方針，回傳空陣列 []。",
      'JSON 形狀：[{"task": string, "assignee": string, "deadline": string}, ...]',
      "",
      "【範例】（假設今天是 2026-06-13、星期六）",
      "輸入：",
      "[00:10] 王經理: 阿明，麻煩你下週五前把報價單給客戶。",
      "[00:30] 王經理: 報表的部分我們之後再看，先不急。",
      "輸出：",
      '[{"task":"把報價單寄給客戶","assignee":"阿明","deadline":"2026-06-19"},{"task":"檢視報表","assignee":"未指定","deadline":"未指定"}]',
    ].join("\n");

    const user = ["以下為會議逐字稿，請提取行動方針：", "", transcript.trim()].join("\n");

    const raw = await this.complete(system, user);
    const arr = this.parseJsonLoose(raw, "array");

    const parsed = ActionItemArraySchema.safeParse(arr);
    if (!parsed.success) {
      throw new AppError(
        ErrorCode.CLAUDE_BAD_JSON,
        "行動方針回傳的 JSON 格式不符預期",
        { issues: parsed.error.issues, raw },
      );
    }
    return parsed.data;
  }

  // ══════════════════════════════════════════════════════════════════
  //  3. 逐字稿翻譯（保留時間戳記與發言人標籤）
  // ══════════════════════════════════════════════════════════════════

  /**
   * 翻譯逐字稿為 targetLanguage，嚴格保留每行的 [mm:ss] 時間戳記與「發言人:」標籤，
   * 只翻譯實際發言內容。回傳純文字（與輸入同樣逐行）。
   */
  async translateWithTimestamps(transcript: string, targetLanguage: string): Promise<string> {
    if (typeof transcript !== "string" || transcript.trim().length === 0) {
      throw new AppError(ErrorCode.INVALID_INPUT, "transcript 不可為空");
    }
    if (typeof targetLanguage !== "string" || targetLanguage.trim().length === 0) {
      throw new AppError(ErrorCode.INVALID_INPUT, "targetLanguage 不可為空");
    }

    // 若傳進來的是 zh/en/ja/ko 代碼，對應成語言名；否則直接用原字串（如 "English"）
    const langName = LANGUAGE_NAMES[targetLanguage.trim().toLowerCase()] ?? targetLanguage.trim();

    const system = [
      `你是一位專業的會議口譯員。請把逐字稿翻譯成「${langName}」。`,
      "",
      "【嚴格規則】",
      "1. 絕對不可破壞、移動或遺漏任何 [mm:ss] 時間戳記，必須原封不動保留在每行開頭。",
      "2. 絕對不可翻譯或更動「發言人:」標籤的結構；發言人名字可音譯但須保持是同一個標籤位置。",
      "3. 只翻譯冒號後的實際發言內容。",
      "4. 逐行對應輸出，行數與順序與輸入完全一致。",
      "5. 只輸出翻譯後的逐字稿本身，不要加任何說明、前言或 markdown 圍欄。",
      "",
      "【範例】（目標語言：English）",
      "輸入： [00:12] 謝先生: 我們預計下個月量產。",
      "輸出： [00:12] Mr. Hsieh: We expect to mass-produce next month.",
    ].join("\n");

    const user = ["請翻譯以下逐字稿：", "", transcript.trim()].join("\n");

    const raw = await this.complete(system, user);
    return raw.trim();
  }

  // ══════════════════════════════════════════════════════════════════
  //  內部工具
  // ══════════════════════════════════════════════════════════════════

  /**
   * 呼叫 Claude 並取回純文字。所有 API 層失敗統一包成 CLAUDE_API_ERROR。
   */
  private async complete(system: string, content: string): Promise<string> {
    let msg: Anthropic.Message;
    try {
      msg = await this.client.messages.create({
        model: this.model,
        max_tokens: MAX_TOKENS,
        system,
        messages: [{ role: "user", content }],
      });
    } catch (err) {
      throw new AppError(
        ErrorCode.CLAUDE_API_ERROR,
        "呼叫 Claude API 失敗",
        err instanceof Error ? err.message : err,
      );
    }

    const text = this.extractText(msg);
    if (text.trim().length === 0) {
      throw new AppError(ErrorCode.CLAUDE_API_ERROR, "Claude 回傳空內容");
    }
    return text;
  }

  /**
   * 從回應中取出所有 text block 並串接。
   * content block 是 union（text / tool_use / …），用型別守衛只取 text。
   */
  private extractText(msg: Anthropic.Message): string {
    if (!msg || !Array.isArray(msg.content)) return "";
    const parts: string[] = [];
    for (const block of msg.content) {
      if (block.type === "text") {
        parts.push(block.text);
      }
    }
    return parts.join("");
  }

  /**
   * 容錯 JSON 解析：
   *  • 先去掉可能的 ```json / ``` markdown 圍欄；
   *  • 直接 JSON.parse；
   *  • 失敗則用正則抓出第一個 {...}（object）或 [...]（array）區塊再 parse。
   * 全部失敗 → CLAUDE_BAD_JSON。
   */
  private parseJsonLoose(raw: string, expect: "object" | "array"): unknown {
    const stripped = raw
      .replace(/```(?:json)?/gi, "")
      .replace(/```/g, "")
      .trim();

    // 第一階段：直接 parse
    try {
      return JSON.parse(stripped);
    } catch {
      // 落到容錯抓取
    }

    // 第二階段：抓第一個對應括號區塊（非貪婪不可靠，故用首尾配對）
    const open = expect === "object" ? "{" : "[";
    const close = expect === "object" ? "}" : "]";
    const start = stripped.indexOf(open);
    const end = stripped.lastIndexOf(close);
    if (start !== -1 && end !== -1 && end > start) {
      const candidate = stripped.slice(start, end + 1);
      try {
        return JSON.parse(candidate);
      } catch {
        // 落到拋錯
      }
    }

    throw new AppError(ErrorCode.CLAUDE_BAD_JSON, "無法從 Claude 回應中解析出合法 JSON", { raw });
  }

  /** 產生今天的 YYYY-MM-DD 字串（本機時區），供截止日換算用。 */
  private todayString(): string {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
}
