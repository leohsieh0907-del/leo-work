// ── 工作區（階段三主畫面）──
// 組合三個面板，管理共用狀態：目前逐字稿、分析結果、行動方針、歷史背景。
// 動作：分析（analyze）、存入記憶（ingestMeeting）。

import { useState } from "react";
import { analyze, ingestMeeting } from "../lib/api";
import type {
  ActionItem,
  MeetingMeta,
  ProactiveAnalysis,
  TranscriptSegment,
} from "../shared/types";

import TranscriptPanel from "./TranscriptPanel";
import AnalysisPanel from "./AnalysisPanel";
import MemorySearch from "./MemorySearch";

/** 把 [mm:ss] 解析成秒數；非法格式回傳 null。 */
function parseTimestamp(mmss: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(mmss.trim());
  if (!m) return null;
  const mins = Number(m[1]);
  const secs = Number(m[2]);
  if (secs >= 60) return null;
  return mins * 60 + secs;
}

/**
 * 把 textarea 的逐字稿純文字解析成 TranscriptSegment[]，供 ingest。
 * 支援格式：「[mm:ss] 發言人: 內容」；缺時間戳記的行併入前一段或退化處理。
 * end 由下一段的 start 推得；最後一段 end = start + 估計值。
 */
function parseTranscript(text: string): TranscriptSegment[] {
  const lines = text.split(/\r?\n/);
  const segs: TranscriptSegment[] = [];

  // 行格式：可選 [mm:ss]、可選 發言人: 、其餘為內容
  const lineRe = /^\s*(?:\[(\d{1,2}:\d{2})\])?\s*(?:([^:：\]]{1,40})[:：])?\s*(.*)$/;

  for (const rawLine of lines) {
    if (!rawLine.trim()) continue;
    const m = lineRe.exec(rawLine);
    if (!m) continue;

    const ts = m[1] ? parseTimestamp(m[1]) : null;
    const speaker = m[2]?.trim() || undefined;
    const content = (m[3] ?? "").trim();

    // 沒有時間戳記且沒有發言人 → 視為前一段的續行
    if (ts === null && !speaker && segs.length > 0) {
      const prev = segs[segs.length - 1];
      prev.text = `${prev.text} ${content}`.trim();
      continue;
    }

    segs.push({
      start: ts ?? (segs.length > 0 ? segs[segs.length - 1].end : 0),
      end: 0, // 稍後回填
      speaker,
      text: content,
    });
  }

  // 回填 end：下一段 start，最後一段給 +5 秒緩衝
  for (let i = 0; i < segs.length; i++) {
    const next = segs[i + 1];
    segs[i].end = next ? Math.max(next.start, segs[i].start) : segs[i].start + 5;
  }

  return segs;
}

/** 產生預設會議 ID：meeting-YYYYMMDD-HHmm。 */
function defaultMeetingId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `meeting-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(
    d.getMinutes(),
  )}`;
}

