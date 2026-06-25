import { useEffect, useState } from "react";
import type { Update } from "@tauri-apps/plugin-updater";
import { health } from "./lib/api";
import { checkForUpdate, installUpdateAndRelaunch } from "./lib/updater";
import Workspace from "./components/Workspace";
import { RouterBar, RouterDetails } from "./components/RouterPanel";
import MemoryChat from "./components/MemoryChat";
import SettingsModal from "./components/SettingsModal";

// ── App 外殼：頂部狀態列 + 主工作區 ──
// Workspace 由前端元件模組實作（逐字稿輸入、主動式分析、跨會議記憶檢索）。

export default function App() {
  const [ready, setReady] = useState<boolean | null>(null);
  const [view, setView] = useState<"workspace" | "memory">("workspace");
  const [update, setUpdate] = useState<Update | null>(null);
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  // 啟動時輪詢 sidecar 是否就緒（Node 服務啟動需一點時間）
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const ok = await health();
      if (!alive) return;
      setReady(ok);
      if (!ok) setTimeout(tick, 1000);
    };
    tick();
    return () => {
      alive = false;
    };
  }, []);

  // 啟動後檢查是否有新版（僅 Tauri 殼內有效，瀏覽器 dev 為 no-op）
  useEffect(() => {
    checkForUpdate().then(setUpdate);
  }, []);

  async function applyUpdate() {
    if (!update) return;
    setUpdating(true);
    setUpdateError(null);
    try {
      await installUpdateAndRelaunch(update);
    } catch (e) {
      console.warn("更新失敗", e);
      setUpdateError(e instanceof Error ? e.message : "更新失敗，請稍後再試");
      setUpdating(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      {update && (
        <div className="flex items-center gap-3 border-b border-amber-400/30 bg-amber-500/10 px-5 py-2 text-sm">
          <span>
            ✨ 有新版 <b>v{update.version}</b> 可更新
            {updateError && <span className="text-brand-danger"> — ⚠️ {updateError}</span>}
          </span>
          <button
            onClick={applyUpdate}
            disabled={updating}
            className="ml-auto rounded-md bg-brand px-3 py-1 text-white transition hover:opacity-90 disabled:opacity-50"
          >
            {updating ? "更新中…" : "立即更新並重啟"}
          </button>
          {!updating && (
            <button
              onClick={() => setUpdate(null)}
              className="text-slate-400 hover:text-white"
            >
              稍後
            </button>
          )}
        </div>
      )}
      <header className="flex items-center gap-3 border-b border-white/10 bg-brand-panel px-5 py-2.5">
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-brand-accent text-lg">◆</span>
          <h1 className="text-base font-semibold tracking-wide">語音轉文字</h1>
          <span className="ml-1 hidden rounded bg-white/5 px-2 py-0.5 text-xs text-slate-400 xl:inline">
            本地隱私 · 跨會議記憶
          </span>
        </div>

        {ready && (
          <div className="inline-flex shrink-0 rounded-lg border border-white/10 bg-black/30 p-0.5 text-sm">
            <button
              onClick={() => setView("workspace")}
              className={`rounded-md px-3 py-1.5 transition ${
                view === "workspace" ? "bg-brand text-white" : "text-slate-300 hover:text-white"
              }`}
            >
              工作區
            </button>
            <button
              onClick={() => setView("memory")}
              className={`rounded-md px-3 py-1.5 transition ${
                view === "memory" ? "bg-brand text-white" : "text-slate-300 hover:text-white"
              }`}
            >
              🦉 記憶聊天
            </button>
          </div>
        )}

        {/* 收音控制列（移上來：併進 header，省一條橫列）*/}
        {ready && view === "workspace" && (
          <div className="min-w-0 flex-1">
            <RouterBar />
          </div>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-2">
          {ready && (
            <button
              onClick={() => setShowSettings(true)}
              title="設定"
              className="rounded-md px-2 py-1 text-slate-300 transition hover:bg-white/10 hover:text-white"
            >
              ⚙️
            </button>
          )}
          <StatusPill ready={ready} />
        </div>
      </header>

      {ready ? (
        view === "workspace" ? (
          <div className="flex flex-1 flex-col overflow-hidden">
            {/* 收音細節（QR / 藍牙進度 / 即時逐字稿），無內容時不顯示 */}
            <RouterDetails />
            <main className="flex-1 overflow-hidden">
              <Workspace />
            </main>
          </div>
        ) : (
          <main className="flex-1 overflow-hidden">
            <MemoryChat />
          </main>
        )
      ) : (
        <main className="flex flex-1 items-center justify-center text-sm text-slate-400">
          {ready === null ? "連線本機服務中…" : "本機服務未就緒，重試中…"}
        </main>
      )}

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </div>
  );
}

function StatusPill({ ready }: { ready: boolean | null }) {
  const color =
    ready === null ? "bg-slate-500" : ready ? "bg-brand-accent" : "bg-brand-danger";
  const label = ready === null ? "連線中" : ready ? "服務就緒" : "離線";
  return (
    <div className="flex items-center gap-2 text-xs text-slate-300">
      <span className={`inline-block h-2 w-2 rounded-full ${color}`} />
      {label}
    </div>
  );
}
