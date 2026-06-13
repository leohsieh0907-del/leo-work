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

/** 語音轉文字：上傳錄音（base64 WAV）→ 帶時間戳記逐字稿。 */
export function transcribe(req: { audio: string; mimeType: string }): Promise<{ transcript: string }> {
  return post("/transcribe", req);
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
