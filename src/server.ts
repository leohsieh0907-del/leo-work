// ════════════════════════════════════════════════════════════════════
//  Node Sidecar 伺服器
//  把五大服務（加密 / 音訊修復 / 切片 / 嵌入 / 向量庫 / Claude）包成本機
//  HTTP API，供 Tauri 前端（webview）呼叫。只綁定 127.0.0.1，不對外。
// ════════════════════════════════════════════════════════════════════

import "dotenv/config";
import path from "node:path";
import http from "node:http";
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import { WebSocketServer, type WebSocket } from "ws";

import { SecurityManager } from "./services/SecurityManager";
import { MeetingStore } from "./services/MeetingStore";
import { AudioRepair } from "./services/AudioRepair";
import { TextSplitter } from "./services/TextSplitter";
import { EmbeddingService } from "./services/EmbeddingService";
import { VectorStore } from "./services/VectorStore";
import { ClaudeService } from "./services/ClaudeService";
import { OllamaLlmService } from "./services/OllamaLlmService";
import { GeminiLlmService } from "./services/GeminiLlmService";
import type { LlmService } from "./services/llm/types";
import { SystemAudioCapture } from "./services/audio/SystemAudioCapture";
import { PhoneBridgeServer } from "./services/audio/PhoneBridgeServer";
import { Agc } from "./services/audio/Agc";
import { StreamingTranscriber } from "./services/audio/StreamingTranscriber";
import { AudioCaptureEngine } from "./services/audio/AudioCaptureEngine";
import { WebRtcSoftwareSource } from "./services/audio/WebRtcSoftwareSource";
import { BluetoothHardwareSource } from "./services/audio/BluetoothHardwareSource";
import { NobleBleTransport } from "./services/audio/NobleBleTransport";
import { CaptureSourceAdapter } from "./services/audio/CaptureSourceAdapter";
import { AudioIngestionRouter } from "./services/audio/AudioIngestionRouter";
import type { AudioEvent, AudioSourceKind, AudioSourceId } from "./services/audio/types";
import {
  AppError,
  ErrorCode,
  type AnalyzeRequest,
  type AnalyzeResponse,
  type EmbeddingProvider,
  type IngestRequest,
  type QueryRequest,
  type TranslateRequest,
  type SavedMeeting,
  type ChatTurn,
} from "./shared/types";

// ─────────────── 環境設定 ───────────────

const PORT = Number(process.env.SIDECAR_PORT ?? 8765);
const PHONE_PORT = Number(process.env.PHONE_BRIDGE_PORT ?? 8443);
const SALT = required("ENCRYPTION_SALT");
const DB_PATH = process.env.LOCAL_DB_PATH ?? "./data/lancedb";
const VAULT_DIR = path.resolve("data/vault");
const EMBED_PROVIDER = (process.env.EMBEDDING_PROVIDER ?? "local") as EmbeddingProvider;
// LLM 來源：預設本地 Ollama（完全免費、離線）；設成 "claude" 才走付費 API。
const LLM_PROVIDER = process.env.LLM_PROVIDER ?? "ollama";

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new AppError(ErrorCode.CONFIG_MISSING, `缺少必要環境變數：${name}`);
  }
  return v;
}

// ─────────────── 服務實例化 ───────────────

const security = new SecurityManager(SALT);
const meetingStore = new MeetingStore(security, SALT, path.resolve("data"));
const audioRepair = new AudioRepair();
const splitter = new TextSplitter({ chunkSize: 300, overlap: 50 });
const embedding = new EmbeddingService({
  provider: EMBED_PROVIDER,
  openaiApiKey: process.env.OPENAI_API_KEY,
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL,
  ollamaModel: process.env.OLLAMA_EMBED_MODEL,
});
const vectorStore = new VectorStore({ dbPath: DB_PATH, embedding });

