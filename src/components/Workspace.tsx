// ── 工作區（主畫面）──
// 左：歷史會議欄；右：逐字稿 / 分析 / 記憶檢索。
// 動作：分析（analyze）、存檔（加密落地 + 存入跨會議記憶）、載入歷史、新會議。

import { useState, useEffect, useRef } from "react";
import { analyze, ingestMeeting, saveMeeting } from "../lib/api";
import {
  AudioSourceState,
  type ActionItem,
  type MeetingMeta,
  type ProactiveAnalysis,
  type SavedMeeting,
  type TranscribeLang,
  type TranscriptSegment,
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
/** 內部穩定 id：含秒＋亂數，避免同分鐘連開兩場新會議撞 id 互蓋（顯示名仍用 defaultMeetingId）。 */
function newMeetingId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const rand = Math.random().toString(36).slice(2, 6);
  return `會議-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${rand}`;
}
function defaultMeetingDate(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 預估剩餘秒數 → 「N分N秒」/「N秒」。 */
function fmtEta(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return s >= 60 ? `${Math.floor(s / 60)}分${s % 60}秒` : `${s}秒`;
}

export default function Workspace() {
  const [transcript, setTranscript] = useState("");
  // meetingId＝穩定識別（建立後不變、唯一，存檔/記憶都靠它）；meetingTitle＝可改的顯示名。
  const [meetingId, setMeetingId] = useState(newMeetingId);
  const [meetingTitle, setMeetingTitle] = useState(defaultMeetingId);
  const [meetingDate, setMeetingDate] = useState(defaultMeetingDate);
  const [micBusy, setMicBusy] = useState(false); // 逐字稿區匯入音檔轉錄中（錄音已移到頂部收音列）
  const lastPersistedRef = useRef(""); // 上次存檔/載入時的逐字稿，用來判斷是否有未存變更
  // 錄音工作階段：綁定「開始錄音/匯入時的那場會議」，停止後逐字稿自動寫回原場（即使中途切去看別場）。
  const recordingOriginRef = useRef<SavedMeeting | null>(null);
  const wasCapturingRef = useRef(false);
  const [recordingNotice, setRecordingNotice] = useState<string | null>(null);
  // 發言人改名：本場有效的對應（原名→新名），自動套用到之後併入的新逐字稿。
  const speakerMapRef = useRef<Record<string, string>>({});
  const [speakerMap, setSpeakerMap] = useState<Record<string, string>>({});

  const [analysis, setAnalysis] = useState<ProactiveAnalysis | null>(null);
  const [actionItems, setActionItems] = useState<ActionItem[]>([]);
  const [historicalContext, setHistoricalContext] = useState("");

  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [historyKey, setHistoryKey] = useState(0); // +1 觸發歷史欄重抓
  const [chatOpen, setChatOpen] = useState(true); // AI 助理（聊天＋匯出）為主互動區，預設展開
  const [chatBig, setChatBig] = useState(false); // 放大：給討論/匯出更大空間

  // 手機/電腦收音停止後的「整檔精修帶入會議」
  const {
    state: routerState,
    recordingReady,
    recordingSeconds,
    recordingTruncated,
    finalizing,
    finalizeRecording,
    transcribeProgress,
    clearTranscribeProgress,
    autoSegment,
  } = useAudioStore();
  const lastSegmentSeqRef = useRef(0); // 已處理的自動分段序號（去重，避免重複帶入）
  const [routerLang, setRouterLang] = useState<TranscribeLang>("auto");
  const [importError, setImportError] = useState<string | null>(null);

  // 擷取進行中（含精修）＝切換時視為錄音工作階段。
  const capturing = micBusy || finalizing || routerState !== AudioSourceState.DISCONNECTED;
  // 「真正在收音/錄音/匯入」——不含精修(finalizing)。用來抓「工作階段一開始」的上升緣，
  // 否則 router 停止→精修會造成第二次上升緣，把快照重抓成（可能已切走的）目前會議 → 寫錯場。
  const captureActive = micBusy || routerState !== AudioSourceState.DISCONNECTED;

  // 錄音中讓 AI 助理面板讓出空間，避免逐字稿區被擠到看不見（停止後自動恢復原本展開狀態）。
  const effectiveChatOpen = chatOpen && !captureActive;

  // 擷取一開始就記住「原場」會議；停止後 routeRecordedText 會把逐字稿寫回這裡。
  useEffect(() => {
    if (captureActive && !wasCapturingRef.current) {
      recordingOriginRef.current = {
        id: meetingId,
        title: meetingTitle,
        date: meetingDate,
        transcript,
        analysis,
        actionItems,
        savedAt: "",
      };
    }
    wasCapturingRef.current = captureActive;
  }, [captureActive]); // eslint-disable-line react-hooks/exhaustive-deps

  // 收音停止後自動精修一次（避免使用者忘了按鈕、以為「沒輸出逐字稿」）；
  // 失敗緩衝會保留，故偶發網路抖動自動重試一次再放棄。
  const autoFinalizedRef = useRef(false);
  useEffect(() => {
    if (recordingReady && !finalizing && !autoFinalizedRef.current) {
      autoFinalizedRef.current = true;
      void handleImportRecording();
    }
    if (!recordingReady) autoFinalizedRef.current = false; // 下一段收音可再自動精修
  }, [recordingReady, finalizing]); // eslint-disable-line react-hooks/exhaustive-deps

  // 匯入/精修結束（成功或失敗）就收掉進度條，避免半途失敗時卡在畫面上。
  useEffect(() => {
    if (!micBusy && !finalizing) clearTranscribeProgress();
  }, [micBusy, finalizing]); // eslint-disable-line react-hooks/exhaustive-deps

  // 自動分段：背景精修出的一段（時間戳已接續）→ 併入會議（不消耗 origin ref，錄音續進行）。
  useEffect(() => {
    if (autoSegment && autoSegment.seq !== lastSegmentSeqRef.current) {
      lastSegmentSeqRef.current = autoSegment.seq;
      void routeSessionText(autoSegment.text, false);
    }
  }, [autoSegment]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleImportRecording(isRetry = false) {
    setImportError(null);
    try {
      const clean = await finalizeRecording(routerLang);
      await routeRecordedText(clean);
    } catch (e) {
      if (!isRetry) {
        // 偶發網路抖動（fetch failed）：緩衝仍在，等一下自動重試一次
        await new Promise((r) => setTimeout(r, 1500));
        return handleImportRecording(true);
      }
      setImportError(e instanceof Error ? e.message : "精修失敗");
    }
  }

  /** 套用本場的發言人改名對應到一段文字。 */
  function applySpeakerMap(text: string): string {
    let out = text;
    for (const [from, to] of Object.entries(speakerMapRef.current)) {
      if (from) out = out.split(from).join(to);
    }
    return out;
  }

  /** 存檔（加密落地）＋寫入跨會議記憶；回傳記憶切片數。 */
  async function persistMeeting(m: SavedMeeting): Promise<number> {
    await saveMeeting(m);
    const segments = parseTranscript(m.transcript);
    if (segments.length === 0) return 0;
    const meta: MeetingMeta = { meetingId: m.id, meetingDate: m.date, title: m.title };
    const r = await ingestMeeting({ meeting: meta, segments });
    return r.chunks;
  }

  /**
   * 把一段新轉錄文字併入正確的會議（先套用發言人改名）：
   *  - 錄音中途切去看別場 → 寫回「開始錄音那場」並存檔，不污染目前檢視。
   *  - 否則 → 併入目前逐字稿。
   * consume：true＝最終段（取用即消耗 origin ref、清發言人對應）；false＝自動分段（保留 ref，可再接續）。
   */
  async function routeSessionText(raw: string, consume: boolean) {
    const origin = recordingOriginRef.current;
    if (consume) recordingOriginRef.current = null;
    const text = applySpeakerMap(raw.trim());
    if (!text) return;
    if (origin && origin.id !== meetingId) {
      const isoDate = origin.date
        ? new Date(`${origin.date}T12:00:00`).toISOString()
        : new Date().toISOString();
      const merged = origin.transcript.trim() ? origin.transcript.trimEnd() + "\n" + text : text;
      const saved: SavedMeeting = {
        id: origin.id,
        title: origin.title,
        date: isoDate,
        transcript: merged,
        analysis: origin.analysis,
        actionItems: origin.actionItems,
        savedAt: new Date().toISOString(),
      };
      try {
        await persistMeeting(saved);
        origin.transcript = merged; // 累積：後續自動分段/最終段接在這之後，不覆蓋
        setRecordingNotice(`🎙 錄音已自動存入會議「${origin.title}」（你正在看別場，未打斷）`);
        setHistoryKey((k) => k + 1);
      } catch (e) {
        // 寫回失敗別讓這段錄音消失：暫併入目前畫面並提示，使用者可手動搬移。
        setTranscript((prev) => (prev.trim() ? prev.trimEnd() + "\n" + text : text));
        setRecordingNotice(
          `⚠️ 錄音無法寫回「${origin.title}」（${e instanceof Error ? e.message : "未知錯誤"}），已暫放在目前逐字稿，請手動搬到正確會議。`,
        );
      }
      // 最終段寫回別場後工作階段結束，清掉發言人對應（目前畫面已是另一場）。自動分段不清（session 續）。
      if (consume) {
        speakerMapRef.current = {};
        setSpeakerMap({});
      }
    } else {
      setTranscript((prev) => (prev.trim() ? prev.trimEnd() + "\n" + text : text));
    }
  }

  /** 最終段（停止後整檔精修）：取用即消耗 origin ref。 */
  async function routeRecordedText(raw: string) {
    return routeSessionText(raw, true);
  }

  /** 匯入音檔轉錄結果：套發言人改名後併入「目前」會議。前景操作，不走 origin 路由（避免靜默送去別場）。 */
  function handleImportedText(raw: string) {
    const text = applySpeakerMap(raw.trim());
    if (!text) return;
    setTranscript((prev) => (prev.trim() ? prev.trimEnd() + "\n" + text : text));
  }

  /** 發言人改名：整份替換 ＋ 記住對應供之後併入的新逐字稿自動套用。 */
  function handleRenameSpeaker(from: string, to: string) {
    const f = from.trim();
    const t = to.trim();
    if (!f || !t || f === t) return;
    setTranscript((prev) => prev.split(f).join(t));
    speakerMapRef.current = { ...speakerMapRef.current, [f]: t };
    setSpeakerMap(speakerMapRef.current);
  }

  /** 切換/新建會議前的守衛：錄音中允許切走（停止後自動寫回原場）；非錄音但有未存內容才確認。 */
  function confirmSwitch(): boolean {
    if (capturing) {
      // 離開原場前，把原場最新內容更新進快照（停止後寫回時才是完整的）。
      const o = recordingOriginRef.current;
      if (o && o.id === meetingId) {
        o.transcript = transcript;
        o.analysis = analysis;
        o.actionItems = actionItems;
      }
      return true;
    }
    if (transcript.trim() && transcript !== lastPersistedRef.current) {
      return window.confirm("目前會議內容尚未存檔，切換將會遺失。確定要切換嗎？");
    }
    return true;
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
    if (!meetingTitle.trim()) {
      setSaveError("請填寫會議名稱");
      return;
    }
    const isoDate = meetingDate
      ? new Date(`${meetingDate}T12:00:00`).toISOString()
      : new Date().toISOString();
    const title = meetingTitle.trim();
    const id = meetingId.trim();
    setSaving(true);
    try {
      const meeting: SavedMeeting = {
        id,
        title,
        date: isoDate,
        transcript,
        analysis,
        actionItems,
        savedAt: new Date().toISOString(),
      };
      const chunks = await persistMeeting(meeting);
      lastPersistedRef.current = transcript; // 標記已存，之後切換不再誤判為未存
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
    setMeetingTitle(m.title || m.id);
    setMeetingDate(m.date ? m.date.slice(0, 10) : defaultMeetingDate());
    setAnalysis(m.analysis);
    setActionItems(m.actionItems ?? []);
    setHistoricalContext("");
    setSaveMsg(null);
    setSaveError(null);
    setAnalyzeError(null);
    setRecordingNotice(null);
    // 錄音中切去看別場時，發言人對應屬於「錄音那場」，先別清（停止後寫回時還要用）。
    if (!capturing) {
      speakerMapRef.current = {};
      setSpeakerMap({});
    }
    lastPersistedRef.current = m.transcript; // 剛載入＝已存狀態
  }

  function handleNew() {
    if (!confirmSwitch()) return;
    setTranscript("");
    setMeetingId(newMeetingId());
    setMeetingTitle(defaultMeetingId());
    setMeetingDate(defaultMeetingDate());
    setAnalysis(null);
    setActionItems([]);
    setHistoricalContext("");
    setSaveMsg(null);
    setSaveError(null);
    setAnalyzeError(null);
    setRecordingNotice(null);
    if (!capturing) {
      speakerMapRef.current = {};
      setSpeakerMap({});
    }
    lastPersistedRef.current = "";
  }

  /** 歷史欄改名後同步：若改的是目前開啟的會議，更新顯示名。 */
  function handleRenamed(id: string, title: string) {
    if (id === meetingId) setMeetingTitle(title);
    setHistoryKey((k) => k + 1);
  }

  return (
    <div className="flex h-full overflow-hidden">
      <HistoryRail
        currentId={meetingId}
        refreshKey={historyKey}
        onLoad={handleLoadMeeting}
        onNew={handleNew}
        onRenamed={handleRenamed}
        confirmSwitch={confirmSwitch}
      />

      <div className="flex h-full flex-1 flex-col gap-4 overflow-hidden p-4">
        {/* 會議中繼資料列 */}
        <div className="flex flex-wrap items-end gap-3 rounded-lg border border-line bg-brand-panel px-4 py-3">
          <label className="flex flex-col gap-1 text-xs text-fg-subtle">
            會議名稱
            <input
              type="text"
              value={meetingTitle}
              onChange={(e) => setMeetingTitle(e.target.value)}
              className="w-56 rounded-md border border-line bg-brand-dark/60 px-2 py-1.5 text-sm text-fg outline-none focus:border-brand"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-fg-subtle">
            會議日期
            <input
              type="date"
              value={meetingDate}
              onChange={(e) => setMeetingDate(e.target.value)}
              className="rounded-md border border-line bg-brand-dark/60 px-2 py-1.5 text-sm text-fg outline-none focus:border-brand"
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

        {/* 錄音中切去看別場時，停止後逐字稿自動寫回原場的提示 */}
        {recordingNotice && (
          <div className="flex items-center gap-3 rounded-lg border border-brand-accent/40 bg-brand-accent/10 px-4 py-2 text-sm text-fg">
            <span className="flex-1">{recordingNotice}</span>
            <button
              onClick={() => setRecordingNotice(null)}
              className="text-fg-faint transition hover:text-fg"
            >
              ✕
            </button>
          </div>
        )}

        {/* 收音停止後：把整段錄音精修成乾淨稿並帶入會議逐字稿 */}
        {(recordingReady || finalizing) && (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-brand-accent/40 bg-brand-accent/10 px-4 py-3">
            <span className="text-sm text-fg">
              📥 收音已結束{recordingSeconds > 0 ? `（約 ${recordingSeconds} 秒）` : ""}
              {recordingTruncated ? "（超長，只精修前段）" : ""}—{" "}
              {finalizing ? "正在自動精修成乾淨稿帶入會議…" : "已自動精修；如需可重做"}
            </span>
            <select
              value={routerLang}
              onChange={(e) => setRouterLang(e.target.value as TranscribeLang)}
              disabled={finalizing}
              title="精修轉錄的輸出語言"
              className="rounded-md border border-line bg-brand-panel px-2 py-1.5 text-xs text-fg outline-none focus:border-brand disabled:opacity-50"
            >
              <option value="auto">自動（原文，非中文附中譯）</option>
              <option value="zh">一律繁中</option>
              <option value="en">一律英文</option>
            </select>
            <button
              onClick={() => void handleImportRecording()}
              disabled={finalizing}
              className="rounded-md bg-brand-accent px-4 py-1.5 text-sm font-semibold text-brand-dark transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {finalizing ? "精修中…" : "✨ 重新精修並帶入會議"}
            </button>
            {importError && <span className="w-full text-xs text-brand-danger">{importError}</span>}
          </div>
        )}

        {/* 分段轉錄進度條（匯入音檔 / 收音整檔精修共用；全寬、逐字稿上方）。
            單段檔無法顯示分段進度 → 用脈動動畫表示「處理中」；多段檔顯示實際百分比。 */}
        {transcribeProgress &&
          (() => {
            const { done, total, etaSec } = transcribeProgress;
            const multi = total > 1;
            const pct = multi ? Math.round((done / total) * 100) : 0;
            return (
              <div className="mb-3 shrink-0 rounded-lg border border-line bg-brand-panel/40 p-3">
                <div className="mb-1.5 flex items-center justify-between text-xs">
                  <span className="font-medium text-fg">
                    🎧 轉錄中…{multi ? ` 已完成 ${done}/${total} 段` : "（處理中，請稍候）"}
                  </span>
                  <span className="text-fg-subtle">
                    {multi ? `${pct}%` : ""}
                    {etaSec > 0 && `　預估剩餘 ${fmtEta(etaSec)}`}
                  </span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-brand-dark/50">
                  <div
                    className={
                      multi
                        ? "h-full animate-pulse rounded-full bg-emerald-500 transition-all duration-300"
                        : "h-full w-2/5 animate-pulse rounded-full bg-emerald-500"
                    }
                    // 多段：最小留 6% 讓 0/N 時也看得到一截在脈動（不是死掉）。
                    style={multi ? { width: `${Math.max(pct, 6)}%` } : undefined}
                  />
                </div>
              </div>
            );
          })()}

        {/* 主體：左逐字稿、右分析 */}
        <div className="grid flex-1 grid-cols-1 gap-4 overflow-hidden lg:grid-cols-2">
          <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-line bg-brand-panel/40 p-4">
            <TranscriptPanel
              value={transcript}
              onChange={setTranscript}
              onBusyChange={setMicBusy}
              onImportedText={handleImportedText}
              onRenameSpeaker={handleRenameSpeaker}
              speakerMap={speakerMap}
            />
          </div>
          <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-line bg-brand-panel/40 p-4">
            {analyzeError && <p className="mb-2 text-xs text-brand-danger">{analyzeError}</p>}
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

        {/* 底部：🦉 AI 助理。永遠掛載（收合只切顯示，不卸載）→ 對話不會被清空。*/}
        <div
          className={
            effectiveChatOpen
              ? `${chatBig ? "h-[32rem]" : "h-80"} shrink-0 rounded-lg border border-line bg-brand-panel/40 p-4`
              : "shrink-0"
          }
        >
          <ChatAssistant
            transcript={transcript}
            analysis={analysis}
            actionItems={actionItems}
            meetingTitle={meetingTitle}
            meetingDate={meetingDate}
            big={chatBig}
            onToggleBig={() => setChatBig((v) => !v)}
            onCollapse={() => setChatOpen(false)}
            collapsed={!effectiveChatOpen}
            onExpand={() => setChatOpen(true)}
          />
        </div>
      </div>
    </div>
  );
}
