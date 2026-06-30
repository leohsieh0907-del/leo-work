// ── 左側歷史會議欄 ──
// 列出已加密存檔的會議；點一下載回工作區、可刪除、可開新會議。

import { useEffect, useRef, useState } from "react";
import {
  listMeetings,
  loadMeeting,
  deleteMeeting,
  renameMeeting,
  saveMeeting,
  backupMeetingToDir,
} from "../lib/api";
import { exportMeeting, readMeetingBackup } from "../lib/backup";
import { isDesktopApp } from "../lib/updater";
import type { MeetingListItem, SavedMeeting } from "../shared/types";

interface Props {
  currentId: string | null;
  /** 父層存檔/刪除後 +1，觸發重抓清單。 */
  refreshKey: number;
  onLoad: (m: SavedMeeting) => void;
  onNew: () => void;
  /** 改名成功後通知父層（同步目前開啟的會議顯示名）。 */
  onRenamed?: (id: string, title: string) => void;
  /** 載入別場會議前先問父層是否允許（錄音中/未存內容防遺失）。 */
  confirmSwitch?: () => boolean;
}

export default function HistoryRail({
  currentId,
  refreshKey,
  onLoad,
  onNew,
  onRenamed,
  confirmSwitch,
}: Props) {
  const [items, setItems] = useState<MeetingListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    listMeetings()
      .then((r) => setItems(r.meetings))
      .catch((e) => setError(e instanceof Error ? e.message : "讀取歷史失敗"));
  }, [refreshKey]);

  async function handleLoad(id: string) {
    if (id === currentId) return; // 已開啟的不重載
    if (confirmSwitch && !confirmSwitch()) return; // 錄音中/未存內容 → 擋下
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

  async function handleRename(m: MeetingListItem, e: React.MouseEvent) {
    e.stopPropagation();
    const name = window.prompt("會議新名稱：", m.title || m.id);
    if (name == null) return;
    const t = name.trim();
    if (!t || t === m.title) return;
    try {
      await renameMeeting(m.id, t);
      setItems((xs) => xs.map((x) => (x.id === m.id ? { ...x, title: t } : x)));
      onRenamed?.(m.id, t);
    } catch (er) {
      setError(er instanceof Error ? er.message : "改名失敗");
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

  // 匯出/備份：<會議名>_<日期>.json（可救回）+ .txt（可讀）。
  // 桌面版：跳資料夾選擇器（預設上次/語音備份）→ sidecar 直接寫進去。
  // 瀏覽器/dev：退回瀏覽器下載（只能進 Downloads）。
  async function handleExport(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    setError(null);
    setNotice(null);
    try {
      if (isDesktopApp()) {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const defaultPath = localStorage.getItem("exportDir") || "D:\\Leo work\\語音備份";
        const dir = await open({ directory: true, defaultPath, title: "選擇備份資料夾" });
        if (typeof dir !== "string" || !dir) return; // 使用者取消
        localStorage.setItem("exportDir", dir); // 記住，下次預設這裡
        const r = await backupMeetingToDir(id, dir);
        setNotice(`已存到 ${r.dir}（${r.files.join("、")}）`);
      } else {
        const r = await loadMeeting(id);
        exportMeeting(r.meeting);
        setNotice("已匯出 .json + .txt（瀏覽器下載）");
      }
    } catch (er) {
      setError(er instanceof Error ? er.message : "匯出失敗");
    }
  }

  // 匯入：讀 JSON 備份還原成一場會議並存檔（同 id 視為覆蓋還原）。
  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // 清掉以便能再選同一個檔
    if (!file) return;
    setError(null);
    setNotice(null);
    try {
      const meeting = await readMeetingBackup(file);
      await saveMeeting(meeting);
      const r = await listMeetings();
      setItems(r.meetings);
      setNotice(`已匯入「${meeting.title}」（開啟後按存檔可納入跨會議記憶）`);
    } catch (er) {
      setError(er instanceof Error ? er.message : "匯入失敗");
    }
  }

  return (
    <aside className="flex w-56 shrink-0 flex-col gap-2 border-r border-line bg-brand-panel/40 p-3">
      <button
        onClick={onNew}
        className="rounded-md bg-brand px-3 py-2 text-sm font-medium text-white transition hover:bg-brand/80"
      >
        ＋ 新會議
      </button>
      <div className="mt-1 flex items-center justify-between">
        <span className="text-xs font-semibold text-fg-subtle">歷史會議</span>
        <input
          ref={importInputRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={handleImport}
        />
        <button
          onClick={() => importInputRef.current?.click()}
          title="從 .json 備份還原一場會議"
          className="rounded px-1.5 py-0.5 text-xs text-fg-faint transition hover:bg-hover-weak hover:text-fg"
        >
          ⬆ 匯入
        </button>
      </div>
      {error && <p className="text-xs text-brand-danger">{error}</p>}
      {notice && <p className="text-xs text-brand-accent">{notice}</p>}
      <div className="flex-1 space-y-1 overflow-y-auto">
        {items.length === 0 && <p className="px-1 text-xs text-fg-faint">（尚無存檔）</p>}
        {items.map((m) => (
          <div
            key={m.id}
            onClick={() => handleLoad(m.id)}
            className={`group cursor-pointer rounded-md px-2 py-1.5 transition ${
              currentId === m.id ? "bg-brand/20 text-fg" : "text-fg-muted hover:bg-hover-weak"
            }`}
          >
            <div className="flex items-center justify-between gap-1">
              <span className="truncate text-sm">
                {busyId === m.id ? "載入中…" : m.title || m.id}
              </span>
              <span className="flex shrink-0 items-center gap-1 opacity-0 transition group-hover:opacity-100">
                <button
                  onClick={(e) => handleExport(m.id, e)}
                  title="匯出/備份（.json 可救回 + .txt 逐字稿，檔名＝會議名）"
                  className="text-xs text-fg-faint transition hover:text-fg"
                >
                  ⬇
                </button>
                <button
                  onClick={(e) => handleRename(m, e)}
                  title="改名"
                  className="text-xs text-fg-faint transition hover:text-fg"
                >
                  ✎
                </button>
                <button
                  onClick={(e) => handleDelete(m.id, e)}
                  title="刪除"
                  className="text-xs text-fg-faint transition hover:text-brand-danger"
                >
                  ✕
                </button>
              </span>
            </div>
            <div className="text-[11px] text-fg-faint">{m.date?.slice(0, 10)}</div>
          </div>
        ))}
      </div>
    </aside>
  );
}