// LLM 來源：
//   ollama（預設）= 本地、$0、離線、無需金鑰
//   gemini        = 雲端、有免費額度、不吃 GPU、品質好（需 GEMINI_API_KEY）
//   claude        = 雲端、品質最佳、付費（需 ANTHROPIC_API_KEY）
function buildLlm(): LlmService {
  if (LLM_PROVIDER === "claude") {
    return new ClaudeService({
      apiKey: required("ANTHROPIC_API_KEY"),
      model: process.env.ANTHROPIC_MODEL,
    });
  }
  if (LLM_PROVIDER === "gemini") {
    return new GeminiLlmService({
      apiKey: required("GEMINI_API_KEY"),
      model: process.env.GEMINI_MODEL,
    });
  }
  return new OllamaLlmService({
    baseUrl: process.env.OLLAMA_BASE_URL,
    model: process.env.OLLAMA_LLM_MODEL,
  });
}
const llm: LlmService = buildLlm();

// 語音轉文字（STT）：用 Gemini 直接聽錄音音訊（需 GEMINI_API_KEY；與 LLM_PROVIDER 無關）。
const geminiStt = process.env.GEMINI_API_KEY
  ? new GeminiLlmService({ apiKey: process.env.GEMINI_API_KEY, model: process.env.GEMINI_MODEL })
  : null;

// ─────────────── 雙源收音引擎 ───────────────

// /events 的 WebSocket 連線集合（前端訂閱 VU / 狀態 / 即時逐字稿）
const eventClients = new Set<WebSocket>();
function broadcast(event: AudioEvent): void {
  const payload = JSON.stringify(event);
  for (const ws of eventClients) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}

const systemCapture = new SystemAudioCapture();
const phoneBridge = new PhoneBridgeServer({ port: PHONE_PORT });
const transcriber = new StreamingTranscriber({
  modelPath: process.env.WHISPER_MODEL_PATH,
  whisperBin: process.env.WHISPER_BIN,
});
const audioEngine = new AudioCaptureEngine({
  system: systemCapture,
  phone: phoneBridge,
  agc: new Agc(),
  transcriber,
  onEvent: broadcast, // 引擎把 vu/status/transcript 事件推給所有前端訂閱者
});

// ─────────────── 雙軌整合引擎（AudioIngestionRouter）───────────────

// WebRTC 即時源：本地 ICE candidate 透過 /events 的 "ice" 事件 trickle 給瀏覽器 peer
const webrtcSource = new WebRtcSoftwareSource({
  onIceCandidate: (candidate) => broadcast({ type: "ice", candidate }),
});

// 藍牙源：BLE 傳輸的 UUID 為 PM01-9 裝置私有協定，需原廠文件填入（此處走 env 佔位）
const bleTransport = new NobleBleTransport({
  serviceUuid: process.env.PM01_BLE_SERVICE ?? "0000feed-0000-1000-8000-00805f9b34fb",
  notifyUuid: process.env.PM01_BLE_NOTIFY ?? "0000fee1-0000-1000-8000-00805f9b34fb",
  writeUuid: process.env.PM01_BLE_WRITE ?? "0000fee2-0000-1000-8000-00805f9b34fb",
});
const bluetoothSource = new BluetoothHardwareSource({
  transport: bleTransport,
  secretKey: process.env.BLUETOOTH_SECRET_KEY, // 裝置端加密音檔的金鑰（可選）
  encryptionSalt: SALT,
  onFileSynced: ({ fileId, data }) => {
    // 「傳輸完成 → 自動解密（已在藍牙源內完成）→ 送 Claude 批次摘要」的接點。
    void runBatchSummary(fileId, data);
  },
});

// 本機系統混音包成統一 AudioSource（LOCAL_RECORDING）
const localSource = new CaptureSourceAdapter(systemCapture, "local");

const audioRouter = new AudioIngestionRouter({
  bluetooth: bluetoothSource,
  webrtc: webrtcSource,
  local: localSource,
  agc: new Agc(),
  transcriber,
  onEvent: broadcast,
});

/**
 * 藍牙同步完成後的批次摘要（best-effort）：
 * data 已是解密後的音檔位元組。若有設定 Whisper，轉寫後交 Claude 做主動式分析；
 * 否則只廣播「同步完成」。音檔格式取決於 PM01-9 裝置，實機需依其格式調整。
 */
