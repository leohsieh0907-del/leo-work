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
const GLA_HOST = "https://generativelanguage.googleapis.com";
const API_BASE = `${GLA_HOST}/v1beta/models`;
/**
 * inline_data 受 Gemini ~20MB 請求上限（約 7–8 分鐘 16kHz 音訊）。超過此位元組數就改走
 * Files API 上傳取得 file_uri。12MB（base64 後 ~16MB）穩在 20MB 請求上限內。
 */
const INLINE_MAX_BYTES = 12 * 1024 * 1024;

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
          type: { type: "string", enum: ["heading", "paragraph", "bullets", "table", "chart"] },
          text: { type: "string" },
          items: { type: "array", items: { type: "string" } },
          columns: { type: "array", items: { type: "string" } },
          rows: { type: "array", items: { type: "array", items: { type: "string" } } },
          chartType: { type: "string", enum: ["bar", "line", "pie"] },
          categories: { type: "array", items: { type: "string" } },
          series: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                values: { type: "array", items: { type: "number" } },
              },
              required: ["name", "values"],
            },
          },
        },
        required: ["type"],
      },
    },
  },
  required: ["title", "blocks"],
};

// 合併分析：主動式分析 ＋ 行動方針 一次回（省一半請求）。
const ANALYZE_ALL_SCHEMA = {
  type: "object",
  properties: {
    theme: { type: "string" },
    key_summary: { type: "array", items: { type: "string" } },
    historical_conflicts: { type: "array", items: { type: "string" } },
    action_items: {
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
  required: ["theme", "key_summary", "historical_conflicts", "action_items"],
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

    // 空回應多半是 RECITATION 安全過濾誤判（HTTP 200 但 content 為空）；換一次再試，最多 3 次。
    for (let attempt = 0; attempt < 3; attempt++) {
      let resp: Response;
      try {
        resp = await fetchGeminiWithRetry(url, body);
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
        throw new AppError(ErrorCode.CLAUDE_API_ERROR, geminiErrorMessage("Gemini API 錯誤：", resp.status, msg));
      }

      const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
      if (text) return text;
    }
    throw new AppError(
      ErrorCode.CLAUDE_API_ERROR,
      "Gemini 回應為空（可能被安全過濾 RECITATION 或額度用盡）",
    );
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

  /** 一次回主動式分析 ＋ 行動方針（合併兩個請求，省一半免費額度）。 */
  async analyzeAll(
    currentTranscript: string,
    historicalContext: string,
  ): Promise<{ analysis: ProactiveAnalysis; actionItems: ActionItem[] }> {
    const system =
      `今天是 ${todayString()}。你是專業會議分析助理，只根據提供的『當前會議逐字稿』實際內容分析，所有結論都要有逐字稿依據，嚴禁虛構。\n` +
      "theme：一句話總結會議在談什麼。\n" +
      "key_summary：關鍵決定與討論重點，每點一句、要具體。\n" +
      "historical_conflicts：當前內容與『歷史會議背景』明顯不一致之處；沒有歷史或無衝突就給空陣列。\n" +
      "action_items：要有人去執行的待辦——task 具體要做什麼；assignee 負責人（沒明講寫『未指定』）；" +
      "deadline 把『下週五/月底前』等相對時間依今天日期換算成 YYYY-MM-DD（沒提到寫『未指定』）；沒有任何待辦就給空陣列。\n" +
      "全程使用繁體中文。";

    const user =
      "=== 當前會議逐字稿 ===\n" +
      currentTranscript +
      "\n\n=== 歷史會議背景 ===\n" +
      (historicalContext.trim() || "（無歷史背景）");

    const raw = await this.generate(system, user, ANALYZE_ALL_SCHEMA);
    const obj = safeJsonObject(raw);
    const arr = Array.isArray(obj.action_items) ? obj.action_items : [];
    return {
      analysis: {
        theme: String(obj.theme ?? "").trim() || "（未能產生主題）",
        key_summary: toStrArray(obj.key_summary),
        historical_conflicts: toStrArray(obj.historical_conflicts),
      },
      actionItems: arr
        .filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null)
        .map((x) => ({
          task: String(x.task ?? "").trim(),
          assignee: String(x.assignee ?? "未指定").trim() || "未指定",
          deadline: String(x.deadline ?? "未指定").trim() || "未指定",
        }))
        .filter((a) => a.task.length > 0),
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
    // 小檔直接 inline；大檔（超過 inline 安全上限）先上傳 Files API 取 file_uri，
    // 避免長會議整檔精修被 ~20MB 請求上限擋下。
    const approxBytes = Math.floor((audioBase64.length * 3) / 4);
    const audioPart =
      approxBytes > INLINE_MAX_BYTES
        ? { file_data: { mime_type: mimeType, file_uri: await this.uploadAudio(audioBase64, mimeType) } }
        : { inline_data: { mime_type: mimeType, data: audioBase64 } };
    const body = {
      system_instruction: { parts: [{ text: system }] },
      contents: [
        {
          role: "user",
          parts: [audioPart, { text: "請逐字轉錄這段錄音。" }],
        },
      ],
      generationConfig: { temperature: 0.1 },
    };

    let resp: Response;
    try {
      resp = await fetchGeminiWithRetry(url, body);
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
        geminiErrorMessage("Gemini 轉錄錯誤：", resp.status, data?.error?.message ?? `HTTP ${resp.status}`),
      );
    }
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    if (!text) {
      throw new AppError(ErrorCode.CLAUDE_API_ERROR, "Gemini 轉錄回應為空（音訊太短或格式不支援）");
    }
    return text.trim();
  }

  /**
   * 大檔音訊走 Gemini Files API：resumable 上傳 → 輪詢到 ACTIVE → 回 file_uri。
   * inline_data 受 ~20MB 請求上限，較長的整檔精修（>~8 分鐘）必須改用這條路。
   * 檔案在 Google 端暫存 48 小時，轉錄完即可不管（不主動刪）。
   */
  private async uploadAudio(audioBase64: string, mimeType: string): Promise<string> {
    const bytes = Buffer.from(audioBase64, "base64");

    // 1) 開 resumable 上傳 session，從回應 header 取得上傳 URL
    let startResp: Response;
    try {
      startResp = await fetch(`${GLA_HOST}/upload/v1beta/files?key=${this.apiKey}`, {
        method: "POST",
        headers: {
          "X-Goog-Upload-Protocol": "resumable",
          "X-Goog-Upload-Command": "start",
          "X-Goog-Upload-Header-Content-Length": String(bytes.length),
          "X-Goog-Upload-Header-Content-Type": mimeType,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ file: { display_name: "meeting-audio" } }),
      });
    } catch (e) {
      throw new AppError(
        ErrorCode.CLAUDE_API_ERROR,
        `無法連線到 Gemini Files API：${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const uploadUrl = startResp.headers.get("x-goog-upload-url");
    if (!startResp.ok || !uploadUrl) {
      throw new AppError(
        ErrorCode.CLAUDE_API_ERROR,
        geminiErrorMessage("Gemini 上傳起始失敗：", startResp.status, `HTTP ${startResp.status}`),
      );
    }

    // 2) 上傳位元組並 finalize
    const upResp = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        "Content-Length": String(bytes.length),
        "X-Goog-Upload-Offset": "0",
        "X-Goog-Upload-Command": "upload, finalize",
      },
      body: bytes,
    });
    const upJson = (await upResp.json().catch(() => null)) as
      | { file?: { name?: string; uri?: string; state?: string } }
      | null;
    const file = upJson?.file;
    if (!upResp.ok || !file?.uri || !file?.name) {
      throw new AppError(
        ErrorCode.CLAUDE_API_ERROR,
        geminiErrorMessage("Gemini 上傳失敗：", upResp.status, `HTTP ${upResp.status}`),
      );
    }

    // 3) 輪詢直到 ACTIVE（音訊處理通常數秒；上限約 60s 防卡死）
    let state = file.state ?? "PROCESSING";
    for (let i = 0; state === "PROCESSING" && i < 30; i++) {
      await sleep(2000);
      const stResp = await fetch(`${GLA_HOST}/v1beta/${file.name}?key=${this.apiKey}`);
      const stJson = (await stResp.json().catch(() => null)) as { state?: string } | null;
      state = stJson?.state ?? state;
    }
    if (state !== "ACTIVE") {
      throw new AppError(
        ErrorCode.CLAUDE_API_ERROR,
        "Gemini 音檔處理逾時或失敗，請改用較短的收音或稍後再試。",
      );
    }
    return file.uri;
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
    const body = {
      system_instruction: { parts: [{ text: system }] },
      contents,
      generationConfig: { temperature: 0.3 },
    };
    let resp: Response;
    try {
      resp = await fetchGeminiWithRetry(url, body);
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
        geminiErrorMessage("Gemini 對話錯誤：", resp.status, data?.error?.message ?? `HTTP ${resp.status}`),
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
          ? "這是 PPT 簡報：要精簡。用 heading 當投影片標題、bullets 當要點（每個 heading 會開一張新投影片）；文字短、條列化，不要長段落。\n" +
            "**數字一律放表格（重要）**：凡可量化的數字（預算、金額、數量、佔比、時程、指標等），" +
            "**請整理成 table（第一欄＝項目名稱，其餘欄＝純數值），不要只把數字塞在 bullets 文字裡**。" +
            "系統會自動把這種數值表畫成圖表（單一數值欄→圓餅、多欄→長條）。沒有真實數字時不要硬湊。"
          : "這是 Word 文件：可用 heading 分節、paragraph 寫敘述、bullets 列重點、table 放結構化資料。";

    const system =
      `你是專業的會議文件製作助理，要把會議資料整理成一份「${fmtName}」的內容（結構化區塊）。\n` +
      "嚴格遵守使用者指示（語氣、重點取捨、要不要新增欄位/段落、要不要畫圖等）。\n" +
      "只能依據提供的會議資料，不可虛構事實或捏造數字；使用者要求新增的欄位若資料沒有，留空或標『未提供』。\n" +
      fmtRule +
      "\n區塊類型：heading(填 text)、paragraph(填 text)、bullets(填 items[])、table(填 columns[] 與 rows[][])、chart(填 chartType、categories[]、series[])。\n" +
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

    // 討論完再產出：把與 AI 的多輪討論當成最高優先的依據。
    const discussion = (req.history ?? [])
      .filter((h) => h.text?.trim())
      .map((h) => `${h.role === "assistant" ? "AI" : "我"}：${h.text.trim()}`)
      .join("\n");
    const directive = req.instruction.trim() || "請依我們的討論整理出這份文件的內容。";

    const user =
      `=== 使用者指示 ===\n${directive}\n\n` +
      (discussion
        ? `=== 我與 AI 的討論（請把討論中的結論與決定確實反映到文件，與會議資料衝突時以討論為準）===\n${discussion}\n\n`
        : "") +
      `=== 會議資料 ===\n${source}`;

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
    } else if (r.type === "chart") {
      const chartType = r.chartType === "line" || r.chartType === "pie" ? r.chartType : "bar";
      const categories = toStrArray(r.categories);
      const series = toSeries(r.series);
      if (categories.length && series.length) {
        blocks.push({
          type: "chart",
          chartType,
          text: String(r.text ?? "").trim() || undefined,
          categories,
          series,
        });
      }
    }
  }
  return { title: String(obj.title ?? "").trim() || fallbackTitle, blocks };
}

/**
 * 呼叫 Gemini，遇暫時性過載/限流（429、5xx，例如 "This model is currently experiencing
 * high demand"）時自動退避重試，最多 retries 次。非暫時性錯誤或成功直接回 Response。
 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 從 429 回應解析建議重試毫秒數（RetryInfo.retryDelay 或訊息「retry in Ns」）；無則 null。 */
async function parse429RetryMs(resp: Response): Promise<number | null> {
  const data = (await resp.json().catch(() => null)) as
    | { error?: { message?: string; details?: { retryDelay?: string }[] } }
    | null;
  const fromDetails = data?.error?.details
    ?.map((d) => d?.retryDelay)
    .find((s): s is string => typeof s === "string");
  const m = /([\d.]+)\s*s/.exec(fromDetails ?? data?.error?.message ?? "");
  return m ? Math.ceil(parseFloat(m[1]) * 1000) : null;
}

/**
 * 呼叫 Gemini 並處理暫時性失敗：
 *  - 5xx 伺服器過載 → 短退避重試（0.8s、1.6s）。
 *  - 429 限流 → 讀「retry in Ns」：**短等待（每分鐘 RPM，≤15s）就等一下再試一次**；
 *    長等待（每日上限）直接回報，不空轉燒額度。
 * 其餘錯誤或重試用盡則回傳該 Response 由上層處理。
 */
async function fetchGeminiWithRetry(url: string, body: unknown, retries = 2): Promise<Response> {
  const overload = new Set([500, 502, 503, 504]);
  for (let attempt = 0; ; attempt++) {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (resp.ok || attempt >= retries) return resp;

    if (overload.has(resp.status)) {
      await sleep((attempt + 1) * 800);
      continue;
    }
    if (resp.status === 429) {
      const waitMs = await parse429RetryMs(resp.clone()); // clone：留原 body 給上層讀
      if (waitMs !== null && waitMs <= 15000) {
        await sleep(waitMs + 500);
        continue;
      }
    }
    return resp;
  }
}

/** 把 Gemini 錯誤轉成易讀訊息；429（額度/限流）給中文友善提示＋約略恢復時間。 */
function geminiErrorMessage(prefix: string, status: number, raw: string): string {
  if (status === 429) {
    const m = /([\d.]+)\s*s/.exec(raw);
    const secs = m ? Math.ceil(parseFloat(m[1])) : null;
    if (secs && secs > 120) {
      return `Gemini 免費額度已達上限，約 ${Math.ceil(secs / 60)} 分鐘後恢復；可稍候再試，或換金鑰／開啟付費。`;
    }
    return `Gemini 免費額度暫時用盡（每分鐘上限）${secs ? `，約 ${secs} 秒後恢復` : ""}，請稍候再試一次。`;
  }
  return `${prefix}${raw}`;
}

/** 解析 chart 的 series：[{name, values:number[]}]，濾掉空/壞資料。 */
function toSeries(v: unknown): { name: string; values: number[] }[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
    .map((s) => ({
      name: String(s.name ?? "").trim() || "數據",
      values: Array.isArray(s.values)
        ? s.values.map((n) => Number(n)).filter((n) => Number.isFinite(n))
        : [],
    }))
    .filter((s) => s.values.length > 0);
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
