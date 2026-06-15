// ════════════════════════════════════════════════════════════════════
//  全專案共用型別契約（前端 webview 與 Node sidecar 皆 import 此檔）
//  放在 src/shared/ 以同時被兩邊的 tsconfig 納入。
// ════════════════════════════════════════════════════════════════════

// ─────────────── 逐字稿 / 切片 ───────────────

/** Whisper 轉寫出的單一語句片段（帶時間戳記）。 */
export interface TranscriptSegment {
  /** 起始秒數 */
  start: number;
  /** 結束秒數 */
  end: number;
  /** 發言人標籤；未知為 undefined */
  speaker?: string;
  text: string;
}

/** 會議中繼資料。 */
export interface MeetingMeta {
  meetingId: string;
  /** ISO8601 會議日期，如 "2026-06-13T10:00:00+08:00" */
  meetingDate: string;
  title?: string;
}

/**
 * 向量庫中的一個文本切片（滑動視窗產生）。
 * 每個 Chunk 強制攜帶時間與會議來源，供跨會議檢索時還原上下文。
 */
export interface Chunk {
  /** 全域唯一 id（`${meetingId}::${index}`） */
  id: string;
  text: string;
  /** 切片涵蓋的起始時間（秒） */
  timestampStart: number;
  /** 切片涵蓋的結束時間（秒） */
  timestampEnd: number;
  meetingId: string;
  /** ISO8601 */
  meetingDate: string;
  /** 嵌入向量；addChunks 計算後填入，查詢結果不一定帶回 */
  vector?: number[];
}

// ─────────────── 階段三 AI 輸出 ───────────────

/** 主動式分析結果（嚴格 JSON，供前端渲染）。 */
export interface ProactiveAnalysis {
  /** 會議主題 */
  theme: string;
  /** 關鍵討論摘要（條列） */
  key_summary: string[];
  /** 與歷史會議的衝突點（橫向比對；無則空陣列） */
  historical_conflicts: string[];
}

/** 自動提取的待辦事項。 */
export interface ActionItem {
  /** 任務具體內容 */
  task: string;
  /** 被指派的負責人；語意不明為 "未指定" */
  assignee: string;
  /** 預估截止日（Claude 依當前日期換算出的具體日期，如 "2026-06-20"）；無則 "未指定" */
  deadline: string;
}

/** 翻譯支援語言。 */
export type TargetLanguage = "zh" | "en" | "ja" | "ko";

/** 逐字稿轉錄語言：auto＝原文（非中文句附繁中翻譯）、zh＝一律繁中、en＝一律英文。 */
export type TranscribeLang = "auto" | "zh" | "en";

/** 嵌入來源切換。 */
export type EmbeddingProvider = "local" | "openai" | "ollama";

// ─────────────── 會議存檔 ───────────────

/** 一場已存檔的完整會議（加密落地）。 */
export interface SavedMeeting {
  id: string;
  title: string;
  /** 會議日期 ISO8601 */
  date: string;
  transcript: string;
  analysis: ProactiveAnalysis | null;
  actionItems: ActionItem[];
  /** 存檔時間 ISO8601 */
  savedAt: string;
}

/** 歷史列表項目（中繼資料；不含逐字稿內容）。 */
export interface MeetingListItem {
  id: string;
  title: string;
  date: string;
  savedAt: string;
}

/** AI 助理聊天的一輪對話。 */
export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}

// ─────────────── 結構化錯誤 ───────────────

/** 跨模組統一錯誤代碼（前端可據此顯示對應提示）。 */
export enum ErrorCode {
  // 音訊
  AUDIO_UNSUPPORTED_FORMAT = "AUDIO_UNSUPPORTED_FORMAT",
  AUDIO_HEADER_CORRUPT = "AUDIO_HEADER_CORRUPT",
  AUDIO_UNREPAIRABLE = "AUDIO_UNREPAIRABLE",
  // 加密
  CRYPTO_KEY_INVALID = "CRYPTO_KEY_INVALID",
  CRYPTO_FILE_CORRUPT = "CRYPTO_FILE_CORRUPT",
  CRYPTO_DECRYPT_FAILED = "CRYPTO_DECRYPT_FAILED",
  // 向量 / 嵌入
  EMBED_FAILED = "EMBED_FAILED",
  VECTOR_DB_ERROR = "VECTOR_DB_ERROR",
  // Claude
  CLAUDE_API_ERROR = "CLAUDE_API_ERROR",
  CLAUDE_BAD_JSON = "CLAUDE_BAD_JSON",
  // 通用
  CONFIG_MISSING = "CONFIG_MISSING",
  IO_ERROR = "IO_ERROR",
  INVALID_INPUT = "INVALID_INPUT",
}

/** 帶結構化代碼的錯誤；service 一律拋這個，sidecar 再轉成 HTTP 回應。 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = details;
  }
  /** 序列化成可回傳前端的形狀。 */
  toJSON(): { code: ErrorCode; message: string; details?: unknown } {
    return { code: this.code, message: this.message, details: this.details };
  }
}

