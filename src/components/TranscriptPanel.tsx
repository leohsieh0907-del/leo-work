// ── 逐字稿面板 ──
// 一個大 textarea 讓使用者貼上 / 編輯帶 [mm:ss] 發言人: 的逐字稿，
// 附「翻譯」按鈕與語言下拉；翻譯結果顯示於下方並保留排版。

import { useEffect, useState } from "react";
import { translate, transcribe } from "../lib/api";
import { startRecording, stopRecording } from "../lib/recorder";
import type { TargetLanguage } from "../shared/types";

interface TranscriptPanelProps {
  value: string;
  onChange: (v: string) => void;
}

/** 即時粗稿是 STT 原始輸出，中文字間常夾空白；顯示時收掉 CJK 字元之間的空白。 */
const CJK = "\\u3000-\\u303f\\u3400-\\u9fff\\uff00-\\uffef";
const CJK_GAP = new RegExp(`([${CJK}]) +(?=[${CJK}])`, "g");
function tidyDraft(s: string): string {
  return s.replace(CJK_GAP, "$1");
}

/** 翻譯目標語言選項（代碼 → 顯示名）。 */
const LANGUAGES: { code: TargetLanguage; label: string }[] = [
  { code: "en", label: "English" },
  { code: "ja", label: "日本語" },
  { code: "ko", label: "한국어" },
  { code: "zh", label: "繁體中文" },
];

export default function TranscriptPanel({ value, onChange }: TranscriptPanelProps) {
  const [target, setTarget] = useState<TargetLanguage>("en");
  const [translated, setTranslated] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [recSeconds, setRecSeconds] = useState(0);
  const [liveDraft, setLiveDraft] = useState(""); // 錄音中的即時粗稿（停止後由整檔精修取代）

  // 錄音計時器
  useEffect(() => {
    if (!recording) return;
    setRecSeconds(0);
    const t = setInterval(() => setRecSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [recording]);

  const recClock = `${String(Math.floor(recSeconds / 60)).padStart(2, "0")}:${String(
    recSeconds % 60,
  ).padStart(2, "0")}`;

  // 按一下開始錄音；再按一下停止 → 上傳給 Gemini 轉錄 → 結果接到逐字稿框。
  async function handleRecord() {
    setError(null);
    if (!recording) {
      try {
        setLiveDraft("");
        await startRecording({ onLiveText: (t) => setLiveDraft((d) => d + t) });
        setRecording(true);
      } catch (e) {
        setError(e instanceof Error ? e.message : "無法開始錄音");
      }
      return;
    }
    setRecording(false);
    setTranscribing(true);
    try {
      const { base64, mimeType } = await stopRecording();
      const r = await transcribe({ audio: base64, mimeType });
      const text = r.transcript.trim();
      onChange(value.trim() ? value.trimEnd() + "\n" + text : text);
      setLiveDraft(""); // 精修版已落地，清掉即時粗稿
    } catch (e) {
      setError(e instanceof Error ? e.message : "轉錄失敗");
    } finally {
      setTranscribing(false);
    }
  }

  async function handleTranslate() {
    if (!value.trim()) {
      setError("請先輸入逐字稿");
      return;
    }
    setLoading(true);
    setError(null);
    setTranslated("");
    try {
      const r = await translate({ transcript: value, targetLanguage: target });
      setTranslated(r.translated);
    } catch (e) {
      setError(e instanceof Error ? e.message : "翻譯失敗");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="flex h-full flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-200">會議逐字稿</h2>
        <div className="flex items-center gap-2">
          <span className="hidden text-xs text-slate-500 lg:inline">格式：[mm:ss] 發言人: 內容</span>
          <button
            onClick={handleRecord}
            disabled={transcribing}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition disabled:opacity-50 ${
              recording
                ? "bg-brand-danger text-white"
                : "bg-brand-accent text-brand-dark hover:opacity-90"
            }`}
          >
            {transcribing ? (
              "轉錄中…"
            ) : recording ? (
              <>
                <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-white" />
                停止並轉錄 {recClock}
              </>
            ) : (
              "🎙 錄音"
            )}
          </button>
        </div>
      </div>

      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={"[00:05] 王經理: 這次我們決定主打訂閱制。\n[00:20] 李工: 那行動版優先，桌面版延後。"}
        spellCheck={false}
        className="min-h-[200px] flex-1 resize-none rounded-lg border border-white/10 bg-brand-dark/60 p-3 font-mono text-sm leading-relaxed text-slate-100 outline-none placeholder:text-slate-600 focus:border-brand"
      />

      {(recording || transcribing) && (
        <div className="rounded-lg border border-brand-danger/30 bg-brand-danger/5 p-3">
          <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-brand-danger">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-brand-danger" />
            即時粗稿{transcribing ? "（精修中…即將取代）" : "（停止後自動精修取代）"}
          </div>
          <p className="max-h-28 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-300">
            {liveDraft ? tidyDraft(liveDraft) : "聆聽中…開始說話就會看到文字"}
          </p>
        </div>
      )}

      <div className="flex items-center gap-2">
        <select
          value={target}
          onChange={(e) => setTarget(e.target.value as TargetLanguage)}
          className="rounded-md border border-white/10 bg-brand-panel px-2 py-1.5 text-sm text-slate-200 outline-none focus:border-brand"
        >
          {LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label}
            </option>
          ))}
        </select>
        <button
          onClick={handleTranslate}
          disabled={loading}
          className="rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-white transition hover:bg-brand/80 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? "翻譯中…" : "翻譯"}
        </button>
      </div>

      {error && <p className="text-xs text-brand-danger">{error}</p>}

      {translated && (
        <div className="rounded-lg border border-white/10 bg-brand-panel p-3">
          <div className="mb-2 text-xs font-semibold text-brand-accent">翻譯結果</div>
          <pre className="whitespace-pre-wrap break-words font-mono text-sm leading-relaxed text-slate-100">
            {translated}
          </pre>
        </div>
      )}
    </section>
  );
}
