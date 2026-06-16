import { useEffect, useState } from "react";
import { health } from "./lib/api";
import Workspace from "./components/Workspace";
import { RouterBar, RouterDetails } from "./components/RouterPanel";
import MemoryChat from "./components/MemoryChat";

// ── App 外殼：頂部狀態列 + 主工作區 ──
// Workspace 由前端元件模組實作（逐字稿輸入、主動式分析、跨會議記憶檢索）。

export default function App() {
  const [ready, setReady] = useState<boolean | null>(null);
  const [view, setView] = useState<"workspace" | "memory">("workspace");

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

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-white/10 bg-brand-panel px-5 py-2.5">
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-brand-accent text-lg">◆</span>
          <h1 className="text-base font-semibold tracking-wide">Leo work</h1>
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

        <div className="ml-auto shrink-0">
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
