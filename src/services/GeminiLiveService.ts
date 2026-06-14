// ── Gemini Live 即時逐字稿轉接（sidecar 內部）──
// 維持一條到 Gemini Live API 的 WebSocket，把瀏覽器串流來的 16kHz/mono/Int16 PCM
// 餵進去，取回「使用者輸入語音轉文字」(inputTranscription) 的串流文字。
//
// 兩個重點處理：
//   1. 15 分鐘 session 上限：upstream 關閉（goAway / 逾時 / 暫斷）但本端仍在錄音時，
//      自動重連續錄，重連空窗期間的音訊先緩衝、setup 完成後補送。
//   2. 壓制 AI 回話：responseModalities=TEXT（不產生語音）+ 系統指令要求只記錄不回應，
//      且本服務只讀 inputTranscription，模型自己的 modelTurn 一律忽略。

import { WebSocket, type RawData } from "ws";

const LIVE_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

const SYSTEM_INSTRUCTION =
  "你是逐字稿引擎。只負責把聽到的語音忠實記錄成文字，永遠不要回答、不要評論、不要回應、不要主動說話。";

export interface GeminiLiveOptions {
  apiKey: string;
  model?: string; // 需支援 TEXT 輸出的半串接（half-cascade）Live 模型
}

export class GeminiLiveService {
  private readonly apiKey: string;
  private readonly model: string;
  private upstream: WebSocket | null = null;
  private ready = false; // setupComplete 收到後才能送音訊
  private closed = false; // 本端已主動停止（停止錄音）
  private pending: string[] = []; // 重連/尚未 setup 完成期間緩衝的 base64 PCM
  private onText: (text: string) => void = () => {};
  private onError: (msg: string) => void = () => {};

  constructor(opts: GeminiLiveOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? "gemini-3.1-flash-live-preview";
  }

  /** 開始一段即時轉錄 session。 */
  start(onText: (t: string) => void, onError: (m: string) => void): void {
    this.onText = onText;
    this.onError = onError;
    this.closed = false;
    this.connect();
  }

  private connect(): void {
    if (this.closed) return;
    this.ready = false;
    const ws = new WebSocket(`${LIVE_URL}?key=${this.apiKey}`);
    this.upstream = ws;

    ws.on("open", () => {
      // Live 模型只支援 AUDIO 輸出；我們要的是 inputAudioTranscription（使用者語音轉文字），
      // 與輸出模態無關。模型自己產生的語音輸出一律不讀、不回傳給前端、不播放。
      ws.send(
        JSON.stringify({
          setup: {
            model: `models/${this.model}`,
            generationConfig: { responseModalities: ["AUDIO"] },
            inputAudioTranscription: {},
            systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
          },
        }),
      );
    });

    ws.on("message", (data) => this.onUpstreamMessage(data));
    ws.on("error", (e) => {
      this.onError(`Gemini Live 連線問題：${(e as Error)?.message ?? String(e)}`);
    });
    ws.on("close", () => {
      this.ready = false;
      if (this.upstream === ws) this.upstream = null;
      // 仍在錄音 → 多半是撞到 15 分上限或暫斷，自動重連續錄。
      if (!this.closed) this.connect();
    });
  }

  private onUpstreamMessage(data: RawData): void {
    let msg: { setupComplete?: unknown; serverContent?: { inputTranscription?: { text?: string } } };
    try {
      msg = JSON.parse(typeof data === "string" ? data : data.toString());
    } catch {
      return;
    }
    // setup 完成 → 把空窗期緩衝的音訊一次倒出去
    if (msg.setupComplete) {
      this.ready = true;
      const buf = this.pending;
      this.pending = [];
      for (const b64 of buf) this.sendAudio(b64);
      return;
    }
    const t = msg.serverContent?.inputTranscription?.text;
    if (typeof t === "string" && t) this.onText(t);
    // goAway 不需特別處理：upstream 隨後會 close，由上面的自動重連接手。
  }

  /** 送一段 base64 的 16kHz / mono / Int16LE PCM。 */
  pushAudio(pcmBase64: string): void {
    if (this.closed) return;
    if (!this.ready) {
      this.pending.push(pcmBase64);
      if (this.pending.length > 200) this.pending.shift(); // 緩衝保險，避免重連過久爆記憶體
      return;
    }
    this.sendAudio(pcmBase64);
  }

  private sendAudio(pcmBase64: string): void {
    const ws = this.upstream;
    if (!ws || ws.readyState !== ws.OPEN) {
      this.pending.push(pcmBase64);
      return;
    }
    ws.send(
      JSON.stringify({
        realtimeInput: { audio: { mimeType: "audio/pcm;rate=16000", data: pcmBase64 } },
      }),
    );
  }

  /** 停止並關閉 upstream。 */
  stop(): void {
    this.closed = true;
    this.pending = [];
    const ws = this.upstream;
    this.upstream = null;
    if (ws) {
      ws.removeAllListeners();
      ws.on("error", () => {}); // CONNECTING 中的 socket close 會非同步 emit error，先吞掉
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
  }
}
