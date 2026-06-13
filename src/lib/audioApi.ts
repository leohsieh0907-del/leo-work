// ── 雙源收音：前端 → sidecar 的 HTTP 控制 + /events WebSocket 訂閱 ──

import type {
  AudioDeviceList,
  AudioEngineStatus,
  AudioEvent,
  AudioSourceKind,
  PhoneSession,
} from "../shared/types";

const BASE = "http://127.0.0.1:8765";
const WS_URL = "ws://127.0.0.1:8765/events";

async function jsonGet<T>(path: string): Promise<T> {
  const r = await fetch(`${BASE}${path}`);
  if (!r.ok) throw new Error(`服務錯誤（${r.status}）`);
  return (await r.json()) as T;
}
async function jsonPost<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const e = (await r.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(e?.error?.message ?? `服務錯誤（${r.status}）`);
  }
  return (await r.json()) as T;
}

/** 列舉系統音訊裝置（loopback / 麥克風）。 */
export function getAudioDevices(): Promise<AudioDeviceList> {
  return jsonGet("/audio/devices");
}

/** 取得手機連線 QR / token / 網址。 */
export function getPhoneSession(): Promise<PhoneSession> {
  return jsonGet("/audio/session");
}

/** 開始收音。 */
export function startAudio(source: AudioSourceKind): Promise<{ status: AudioEngineStatus }> {
  return jsonPost("/audio/start", { source });
}

/** 停止收音。 */
export function stopAudio(): Promise<{ status: AudioEngineStatus }> {
  return jsonPost("/audio/stop", {});
}

/** 查詢引擎狀態。 */
export function getAudioStatus(): Promise<{ status: AudioEngineStatus }> {
  return jsonGet("/audio/status");
}

/**
 * 訂閱即時事件（VU 訊號 / 狀態 / 即時逐字稿）。
 * 回傳一個取消訂閱函式；自動斷線重連。
 */
export function subscribeAudioEvents(onEvent: (e: AudioEvent) => void): () => void {
  let ws: WebSocket | null = null;
  let closedByUs = false;
  let retry: ReturnType<typeof setTimeout> | null = null;

  const connect = () => {
    ws = new WebSocket(WS_URL);
    ws.onmessage = (ev) => {
      try {
        onEvent(JSON.parse(ev.data as string) as AudioEvent);
      } catch {
        /* 忽略非 JSON 訊息 */
      }
    };
    ws.onclose = () => {
      if (closedByUs) return;
      retry = setTimeout(connect, 1000); // 斷線自動重連
    };
    ws.onerror = () => ws?.close();
  };
  connect();

  return () => {
    closedByUs = true;
    if (retry) clearTimeout(retry);
    ws?.close();
  };
}