// ─────────────── Sidecar HTTP DTO（前後端共用）───────────────

export interface AnalyzeRequest {
  currentTranscript: string;
  /** 是否自動檢索歷史背景（跨會議記憶） */
  useHistory?: boolean;
  historyLimit?: number;
}

export interface AnalyzeResponse {
  analysis: ProactiveAnalysis;
  actionItems: ActionItem[];
  /** 實際採用的歷史背景文字（除錯/顯示用） */
  historicalContext: string;
}

export interface IngestRequest {
  meeting: MeetingMeta;
  segments: TranscriptSegment[];
}

export interface QueryRequest {
  query: string;
  limit?: number;
}

export interface TranslateRequest {
  transcript: string;
  targetLanguage: TargetLanguage;
}

/** 統一 API 失敗回應。 */
export interface ApiErrorBody {
  error: { code: ErrorCode; message: string; details?: unknown };
}

// ════════════════ 雙源收音：跨邊界 DTO（前端 + sidecar 共用）════════════════

/** 收音來源。 */
export type AudioSourceKind = "computer" | "phone";

/** VU 音量訊號（給前端訊號條）。 */
export interface VuLevel {
  /** 均方根能量 0..1 */
  rms: number;
  /** 峰值 0..1 */
  peak: number;
  /** 分貝（約 -100..0 dBFS） */
  db: number;
}

/** 引擎狀態。 */
export interface AudioEngineStatus {
  active: boolean;
  source: AudioSourceKind | null;
  phoneConnected: boolean;
  sampleRate: number;
  /** AGC 目前增益倍率 */
  gain: number;
}

/** 手機連線資訊（QR + Token）。 */
export interface PhoneSession {
  /** 手機要開的網址（https，帶 token） */
  url: string;
  token: string;
  /** QR Code 的 data URL（直接塞 <img src>） */
  qrDataUrl: string;
  /** 偵測到的區網 IP */
  lanIp: string;
  /** WSS 埠 */
  port: number;
}

/** 系統音訊裝置列舉結果。 */
export interface AudioDeviceList {
  inputs: string[];
  /** 推測為 loopback / 立體聲混音的裝置（可能為空） */
  loopbackCandidates: string[];
}

// ════════════════ 雙軌路由（AudioIngestionRouter）跨邊界 DTO ════════════════

/** 雙軌引擎四態狀態機。 */
export enum AudioSourceState {
  DISCONNECTED = "DISCONNECTED",
  BLUETOOTH_SYNCING = "BLUETOOTH_SYNCING",
  WEBRTC_STREAMING = "WEBRTC_STREAMING",
  LOCAL_RECORDING = "LOCAL_RECORDING",
}

/** 音訊來源識別。 */
export type AudioSourceId = "bluetooth" | "webrtc" | "local";

/** 來源優先級（WebRTC 即時串流時，藍牙傳輸降為背景低優先）。 */
export type SourcePriority = "foreground" | "background";

/** 藍牙斷點續傳進度。 */
export interface BluetoothTransferStatus {
  connected: boolean;
  /** 是否正在傳輸檔案 */
  transferring: boolean;
  /** 進度 0..1 */
  progress: number;
  /** 目前優先級 */
  priority: SourcePriority;
  /** 已接收位元組 / 總位元組（已知時） */
  receivedBytes: number;
  totalBytes: number | null;
}

/** WebRTC 即時通道狀態。 */
export interface WebRtcStatus {
  connected: boolean;
  /** 重組佇列目前深度（封包數） */
  reorderQueueDepth: number;
  /** 累計丟棄（過期/重複）封包 */
  droppedPackets: number;
}

/** 雙軌路由整體狀態（推播給前端 Zustand）。 */
export interface RouterStatus {
  state: AudioSourceState;
  activeSourceId: AudioSourceId | null;
  bluetooth: BluetoothTransferStatus;
  webrtc: WebRtcStatus;
  /** AGC 目前增益 */
  gain: number;
}

/** /events WebSocket 推播給前端的事件。 */
export type AudioEvent =
  | { type: "vu"; level: VuLevel; source: AudioSourceKind | AudioSourceId }
  | { type: "status"; status: AudioEngineStatus }
  | { type: "transcript"; segments: { start: number; end: number; text: string }[] }
  | { type: "error"; message: string }
  // 收音整檔精修：前景 session 停止後，回報這段錄音是否可精修帶入會議
  | { type: "recording"; ready: boolean; seconds: number; truncated: boolean }
  // 雙軌路由事件
  | { type: "router"; status: RouterStatus }
  | { type: "transfer"; sourceId: AudioSourceId; progress: number; done: boolean }
  // WebRTC 信令：sidecar 端產生的 ICE candidate（trickle，給瀏覽器 peer）
  | { type: "ice"; candidate: unknown };