async function runBatchSummary(fileId: string, data: Buffer): Promise<void> {
  try {
    broadcast({ type: "transfer", sourceId: "bluetooth", progress: 1, done: true });
    if (!transcriber.enabled) {
      console.log(`[batch] 已同步檔案 ${fileId}（${data.length} bytes）；未設定 Whisper，略過摘要。`);
      return;
    }
    // 註：此處可把 data 寫成暫存音檔 → Whisper 轉寫 → llm.generateProactiveAnalysis。
    // 因 PM01-9 音檔容器格式為裝置私有，實機整合時於此填入解碼/轉寫步驟。
    console.log(`[batch] 已同步並解密檔案 ${fileId}，待接 Whisper→Claude 批次摘要。`);
  } catch (e) {
    broadcast({ type: "error", message: `批次摘要失敗：${String(e)}` });
  }
}

// ─────────────── App ───────────────

const app = express();
app.use(cors({ origin: ["http://localhost:1420", "http://127.0.0.1:1420", "tauri://localhost"] }));
app.use(express.json({ limit: "50mb" })); // 容納錄音音訊的 base64（16kHz mono WAV 約 42KB/秒）

// 包裝 async route，集中錯誤處理
const wrap =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

app.get("/health", (_req, res) => {
  res.json({ ok: true, provider: EMBED_PROVIDER });
});

// 階段一：加密保存 / 解密讀取
app.post(
  "/vault/save",
  wrap(async (req, res) => {
    const { id, data, secretKey } = req.body as { id: string; data: string; secretKey: string };
    if (!id || !secretKey) throw new AppError(ErrorCode.INVALID_INPUT, "id 與 secretKey 為必填");
    const filePath = path.join(VAULT_DIR, `${sanitizeId(id)}.enc`);
    const buf = Buffer.from(data ?? "", "utf8");
    await security.encryptToFile(filePath, buf, secretKey);
    buf.fill(0); // 用畢清除明文緩衝
    res.json({ ok: true });
  }),
);

app.post(
  "/vault/load",
  wrap(async (req, res) => {
    const { id, secretKey } = req.body as { id: string; secretKey: string };
    if (!id || !secretKey) throw new AppError(ErrorCode.INVALID_INPUT, "id 與 secretKey 為必填");
    const filePath = path.join(VAULT_DIR, `${sanitizeId(id)}.enc`);
    const buf = await security.decryptFromFile(filePath, secretKey);
    const data = buf.toString("utf8");
    buf.fill(0); // 回傳後立即清除記憶體中的明文
    res.json({ data });
  }),
);

// 階段一：音訊標頭修復（匯入損壞檔時自動容錯）
app.post(
  "/audio/prepare",
  wrap(async (req, res) => {
    const { inputPath } = req.body as { inputPath: string };
    if (!inputPath) throw new AppError(ErrorCode.INVALID_INPUT, "inputPath 為必填");
    const usablePath = await audioRepair.repairIfNeeded(inputPath);
    res.json({ path: usablePath });
  }),
);

// 階段二：寫入跨會議記憶（切片 → 嵌入 → 存向量庫）
app.post(
  "/ingest",
  wrap(async (req, res) => {
    const { meeting, segments } = req.body as IngestRequest;
    if (!meeting?.meetingId || !Array.isArray(segments)) {
      throw new AppError(ErrorCode.INVALID_INPUT, "meeting 與 segments 為必填");
    }
    const chunks = splitter.splitTranscript(segments, meeting);
    await vectorStore.addChunks(chunks);
    res.json({ chunks: chunks.length });
  }),
);

// 階段二：跨會議語意檢索
app.post(
  "/query",
  wrap(async (req, res) => {
    const { query, limit } = req.body as QueryRequest;
    if (!query) throw new AppError(ErrorCode.INVALID_INPUT, "query 為必填");
    const context = await vectorStore.queryHistoricalContext(query, limit ?? 3);
    res.json({ context });
  }),
);

// 階段三：主動式分析（摘要 + 歷史衝突 + 行動方針）
app.post(
  "/analyze",
  wrap(async (req, res) => {
    const { currentTranscript, useHistory = true, historyLimit = 3 } = req.body as AnalyzeRequest;
    if (!currentTranscript) throw new AppError(ErrorCode.INVALID_INPUT, "currentTranscript 為必填");

    // 先用本次逐字稿去檢索歷史背景（跨會議記憶），再餵給 Claude 做橫向比對
    const historicalContext = useHistory
      ? await vectorStore.queryHistoricalContext(currentTranscript, historyLimit)
      : "";

    const [analysis, actionItems] = await Promise.all([
      llm.generateProactiveAnalysis(currentTranscript, historicalContext),
      llm.extractActionItems(currentTranscript),
    ]);

    const payload: AnalyzeResponse = { analysis, actionItems, historicalContext };
    res.json(payload);
  }),
);

