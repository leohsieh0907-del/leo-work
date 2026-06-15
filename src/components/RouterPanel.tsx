import { useEffect, useState } from "react";
import { AudioSourceState, type AudioSourceId, type PhoneSession } from "../shared/types";
import { useAudioStore } from "../store/audioStore";
import { getPhoneSession } from "../lib/audioApi";
import VuMeter from "./VuMeter";

// ── 雙軌整合控制面板（AudioIngestionRouter）──
// 四態狀態機 + 三來源切換（電腦系統 / 手機收音 / 藍牙同步）+ VU + 藍牙進度 + 即時逐字稿。
// 「手機收音」走已驗證的 WSS 手機橋接（自簽 HTTPS + QR），點選後顯示 QR 供手機掃描。

const STATE_LABEL: Record<AudioSourceState, string> = {
  [AudioSourceState.DISCONNECTED]: "未連線",
  [AudioSourceState.BLUETOOTH_SYNCING]: "藍牙同步中",
  [AudioSourceState.WEBRTC_STREAMING]: "手機收音中",
  [AudioSourceState.LOCAL_RECORDING]: "本機錄音中",
};

const STATE_COLOR: Record<AudioSourceState, string> = {
  [AudioSourceState.DISCONNECTED]: "bg-slate-500",
  [AudioSourceState.BLUETOOTH_SYNCING]: "bg-blue-500",
  [AudioSourceState.WEBRTC_STREAMING]: "bg-brand-accent",
  [AudioSourceState.LOCAL_RECORDING]: "bg-brand",
};

const SOURCES: { id: AudioSourceId; label: string }[] = [
  { id: "local", label: "🖥️ 電腦系統" },
  { id: "webrtc", label: "📱 手機收音" },
  { id: "bluetooth", label: "🔵 藍牙同步" },
];

