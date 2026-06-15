// ── 前端 → Node sidecar 的 HTTP 客戶端（型別化）──
// 前端（webview）不能直接跑 Node 套件，故所有重服務都在 sidecar，
// 這裡集中封裝呼叫；元件只 import 本檔。

import type {
  AnalyzeRequest,
  AnalyzeResponse,
  ApiErrorBody,
  IngestRequest,
  QueryRequest,
  TranslateRequest,
  TranscribeLang,
  SavedMeeting,
  MeetingListItem,
  ChatTurn,
  ComposeExportRequest,
  ComposeExportResponse,
} from "../shared/types";

// sidecar 監聽位址（對應 .env 的 SIDECAR_PORT；前端固定走本機回環）
const BASE = "http://127.0.0.1:8765";

/** 包一層 fetch：非 2xx 時把 sidecar 的結構化錯誤拋出。 */
async function post<TReq, TRes>(path: string, body: TReq): Promise<TRes> {
  let resp: Response;
  try {
    resp = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("無法連線到本機服務（sidecar 尚未啟動？）");
  }
  if (!resp.ok) {
    const err = (await resp.json().catch(() => null)) as ApiErrorBody | null;
    throw new Error(err?.error?.message ?? `服務錯誤（${resp.status}）`);
  }
  return (await resp.json()) as TRes;
}

/** 健康檢查：sidecar 是否就緒。 */
export async function health(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/health`);
    return r.ok;
  } catch {
    return false;
  }
}

/** 把一場會議的逐字稿切片並寫入向量庫（建立跨會議記憶）。 */
export function ingestMeeting(req: IngestRequest): Promise<{ chunks: number }> {
  return post("/ingest", req);
}

/** 跨會議語意檢索，回傳組裝好的背景文字。 */
export function queryMemory(req: QueryRequest): Promise<{ context: string }> {
  return post("/query", req);
}

/** 主動式分析：摘要 + 歷史衝突比對 + 行動方針。 */
export function analyze(req: AnalyzeRequest): Promise<AnalyzeResponse> {
  return post("/analyze", req);
}

/** 翻譯（保留時間戳記）。 */
export function translate(req: TranslateRequest): Promise<{ translated: string }> {
  return post("/translate", req);
}

/** 語音轉文字：上傳錄音（base64 WAV）→ 帶時間戳記逐字稿。lang 控制輸出語言。 */
export function transcribe(req: {
  audio: string;
  mimeType: string;
  lang?: TranscribeLang;
}): Promise<{ transcript: string }> {
  return post("/transcribe", req);
}

/** AI 助理對話（結合當前逐字稿 + 跨會議記憶）。 */
export function chat(req: {
  question: string;
  transcript: string;
  history: ChatTurn[];
}): Promise<{ answer: string }> {
  return post("/chat", req);
}

/** AI 客製匯出：依格式＋白話指示，請 Gemini 把會議資料重組成通用文件區塊。 */
export function composeExport(req: ComposeExportRequest): Promise<ComposeExportResponse> {
  return post("/export/compose", req);
}

/** 會議存檔（加密落地，同 id 覆蓋）。 */
export function saveMeeting(meeting: SavedMeeting): Promise<{ item: MeetingListItem }> {
  return post("/meetings", meeting);
}

/** 歷史列表。 */
export async function listMeetings(): Promise<{ meetings: MeetingListItem[] }> {
  const r = await fetch(`${BASE}/meetings`);
  if (!r.ok) throw new Error(`讀取歷史失敗（${r.status}）`);
  return (await r.json()) as { meetings: MeetingListItem[] };
}

/** 讀回一場會議。 */
export async function loadMeeting(id: string): Promise<{ meeting: SavedMeeting }> {
  const r = await fetch(`${BASE}/meetings/${encodeURIComponent(id)}`);
  if (!r.ok) throw new Error(`載入會議失敗（${r.status}）`);
  return (await r.json()) as { meeting: SavedMeeting };
}

/** 刪除一場會議。 */
export async function deleteMeeting(id: string): Promise<{ ok: true }> {
  const r = await fetch(`${BASE}/meetings/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!r.ok) throw new Error(`刪除會議失敗（${r.status}）`);
  return (await r.json()) as { ok: true };
}

/** 加密保存一段文字（逐字稿/摘要）到本機。 */
export function vaultSave(req: {
  id: string;
  data: string;
  secretKey: string;
}): Promise<{ ok: true }> {
  return post("/vault/save", req);
}

/** 解密讀取。 */
export function vaultLoad(req: {
  id: string;
  secretKey: string;
}): Promise<{ data: string }> {
  return post("/vault/load", req);
}
