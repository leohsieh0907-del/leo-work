// ── 工作區（主畫面）──
// 左：歷史會議欄；右：逐字稿 / 分析 / 記憶檢索。
// 動作：分析（analyze）、存檔（加密落地 + 存入跨會議記憶）、載入歷史、新會議。

import { useState } from "react";
import { analyze, ingestMeeting, saveMeeting } from "../lib/api";
import type {
  ActionItem,
  MeetingMeta,
  ProactiveAnalysis,
  SavedMeeting,
  TranscribeLang,
  TranscriptSegment,
} from "../shared/types";
import { useAudioStore } from "../store/audioStore";

import HistoryRail from "./HistoryRail";
import TranscriptPanel from "./TranscriptPanel";
import AnalysisPanel from "./AnalysisPanel";
import ChatAssistant from "./ChatAssistant";

/** 把 [mm:ss] 解析成秒數；非法格式回傳 null。 */
function parseTimestamp(mmss: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(mmss.trim());
  if (!m) return null;
  const mins = Number(m[1]);
  const secs = Number(m[2]);
  if (secs >= 60) return null;
  return mins * 60 + secs;
}

/** 把逐字稿純文字解析成 TranscriptSegment[]，供 ingest。 */
function parseTranscript(text: string): TranscriptSegment[] {
  const lines = text.split(/\r?\n/);
  const segs: TranscriptSegment[] = [];
  const lineRe = /^\s*(?:\[(\d{1,2}:\d{2})\])?\s*(?:([^:：\]]{1,40})[:：])?\s*(.*)$/;

  for (const rawLine of lines) {
    if (!rawLine.trim()) continue;
    const m = lineRe.exec(rawLine);
    if (!m) continue;
    const ts = m[1] ? parseTimestamp(m[1]) : null;
    const speaker = m[2]?.trim() || undefined;
    const content = (m[3] ?? "").trim();
    if (ts === null && !speaker && segs.length > 0) {
      const prev = segs[segs.length - 1];
      prev.text = `${prev.text} ${content}`.trim();
      continue;
    }
    segs.push({
      start: ts ?? (segs.length > 0 ? segs[segs.length - 1].end : 0),
      end: 0,
      speaker,
      text: content,
    });
  }
  for (let i = 0; i < segs.length; i++) {
    const next = segs[i + 1];
    segs[i].end = next ? Math.max(next.start, segs[i].start) : segs[i].start + 5;
  }
  return segs;
}

