import { useEffect, useRef, useState } from "react";
import type {
  AudioDeviceList,
  AudioEngineStatus,
  AudioSourceKind,
  PhoneSession,
  VuLevel,
} from "../shared/types";
import {
  getAudioDevices,
  getPhoneSession,
  startAudio,
  stopAudio,
  subscribeAudioEvents,
} from "../lib/audioApi";
import VuMeter from "./VuMeter";

// ── 雙源收音控制面板：來源切換（電腦系統 / 手機）+ VU 訊號條 + QR 連線 ──

export default function AudioSourcePanel() {
  const [source, setSource] = useState<AudioSourceKind>("computer");
  const [status, setStatus] = useState<AudioEngineStatus | null>(null);
  const [vu, setVu] = useState<VuLevel | null>(null);
  const [session, setSession] = useState<PhoneSession | null>(null);
  const [devices, setDevices] = useState<AudioDeviceList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lastTranscript = useRef<string>("");
  const [transcript, setTranscript] = useState<string>("");

  const active = status?.active ?? false;

  // 訂閱即時事件（VU / 狀態 / 逐字稿）
  useEffect(() => {
    const off = subscribeAudioEvents((e) => {
      if (e.type === "vu") setVu(e.level);
      else if (e.type === "status") setStatus(e.status);
      else if (e.type === "error") setError(e.message);
      else if (e.type === "transcript") {
        const text = e.segments.map((s) => s.text).join(" ");
        lastTranscript.current = `${lastTranscript.current} ${text}`.trim();
        setTranscript(lastTranscript.current);
      }
    });
    return off;
  }, []);

  // 切到電腦來源時抓裝置清單；切到手機來源時抓 QR session
  useEffect(() => {
    setError(null);
    if (source === "computer") {
      getAudioDevices().then(setDevices).catch((e) => setError(String(e)));
    } else {
      getPhoneSession().then(setSession).catch((e) => setError(String(e)));
    }
  }, [source]);

  async function handleStart() {
    setBusy(true);
    setError(null);
    try {
      const r = await startAudio(source);
      setStatus(r.status);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleStop() {
    setBusy(true);
    try {
      const r = await stopAudio();
      setStatus(r.status);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 border-b border-line bg-brand-panel/60 px-5 py-3">
      <div className="flex flex-wrap items-center gap-4">
        {/* 來源切換開關 */}
        <div className="inline-flex rounded-lg border border-line bg-inset p-0.5">
          {(["computer", "phone"] as AudioSourceKind[]).map((s) => (
            <button
              key={s}
              disabled={active}
              onClick={() => setSource(s)}
              className={`rounded-md px-3 py-1.5 text-sm transition ${
                source === s ? "bg-brand text-white" : "text-fg-muted hover:text-fg"
              } disabled:opacity-50`}
            >
              {s === "computer" ? "🖥️ 電腦系統" : "📱 手機連線"}
            </button>
          ))}
        </div>

        {/* 開始 / 停止 */}
        {!active ? (
          <button
            onClick={handleStart}
            disabled={busy}
            className="rounded-md bg-brand-accent px-4 py-1.5 text-sm font-medium text-brand-dark hover:opacity-90 disabled:opacity-50"
          >
            ● 開始收音
          </button>
        ) : (
          <button
            onClick={handleStop}
            disabled={busy}
            className="flex items-center gap-2 rounded-md bg-brand-danger px-4 py-1.5 text-sm font-medium text-white hover:opacity-90"
          >
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-white" />
            停止
          </button>
        )}

        {/* VU 訊號條 */}
        <div className="min-w-[220px] flex-1">
          <VuMeter level={active ? vu : null} label={`音量訊號（${source === "computer" ? "系統混音" : "手機"}）`} />
        </div>

        {/* 狀態 */}
        <div className="text-xs text-fg-subtle">
          {status ? (
            <span>
              {status.active ? "收音中" : "閒置"}
              {source === "phone" && `｜手機：${status.phoneConnected ? "已連線" : "未連線"}`}
              {status.active && `｜增益 ${status.gain.toFixed(1)}×`}
            </span>
          ) : (
            "—"
          )}
        </div>
      </div>

      {/* 電腦來源：裝置提示 */}
      {source === "computer" && devices && devices.loopbackCandidates.length === 0 && (
        <p className="rounded-md border border-brand-warn/30 bg-brand-warn/10 px-3 py-2 text-xs text-brand-warn">
          ⚠️ 未偵測到系統 loopback 裝置（立體聲混音 / 虛擬音源）。只會錄到麥克風。
          請於 Windows 啟用「立體聲混音」或安裝 VB-Audio Virtual Cable 後重試。
        </p>
      )}

      {/* 手機來源：QR Code */}
      {source === "phone" && session && (
        <div className="flex items-center gap-4 rounded-md border border-line bg-inset p-3">
          <img src={session.qrDataUrl} alt="手機連線 QR" className="h-28 w-28 rounded bg-white p-1" />
          <div className="text-xs text-fg-muted">
            <p className="mb-1 font-medium text-fg">用手機掃描連線收音</p>
            <p className="text-fg-subtle">區網位址：</p>
            <p className="font-mono text-brand-accent">{session.url}</p>
            <p className="mt-2 text-[11px] text-fg-faint">
              手機需與電腦在同一 Wi-Fi；首次連線會出現「不安全憑證」警告（自簽憑證），點「繼續前往」即可。
            </p>
          </div>
        </div>
      )}

      {/* 即時逐字稿（手機收音、電腦即時看） */}
      {active && transcript && (
        <div className="max-h-20 overflow-y-auto rounded-md border border-line bg-inset px-3 py-2 text-xs text-fg-muted">
          <span className="text-fg-faint">即時逐字稿：</span> {transcript}
        </div>
      )}

      {error && <p className="text-xs text-brand-danger">{error}</p>}
    </div>
  );
}
