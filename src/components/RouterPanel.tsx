import { useEffect, useState } from "react";
import { AudioSourceState, type AudioSourceId, type PhoneSession } from "../shared/types";
import { useAudioStore } from "../store/audioStore";
import { getPhoneSession } from "../lib/audioApi";
import VuMeter from "./VuMeter";

// ── 雙軌整合控制（AudioIngestionRouter）──
// 拆成兩塊：RouterBar（精簡控制列，放在頂部 header）＋ RouterDetails（QR/藍牙進度/即時逐字稿，
// 放在 header 下方，無內容時不顯示）。兩者共用 zustand 音訊 store。
// 「手機收音」走已驗證的 WSS 手機橋接（自簽 HTTPS + QR），點選後在 RouterDetails 顯示 QR。

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

function isRealtime(state: AudioSourceState): boolean {
  return state === AudioSourceState.WEBRTC_STREAMING || state === AudioSourceState.LOCAL_RECORDING;
}

/** 精簡控制列：狀態燈 + 來源切換 + 停止 + VU。放在頂部 header。 */
export function RouterBar() {
  const { state, status, vu, busy, connect, activate, deactivate, syncBluetooth } = useAudioStore();

  // 掛載時連上 /events
  useEffect(() => connect(), [connect]);

  const active = status?.activeSourceId ?? null;
  const realtimeActive = isRealtime(state);

  // 錄音計時（即時源在錄時每秒跳；停止歸零）
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!realtimeActive) {
      setElapsed(0);
      return;
    }
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [realtimeActive]);
  const clock = `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`;

  function onSource(id: AudioSourceId) {
    if (id === "bluetooth") void syncBluetooth(); // 藍牙走背景同步，即時串流中也可按
    else void activate(id);
  }

  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${STATE_COLOR[state]}`} />
      <span className="hidden shrink-0 text-xs font-medium text-fg-muted lg:inline">{STATE_LABEL[state]}</span>

      <div className="inline-flex shrink-0 rounded-lg border border-line bg-inset p-0.5">
        {SOURCES.map((s) => (
          <button
            key={s.id}
            disabled={busy}
            onClick={() => onSource(s.id)}
            className={`rounded-md px-2.5 py-1 text-xs transition ${
              active === s.id ? "bg-brand text-white" : "text-fg-muted hover:text-fg"
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
          className="flex shrink-0 items-center gap-1.5 rounded-md bg-brand-danger px-3 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
          停止 <span className="font-mono tabular-nums">{clock}</span>
        </button>
      )}

      {realtimeActive && (
        <div className="hidden min-w-0 flex-1 md:block">
          <VuMeter level={vu} />
        </div>
      )}
    </div>
  );
}

/** 細節區：手機 QR / 藍牙進度 / 即時逐字稿 / 錯誤。放在 header 下方，無內容時不顯示。 */
export function RouterDetails() {
  const { state, status, transcript, error } = useAudioStore();

  const [phoneSession, setPhoneSession] = useState<PhoneSession | null>(null);
  const [phoneSessionErr, setPhoneSessionErr] = useState<string | null>(null);
  const [qrOpen, setQrOpen] = useState(true); // QR 可收放，避免擋位置

  const realtimeActive = isRealtime(state);
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

  const hasContent = phoneActive || status?.bluetooth.transferring || realtimeActive || error;
  if (!hasContent) return null;

  return (
    <div className="flex flex-col gap-3 border-b border-line bg-brand-panel/60 px-5 py-3">
      {/* 手機收音：QR + 連線指引（可收放，避免擋位置）*/}
      {phoneActive && (
        <div className="rounded-md border border-line bg-inset">
          <button
            onClick={() => setQrOpen((v) => !v)}
            className="flex w-full items-center justify-between px-3 py-2 text-sm font-medium text-fg transition hover:bg-hover-weak"
          >
            <span>📱 用手機掃 QR 當無線麥克風</span>
            <span className="text-xs text-fg-subtle">{qrOpen ? "▾ 收起 QR" : "▸ 展開 QR"}</span>
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
                  <div className="flex flex-col gap-1 text-xs text-fg-muted">
                    <span>1. 手機與電腦連同一個 Wi-Fi，掃描左方 QR</span>
                    <span>2. 首次會跳「憑證不受信任」→ 選繼續前往（自簽憑證，正常）</span>
                    <span>3. 開頁後按「開始傳送」，聲音即時回傳並轉成逐字稿</span>
                    <span className="mt-1 break-all text-fg-faint">{phoneSession.url}</span>
                    <span className="text-fg-faint">手機開始傳送後，上方音量條會跳動、即時逐字稿會出現。</span>
                  </div>
                </>
              ) : phoneSessionErr ? (
                <span className="text-xs text-brand-danger">取得手機連線資訊失敗：{phoneSessionErr}</span>
              ) : (
                <span className="text-xs text-fg-subtle">產生手機連線 QR 中…</span>
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
          <div className="h-2 flex-1 overflow-hidden rounded bg-inset">
            <div
              className="h-full bg-blue-400 transition-all"
              style={{ width: `${Math.round(status.bluetooth.progress * 100)}%` }}
            />
          </div>
          <span className="font-mono text-xs text-fg-muted">
            {Math.round(status.bluetooth.progress * 100)}%
          </span>
        </div>
      )}

      {/* 即時逐字稿（手機收音、電腦即時看）。即時稿只是預覽、且 Gemini Live 偶有延遲/不穩，
          沒字時給提示，避免使用者以為壞了——可靠逐字稿來自「停止」後的整檔精修。*/}
      {realtimeActive && (
        <div className="max-h-20 overflow-y-auto rounded-md border border-line bg-inset px-3 py-2 text-xs text-fg-muted">
          {transcript ? (
            <>
              <span className="text-fg-faint">即時逐字稿：</span> {transcript}
            </>
          ) : (
            <span className="text-fg-faint">
              即時稿準備中…（即時稿僅為預覽；最終逐字稿以「停止」後的整檔精修為準）
            </span>
          )}
        </div>
      )}

      {error && <p className="text-xs text-brand-danger">{error}</p>}
    </div>
  );
}
