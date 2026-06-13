// ── 左側歷史會議欄 ──
// 列出已加密存檔的會議；點一下載回工作區、可刪除、可開新會議。

import { useEffect, useState } from "react";
import { listMeetings, loadMeeting, deleteMeeting } from "../lib/api";
import type { MeetingListItem, SavedMeeting } from "../shared/types";

interface Props {
  currentId: string | null;
  /** 父層存檔/刪除後 +1，觸發重抓清單。 */
  refreshKey: number;
  onLoad: (m: SavedMeeting) => void;
  onNew: () => void;
}

export default function HistoryRail({ currentId, refreshKey, onLoad, onNew }: Props) {
  const [items, setItems] = useState<MeetingListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    listMeetings()
      .then((r) => setItems(r.meetings))
      .catch((e) => setError(e instanceof Error ? e.message : "讀取歷史失敗"));
  }, [refreshKey]);

  async function handleLoad(id: string) {
    setBusyId(id);
    setError(null);
    try {
      const r = await loadMeeting(id);
      onLoad(r.meeting);
    } catch (e) {
      setError(e instanceof Error ? e.message : "載入失敗");
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    if (!window.confirm("確定刪除這場會議存檔？")) return;
    try {
      await deleteMeeting(id);
      setItems((xs) => xs.filter((x) => x.id !== id));
    } catch (er) {
      setError(er instanceof Error ? er.message : "刪除失敗");
    }
  }

  return (
    <aside className="flex w-56 shrink-0 flex-col gap-2 border-r border-white/10 bg-brand-panel/40 p-3">
      <button
        onClick={onNew}
        className="rounded-md bg-brand px-3 py-2 text-sm font-medium text-white transition hover:bg-brand/80"
      >
        ＋ 新會議
      </button>
      <div className="mt-1 text-xs font-semibold text-slate-400">歷史會議</div>
      {error && <p className="text-xs text-brand-danger">{error}</p>}
      <div className="flex-1 space-y-1 overflow-y-auto">
        {items.length === 0 && <p className="px-1 text-xs text-slate-600">（尚無存檔）</p>}
        {items.map((m) => (
          <div
            key={m.id}
            onClick={() => handleLoad(m.id)}
            className={`group cursor-pointer rounded-md px-2 py-1.5 transition ${
              currentId === m.id ? "bg-brand/20 text-white" : "text-slate-300 hover:bg-white/5"
            }`}
          >
            <div className="flex items-center justify-between gap-1">
              <span className="truncate text-sm">
                {busyId === m.id ? "載入中…" : m.title || m.id}
              </span>
              <button
                onClick={(e) => handleDelete(m.id, e)}
                title="刪除"
                className="text-xs text-slate-500 opacity-0 transition hover:text-brand-danger group-hover:opacity-100"
              >
                ✕
              </button>
            </div>
            <div className="text-[11px] text-slate-500">{m.date?.slice(0, 10)}</div>
          </div>
        ))}
      </div>
    </aside>
  );
}