/** 產生預設會議日期 yyyy-MM-dd（給 <input type="date">）。 */
function defaultMeetingDate(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export default function Workspace() {
  // 共用狀態
  const [transcript, setTranscript] = useState("");
  const [meetingId, setMeetingId] = useState(defaultMeetingId);
  const [meetingDate, setMeetingDate] = useState(defaultMeetingDate);

  // 分析結果
  const [analysis, setAnalysis] = useState<ProactiveAnalysis | null>(null);
  const [actionItems, setActionItems] = useState<ActionItem[]>([]);
  const [historicalContext, setHistoricalContext] = useState("");

  // 分析狀態
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);

  // 存入記憶狀態
  const [ingesting, setIngesting] = useState(false);
  const [ingestMsg, setIngestMsg] = useState<string | null>(null);
  const [ingestError, setIngestError] = useState<string | null>(null);

  async function handleAnalyze() {
    if (!transcript.trim()) {
      setAnalyzeError("請先輸入逐字稿");
      return;
    }
    setAnalyzing(true);
    setAnalyzeError(null);
    try {
      const r = await analyze({ currentTranscript: transcript, useHistory: true });
      setAnalysis(r.analysis);
      setActionItems(r.actionItems);
      setHistoricalContext(r.historicalContext);
    } catch (e) {
      setAnalyzeError(e instanceof Error ? e.message : "分析失敗");
      setAnalysis(null);
      setActionItems([]);
      setHistoricalContext("");
    } finally {
      setAnalyzing(false);
    }
  }

  async function handleIngest() {
    setIngestMsg(null);
    setIngestError(null);

    if (!transcript.trim()) {
      setIngestError("請先輸入逐字稿");
      return;
    }
    if (!meetingId.trim()) {
      setIngestError("請填寫會議 ID");
      return;
    }

    const segments = parseTranscript(transcript);
    if (segments.length === 0) {
      setIngestError("逐字稿無法解析出任何段落");
      return;
    }

    // 把 <input type="date"> 的 yyyy-MM-dd 轉成 ISO8601（補上當地午間時間）
    const isoDate = meetingDate
      ? new Date(`${meetingDate}T12:00:00`).toISOString()
      : new Date().toISOString();

    const meeting: MeetingMeta = {
      meetingId: meetingId.trim(),
      meetingDate: isoDate,
      title: undefined,
    };

    setIngesting(true);
    try {
      const r = await ingestMeeting({ meeting, segments });
      setIngestMsg(`已存入跨會議記憶：${r.chunks} 個切片（會議 ${meeting.meetingId}）`);
    } catch (e) {
      setIngestError(e instanceof Error ? e.message : "存入記憶失敗");
    } finally {
      setIngesting(false);
    }
  }

  return (
    <div className="flex h-full flex-col gap-4 overflow-hidden p-4">
      {/* 會議中繼資料列 */}
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-white/10 bg-brand-panel px-4 py-3">
        <label className="flex flex-col gap-1 text-xs text-slate-400">
          會議 ID
          <input
            type="text"
            value={meetingId}
            onChange={(e) => setMeetingId(e.target.value)}
            className="w-56 rounded-md border border-white/10 bg-brand-dark/60 px-2 py-1.5 text-sm text-slate-100 outline-none focus:border-brand"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-400">
          會議日期
          <input
            type="date"
            value={meetingDate}
            onChange={(e) => setMeetingDate(e.target.value)}
            className="rounded-md border border-white/10 bg-brand-dark/60 px-2 py-1.5 text-sm text-slate-100 outline-none focus:border-brand"
          />
        </label>

        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={handleIngest}
            disabled={ingesting}
            className="rounded-md border border-brand-accent/50 bg-brand-accent/10 px-3 py-2 text-sm font-medium text-brand-accent transition hover:bg-brand-accent/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {ingesting ? "存入中…" : "存入記憶"}
          </button>
          <button
            onClick={handleAnalyze}
            disabled={analyzing}
            className="rounded-md bg-brand px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand/80 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {analyzing ? "分析中…" : "分析"}
          </button>
        </div>

        {/* 存入記憶的狀態訊息 */}
        {ingestMsg && <p className="w-full text-xs text-brand-accent">{ingestMsg}</p>}
        {ingestError && <p className="w-full text-xs text-brand-danger">{ingestError}</p>}
      </div>

      {/* 主體：左逐字稿、右分析 */}
      <div className="grid flex-1 grid-cols-1 gap-4 overflow-hidden lg:grid-cols-2">
        <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-white/10 bg-brand-panel/40 p-4">
          <TranscriptPanel value={transcript} onChange={setTranscript} />
        </div>

        <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-white/10 bg-brand-panel/40 p-4">
          {analyzeError && (
            <p className="mb-2 text-xs text-brand-danger">{analyzeError}</p>
          )}
          <div className="min-h-0 flex-1">
            <AnalysisPanel
              analysis={analysis}
              actionItems={actionItems}
              historicalContext={historicalContext}
              loading={analyzing}
            />
          </div>
        </div>
      </div>

      {/* 底部：跨會議記憶檢索 */}
      <div className="rounded-lg border border-white/10 bg-brand-panel/40 p-4">
        <MemorySearch />
      </div>
    </div>
  );
}
