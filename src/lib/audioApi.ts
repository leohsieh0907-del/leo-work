// ── 雙源收音：前端 → sidecar 的 HTTP 查詢 + /events WebSocket 訂閱 ──
// 收音控制（開始/停止/切換來源）走 audioRouterApi.ts 的 /router/*；本檔只保留
// 「列舉裝置」「取手機連線資訊」與「訂閱即時事件」。

import type { AudioDeviceList, AudioEvent, PhoneSession } from "../shared/types";

const BASE = "http://127.0.0.1:8765";
const WS_URL = "ws://127.0.0.1:8765/events";

async function jsonGet<T>(path: string): Promise<T> {
  const r = await fetch(`${BASE}${path}`);
  if (!r.ok) throw new Error(`服務錯誤（${r.status}）`);
  return (await r.json()) as T;
}

/** 列舉系統音訊裝置（loopback / 麥克風）。 */
export function getAudioDevices(): Promise<AudioDeviceList> {
  return jsonGet("/audio/devices");
}

/** 取得手機連線 QR / token / 網址；可指定 ip 切換用哪個區網介面產 QR。 */
export function getPhoneSession(ip?: string): Promise<PhoneSession> {
  return jsonGet(ip ? `/audio/session?ip=${encodeURIComponent(ip)}` : "/audio/session");
}

/**
 * 訂閱即時事件（VU 訊號 / 路由狀態 / 即時逐字稿 / 收音可精修）。
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