function defaultMeetingId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `會議-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
function defaultMeetingDate(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export default function Workspace() {
  const [transcript, setTranscript] = useState("");
  const [meetingId, setMeetingId] = useState(defaultMeetingId);
  const [meetingDate, setMeetingDate] = useState(defaultMeetingDate);

  const [analysis, setAnalysis] = useState<ProactiveAnalysis | null>(null);
  const [actionItems, setActionItems] = useState<ActionItem[]>([]);
  const [historicalContext, setHistoricalContext] = useState("");

  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [historyKey, setHistoryKey] = useState(0); // +1 觸發歷史欄重抓
  const [chatOpen, setChatOpen] = useState(false); // AI 助理預設收起，讓逐字稿有空間

  // 手機/電腦收音停止後的「整檔精修帶入會議」
  const { recordingReady, recordingSeconds, recordingTruncated, finalizing, finalizeRecording } =
    useAudioStore();
  const [routerLang, setRouterLang] = useState<TranscribeLang>("auto");
  const [importError, setImportError] = useState<string | null>(null);

  async function handleImportRecording() {
    setImportError(null);
    try {
      const clean = await finalizeRecording(routerLang);
      const text = clean.trim();
      if (text) {
        setTranscript((prev) => (prev.trim() ? prev.trimEnd() + "\n" + text : text));
      }
    } catch (e) {
      setImportError(e instanceof Error ? e.message : "精修失敗");
    }
  }

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

  // 存檔 = 加密落地（可重看）+ 存入跨會議記憶（可被檢索/橫向比對）
  async function handleSave() {
    setSaveMsg(null);
    setSaveError(null);
    if (!transcript.trim()) {
      setSaveError("請先輸入逐字稿");
      return;
    }
    if (!meetingId.trim()) {
      setSaveError("請填寫會議名稱");
      return;
    }
    const isoDate = meetingDate
      ? new Date(`${meetingDate}T12:00:00`).toISOString()
      : new Date().toISOString();
    setSaving(true);
    try {
      const meeting: SavedMeeting = {
        id: meetingId.trim(),
        title: meetingId.trim(),
        date: isoDate,
        transcript,
        analysis,
        actionItems,
        savedAt: new Date().toISOString(),
      };
      await saveMeeting(meeting);

      const segments = parseTranscript(transcript);
      let chunks = 0;
      if (segments.length > 0) {
        const meta: MeetingMeta = {
          meetingId: meetingId.trim(),
          meetingDate: isoDate,
          title: meetingId.trim(),
        };
        const r = await ingestMeeting({ meeting: meta, segments });
        chunks = r.chunks;
      }
      setSaveMsg(`✅ 已加密存檔，並存入記憶 ${chunks} 個切片`);
      setHistoryKey((k) => k + 1);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "存檔失敗");
    } finally {
      setSaving(false);
    }
  }

  function handleLoadMeeting(m: SavedMeeting) {
    setTranscript(m.transcript);
    setMeetingId(m.id);
    setMeetingDate(m.date ? m.date.slice(0, 10) : defaultMeetingDate());
    setAnalysis(m.analysis);
    setActionItems(m.actionItems ?? []);
    setHistoricalContext("");
    setSaveMsg(null);
    setSaveError(null);
    setAnalyzeError(null);
  }

  function handleNew() {
    setTranscript("");
    setMeetingId(defaultMeetingId());
    setMeetingDate(defaultMeetingDate());
    setAnalysis(null);
    setActionItems([]);
    setHistoricalContext("");
    setSaveMsg(null);
    setSaveError(null);
    setAnalyzeError(null);
  }

  return (
    <div className="flex h-full overflow-hidden">
      <HistoryRail
        currentId={meetingId}
        refreshKey={historyKey}
        onLoad={handleLoadMeeting}
        onNew={handleNew}
      />

      <div className="flex h-full flex-1 flex-col gap-4 overflow-hidden p-4">
        {/* 會議中繼資料列 */}
        <div className="flex flex-wrap items-end gap-3 rounded-lg border border-white/10 bg-brand-panel px-4 py-3">
          <label className="flex flex-col gap-1 text-xs text-slate-400">
            會議名稱
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
              onClick={handleSave}
              disabled={saving}
              className="rounded-md border border-brand-accent/50 bg-brand-accent/10 px-3 py-2 text-sm font-medium text-brand-accent transition hover:bg-brand-accent/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? "存檔中…" : "💾 存檔"}
            </button>
            <button
              onClick={handleAnalyze}
              disabled={analyzing}
              className="rounded-md bg-brand px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand/80 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {analyzing ? "分析中…" : "分析"}
            </button>
          </div>

          {saveMsg && <p className="w-full text-xs text-brand-accent">{saveMsg}</p>}
          {saveError && <p className="w-full text-xs text-brand-danger">{saveError}</p>}
        </div>

        {/* 收音停止後：把整段錄音精修成乾淨稿並帶入會議逐字稿 */}
        {(recordingReady || finalizing) && (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-brand-accent/40 bg-brand-accent/10 px-4 py-3">
            <span className="text-sm text-slate-100">
              📥 收音已結束{recordingSeconds > 0 ? `（約 ${recordingSeconds} 秒）` : ""}
              {recordingTruncated ? "（超長，只精修前段）" : ""}— 整檔精修成乾淨稿帶入會議
            </span>
            <select
              value={routerLang}
              onChange={(e) => setRouterLang(e.target.value as TranscribeLang)}
              disabled={finalizing}
              title="精修轉錄的輸出語言"
              className="rounded-md border border-white/10 bg-brand-panel px-2 py-1.5 text-xs text-slate-200 outline-none focus:border-brand disabled:opacity-50"
            >
              <option value="auto">自動（原文，非中文附中譯）</option>
              <option value="zh">一律繁中</option>
              <option value="en">一律英文</option>
            </select>
            <button
              onClick={handleImportRecording}
              disabled={finalizing}
              className="rounded-md bg-brand-accent px-4 py-1.5 text-sm font-semibold text-brand-dark transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {finalizing ? "精修中…" : "✨ 精修並帶入會議"}
            </button>
            {importError && <span className="w-full text-xs text-brand-danger">{importError}</span>}
          </div>
        )}

        {/* 主體：左逐字稿、右分析 */}
        <div className="grid flex-1 grid-cols-1 gap-4 overflow-hidden lg:grid-cols-2">
          <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-white/10 bg-brand-panel/40 p-4">
            <TranscriptPanel value={transcript} onChange={setTranscript} />
          </div>
          <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-white/10 bg-brand-panel/40 p-4">
            {analyzeError && <p className="mb-2 text-xs text-brand-danger">{analyzeError}</p>}
            <div className="min-h-0 flex-1">
              <AnalysisPanel
                analysis={analysis}
                actionItems={actionItems}
                historicalContext={historicalContext}
                loading={analyzing}
                transcript={transcript}
                meetingTitle={meetingId}
                meetingDate={meetingDate}
              />
            </div>
          </div>
        </div>

        {/* 底部：AI 助理（可收合，預設收起讓逐字稿有空間）*/}
        {chatOpen ? (
          <div className="h-72 shrink-0 rounded-lg border border-white/10 bg-brand-panel/40 p-4">
            <ChatAssistant transcript={transcript} onCollapse={() => setChatOpen(false)} />
          </div>
        ) : (
          <button
            onClick={() => setChatOpen(true)}
            className="flex shrink-0 items-center gap-2 rounded-lg border border-white/10 bg-brand-panel/40 px-4 py-2.5 text-sm text-slate-200 transition hover:bg-brand-panel/60"
          >
            <span className="text-lg">🦉</span>
            <span className="font-medium">AI 助理</span>
            <span className="text-xs text-slate-500">— 點開問當前會議 ＋ 跨會議記憶</span>
          </button>
        )}
      </div>
    </div>
  );
}
