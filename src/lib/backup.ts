// ── 會議備份：匯出（可救回 JSON + 人看逐字稿 txt）／匯入還原 ──
// 內部存檔是 AES-256-GCM 加密、檔名用 id 雜湊（避免中文撞檔）；這裡提供「看得懂檔名」
// 的匯出：檔名＝會議名稱。JSON 為明文（可跨機器再匯入救回），txt 為純逐字稿給人看。

import type { SavedMeeting } from "../shared/types";

/** 清掉檔名非法字元（Windows/通用），給匯出檔用會議名當檔名。 */
export function safeFileName(name: string): string {
  const cleaned = (name || "會議")
    .replace(/[\\/:*?"<>|]/g, "_") // Windows 不允許的字元
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, 80) || "會議";
}

/** 觸發瀏覽器下載一個 Blob。 */
function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** 把一場會議組成人看的純文字（會議名/日期表頭 + 逐字稿）。 */
function meetingToText(m: SavedMeeting): string {
  const date = m.date ? m.date.slice(0, 10) : "";
  return `會議：${m.title || m.id}\n日期：${date}\n${"─".repeat(24)}\n\n${m.transcript ?? ""}\n`;
}

/**
 * 匯出一場會議：同時下載「可救回的 .json」與「人看的 .txt」。
 * 檔名＝會議名稱（清洗非法字元）＋日期，避免不同場同名互蓋。
 */
export function exportMeeting(m: SavedMeeting): void {
  const date = m.date ? m.date.slice(0, 10) : "";
  const base = safeFileName(m.title || m.id);
  const stamped = date ? `${base}_${date}` : base;
  downloadBlob(
    `${stamped}.json`,
    new Blob([JSON.stringify(m, null, 2)], { type: "application/json" }),
  );
  downloadBlob(
    `${stamped}.txt`,
    new Blob([meetingToText(m)], { type: "text/plain;charset=utf-8" }),
  );
}

/**
 * 讀一個 JSON 備份檔還原成 SavedMeeting（驗證並補預設）。
 * 缺欄位給合理預設；transcript 為必要欄位，沒有就拒絕。
 */
export async function readMeetingBackup(file: File): Promise<SavedMeeting> {
  let obj: Partial<SavedMeeting>;
  try {
    obj = JSON.parse(await file.text()) as Partial<SavedMeeting>;
  } catch {
    throw new Error("檔案不是有效的 JSON");
  }
  if (!obj || typeof obj.transcript !== "string") {
    throw new Error("不是有效的會議備份（缺 transcript 欄位）");
  }
  const now = new Date().toISOString();
  return {
    id: typeof obj.id === "string" && obj.id ? obj.id : `匯入-${Date.now()}`,
    title: typeof obj.title === "string" && obj.title ? obj.title : (obj.id ?? "匯入的會議"),
    date: typeof obj.date === "string" && obj.date ? obj.date : now,
    transcript: obj.transcript,
    analysis: obj.analysis ?? null,
    actionItems: Array.isArray(obj.actionItems) ? obj.actionItems : [],
    savedAt: now,
  };
}