// 語音轉文字：瀏覽器錄音（base64 WAV）→ Gemini 轉錄成帶時間戳記逐字稿
app.post(
  "/transcribe",
  wrap(async (req, res) => {
    const { audio, mimeType } = req.body as { audio?: string; mimeType?: string };
    if (!audio) throw new AppError(ErrorCode.INVALID_INPUT, "缺少 audio（base64）");
    if (!geminiStt) {
      throw new AppError(ErrorCode.CONFIG_MISSING, "語音轉錄需要 GEMINI_API_KEY，請於 .env 設定");
    }
    const transcript = await geminiStt.transcribeAudio(audio, mimeType ?? "audio/wav");
    res.json({ transcript });
  }),
);

// AI 助理對話：結合當前逐字稿 + 跨會議記憶自然回答
app.post(
  "/chat",
  wrap(async (req, res) => {
    const { question, transcript, history } = req.body as {
      question?: string;
      transcript?: string;
      history?: ChatTurn[];
    };
    if (!question) throw new AppError(ErrorCode.INVALID_INPUT, "缺少 question");
    if (!geminiStt) {
      throw new AppError(ErrorCode.CONFIG_MISSING, "AI 助理需要 GEMINI_API_KEY，請於 .env 設定");
    }
    const memory = await vectorStore.queryHistoricalContext(question, 3).catch(() => "");
    const answer = await geminiStt.chat(question, transcript ?? "", memory, history ?? []);
    res.json({ answer });
  }),
);

// ─────────────── 會議存檔 / 歷史 ───────────────

app.get(
  "/meetings",
  wrap(async (_req, res) => {
    res.json({ meetings: await meetingStore.list() });
  }),
);

app.post(
  "/meetings",
  wrap(async (req, res) => {
    const meeting = req.body as SavedMeeting;
    if (!meeting?.id || typeof meeting.transcript !== "string") {
      throw new AppError(ErrorCode.INVALID_INPUT, "meeting 需含 id 與 transcript");
    }
    const item = await meetingStore.save(meeting);
    res.json({ item });
  }),
);

app.get(
  "/meetings/:id",
  wrap(async (req, res) => {
    const meeting = await meetingStore.load(req.params.id);
    res.json({ meeting });
  }),
);

app.delete(
  "/meetings/:id",
  wrap(async (req, res) => {
    await meetingStore.remove(req.params.id);
    res.json({ ok: true });
  }),
);

// 階段三：翻譯（保留時間戳記）
app.post(
  "/translate",
  wrap(async (req, res) => {
    const { transcript, targetLanguage } = req.body as TranslateRequest;
    if (!transcript || !targetLanguage) {
      throw new AppError(ErrorCode.INVALID_INPUT, "transcript 與 targetLanguage 為必填");
    }
    const translated = await llm.translateWithTimestamps(transcript, targetLanguage);
    res.json({ translated });
  }),
);

// ─────────────── 雙源收音路由 ───────────────

// 列舉系統音訊裝置（讓使用者挑 loopback / 麥克風）
app.get(
  "/audio/devices",
  wrap(async (_req, res) => {
    const devices = await SystemAudioCapture.listDevices();
    res.json(devices);
  }),
);

// 取得手機連線 QR / token / 網址（會啟動 WSS 橋接伺服器）
app.get(
  "/audio/session",
  wrap(async (_req, res) => {
    const session = await audioEngine.getPhoneSession();
    res.json(session);
  }),
);

// 開始收音；source = "computer" | "phone"
app.post(
  "/audio/start",
  wrap(async (req, res) => {
    const { source } = req.body as { source: AudioSourceKind };
    if (source !== "computer" && source !== "phone") {
      throw new AppError(ErrorCode.INVALID_INPUT, "source 必須是 computer 或 phone");
    }
    await audioEngine.start(source);
    res.json({ status: audioEngine.status() });
  }),
);