export default function RouterPanel() {
  const { state, status, vu, transcript, error, busy, connect, activate, deactivate, syncBluetooth } =
    useAudioStore();

  // 手機收音 QR session（手機掃描用）
  const [phoneSession, setPhoneSession] = useState<PhoneSession | null>(null);
  const [phoneSessionErr, setPhoneSessionErr] = useState<string | null>(null);
  const [qrOpen, setQrOpen] = useState(true); // QR 可收放，避免擋位置（手機連上後可收起）

  // 掛載時連上 /events
  useEffect(() => connect(), [connect]);

  const active = status?.activeSourceId ?? null;
  const realtimeActive =
    state === AudioSourceState.WEBRTC_STREAMING || state === AudioSourceState.LOCAL_RECORDING;
  const phoneActive = state === AudioSourceState.WEBRTC_STREAMING;

  // 手機收音來源啟用時取 QR / token / 網址；停用時清掉。
  useEffect(() => {
    if (!phoneActive) {
      setPhoneSession(null);
      setPhoneSessionErr(null);
      return;
    }
    let alive = true;
    getPhoneSession()
      .then((s) => {
        if (alive) setPhoneSession(s);
      })
      .catch((e) => {
        if (alive) setPhoneSessionErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [phoneActive]);

  function onSource(id: AudioSourceId) {
    if (id === "bluetooth") {
      // 藍牙走「背景同步」：即時串流中也能按，會被列為低優先
      void syncBluetooth();
    } else {
      void activate(id);
    }
  }

  return (
    <div className="flex flex-col gap-3 border-b border-white/10 bg-brand-panel/60 px-5 py-3">
      <div className="flex flex-wrap items-center gap-4">
        {/* 四態狀態燈 */}
        <div className="flex items-center gap-2 text-sm">
          <span className={`inline-block h-2.5 w-2.5 rounded-full ${STATE_COLOR[state]}`} />
          <span className="font-medium">{STATE_LABEL[state]}</span>
        </div>

        {/* 來源切換 */}
        <div className="inline-flex rounded-lg border border-white/10 bg-black/30 p-0.5">
          {SOURCES.map((s) => (
            <button
              key={s.id}
              disabled={busy}
              onClick={() => onSource(s.id)}
              className={`rounded-md px-3 py-1.5 text-sm transition ${
                active === s.id ? "bg-brand text-white" : "text-slate-300 hover:text-white"
              } disabled:opacity-50`}
            >
              {s.label}
            </button>
          ))}
        </div>

        {realtimeActive && (
          <button
            onClick={() => void deactivate()}
            disabled={busy}
            className="flex items-center gap-2 rounded-md bg-brand-danger px-4 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-white" />
            停止
          </button>
        )}

        {/* VU 訊號條 */}
        <div className="min-w-[200px] flex-1">
          <VuMeter level={realtimeActive ? vu : null} label="音量訊號" />
        </div>
      </div>

      {/* 手機收音：QR + 連線指引（可收放，避免擋位置）*/}
      {phoneActive && (
        <div className="rounded-md border border-white/10 bg-black/20">
          <button
            onClick={() => setQrOpen((v) => !v)}
            className="flex w-full items-center justify-between px-3 py-2 text-sm font-medium text-slate-100 transition hover:bg-white/5"
          >
            <span>📱 用手機掃 QR 當無線麥克風</span>
            <span className="text-xs text-slate-400">{qrOpen ? "▾ 收起 QR" : "▸ 展開 QR"}</span>
          </button>
          {qrOpen && (
            <div className="flex flex-wrap items-center gap-4 px-3 pb-3">
              {phoneSession ? (
                <>
                  <img
                    src={phoneSession.qrDataUrl}
                    alt="手機收音 QR"
                    className="h-32 w-32 shrink-0 rounded bg-white p-1"
                  />
                  <div className="flex flex-col gap-1 text-xs text-slate-300">
                    <span>1. 手機與電腦連同一個 Wi-Fi，掃描左方 QR</span>
                    <span>2. 首次會跳「憑證不受信任」→ 選繼續前往（自簽憑證，正常）</span>
                    <span>3. 開頁後按「開始傳送」，聲音即時回傳並轉成逐字稿</span>
                    <span className="mt-1 break-all text-slate-500">{phoneSession.url}</span>
                    <span className="text-slate-500">手機開始傳送後，下方音量條會跳動、即時逐字稿會出現。</span>
                  </div>
                </>
              ) : phoneSessionErr ? (
                <span className="text-xs text-brand-danger">取得手機連線資訊失敗：{phoneSessionErr}</span>
              ) : (
                <span className="text-xs text-slate-400">產生手機連線 QR 中…</span>
              )}
            </div>
          )}
        </div>
      )}

      {/* 藍牙背景傳輸進度（即時串流時為低優先，不掉幀）*/}
      {status?.bluetooth.transferring && (
        <div className="flex items-center gap-3 rounded-md border border-blue-500/30 bg-blue-500/10 px-3 py-2">
          <span className="text-xs text-blue-300">
            🔵 藍牙傳輸{status.bluetooth.priority === "background" ? "（背景低優先）" : ""}
          </span>
          <div className="h-2 flex-1 overflow-hidden rounded bg-black/40">
            <div
              className="h-full bg-blue-400 transition-all"
              style={{ width: `${Math.round(status.bluetooth.progress * 100)}%` }}
            />
          </div>
          <span className="font-mono text-xs text-slate-300">
            {Math.round(status.bluetooth.progress * 100)}%
          </span>
        </div>
      )}

      {/* 即時逐字稿（手機收音、電腦即時看）*/}
      {realtimeActive && transcript && (
        <div className="max-h-20 overflow-y-auto rounded-md border border-white/10 bg-black/20 px-3 py-2 text-xs text-slate-300">
          <span className="text-slate-500">即時逐字稿：</span> {transcript}
        </div>
      )}

      {error && <p className="text-xs text-brand-danger">{error}</p>}
    </div>
  );
}
