// ── 前端 → sidecar 的雙軌路由控制（/router/* 與 /webrtc/*）──

import type { AudioSourceId, RouterStatus } from "../shared/types";

const BASE = "http://127.0.0.1:8765";

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

/** 啟用某來源為前景（bluetooth / webrtc / local）。 */
export function activateSource(sourceId: AudioSourceId): Promise<{ status: RouterStatus }> {
  return jsonPost("/router/activate", { sourceId });
}

/** 停止前景來源。 */
export function deactivateSource(): Promise<{ status: RouterStatus }> {
  return jsonPost("/router/deactivate", {});
}

/** 觸發藍牙背景同步（不搶前景即時串流）。 */
export function syncBluetooth(): Promise<{ status: RouterStatus }> {
  return jsonPost("/router/sync-bluetooth", {});
}

/** WebRTC 信令：送 offer 拿 answer。 */
export function sendWebRtcOffer(sdp: string): Promise<{ sdp: string }> {
  return jsonPost("/webrtc/offer", { sdp });
}

/** WebRTC 信令：送 ICE candidate。 */
export function sendWebRtcIce(candidate: unknown): Promise<{ ok: true }> {
  return jsonPost("/webrtc/ice", { candidate });
}