// 停止收音
app.post(
  "/audio/stop",
  wrap(async (_req, res) => {
    await audioEngine.stop();
    res.json({ status: audioEngine.status() });
  }),
);

// 目前引擎狀態
app.get("/audio/status", (_req, res) => {
  res.json({ status: audioEngine.status() });
});

// ─────────────── 雙軌路由（AudioIngestionRouter）路由 ───────────────

// 啟用某來源為前景（bluetooth / webrtc / local）
app.post(
  "/router/activate",
  wrap(async (req, res) => {
    const { sourceId } = req.body as { sourceId: AudioSourceId };
    if (sourceId !== "bluetooth" && sourceId !== "webrtc" && sourceId !== "local") {
      throw new AppError(ErrorCode.INVALID_INPUT, "sourceId 必須是 bluetooth / webrtc / local");
    }
    await audioRouter.activate(sourceId);
    res.json({ status: audioRouter.status() });
  }),
);

// 停止前景來源
app.post(
  "/router/deactivate",
  wrap(async (_req, res) => {
    await audioRouter.deactivate();
    res.json({ status: audioRouter.status() });
  }),
);

// 觸發藍牙背景同步（不搶前景即時串流）
app.post(
  "/router/sync-bluetooth",
  wrap(async (_req, res) => {
    await audioRouter.syncBluetooth();
    res.json({ status: audioRouter.status() });
  }),
);

// 路由整體狀態
app.get("/router/status", (_req, res) => {
  res.json({ status: audioRouter.status() });
});

// WebRTC 信令：手機 offer → 回 answer
app.post(
  "/webrtc/offer",
  wrap(async (req, res) => {
    const { sdp } = req.body as { sdp: string };
    if (!sdp) throw new AppError(ErrorCode.INVALID_INPUT, "缺少 offer sdp");
    const answer = await webrtcSource.handleOffer(sdp);
    res.json({ sdp: answer });
  }),
);

// WebRTC 信令：手機 ICE candidate
app.post(
  "/webrtc/ice",
  wrap(async (req, res) => {
    const { candidate } = req.body as { candidate: unknown };
    await webrtcSource.addIceCandidate(candidate);
    res.json({ ok: true });
  }),
);

// ─────────────── 統一錯誤處理 ───────────────

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof AppError) {
    const status = httpStatusFor(err.code);
    res.status(status).json({ error: err.toJSON() });
    return;
  }
  const message = err instanceof Error ? err.message : "未知錯誤";
  console.error("[sidecar] 未預期錯誤：", err);
  res.status(500).json({ error: { code: ErrorCode.IO_ERROR, message } });
});

function httpStatusFor(code: ErrorCode): number {
  switch (code) {
    case ErrorCode.INVALID_INPUT:
    case ErrorCode.AUDIO_UNSUPPORTED_FORMAT:
      return 400;
    case ErrorCode.CRYPTO_DECRYPT_FAILED:
    case ErrorCode.CRYPTO_KEY_INVALID:
      return 403;
    case ErrorCode.CONFIG_MISSING:
      return 500;
    default:
      return 500;
  }
}

/** 避免 id 被用來做路徑跳脫（../）。 */
function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}

// ─────────────── 啟動 ───────────────

async function main() {
  await vectorStore.init(); // 建表 / 連線

  const server = http.createServer(app);

  // 前端訂閱即時事件（VU 訊號條 / 引擎狀態 / 即時逐字稿）的 WebSocket
  const wss = new WebSocketServer({ server, path: "/events" });
  wss.on("connection", (ws) => {
    eventClients.add(ws);
    // 一連上先推一次目前狀態
    ws.send(JSON.stringify({ type: "status", status: audioEngine.status() } satisfies AudioEvent));
    ws.on("close", () => eventClients.delete(ws));
    ws.on("error", () => eventClients.delete(ws));
  });

  server.listen(PORT, "127.0.0.1", () => {
    console.log(`[sidecar] 已啟動於 http://127.0.0.1:${PORT}（嵌入來源：${EMBED_PROVIDER}）`);
    console.log(`[sidecar] 事件 WebSocket：ws://127.0.0.1:${PORT}/events`);
  });
}

main().catch((e) => {
  console.error("[sidecar] 啟動失敗：", e);
  process.exit(1);
});
