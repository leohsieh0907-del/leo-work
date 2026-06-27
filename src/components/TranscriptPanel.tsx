// ── 逐字稿面板 ──
// 一個大 textarea 讓使用者貼上 / 編輯帶 [mm:ss] 發言人: 的逐字稿，
// 附「翻譯」按鈕與語言下拉；翻譯結果顯示於下方並保留排版。

import { useEffect, useRef, useState } from "react";
import { translate, transcribe } from "../lib/api";
import { startRecording, stopRecording } from "../lib/recorder";
import type { TargetLanguage, TranscribeLang } from "../shared/types";

interface TranscriptPanelProps {
  value: string;
  onChange: (v: string) => void;
  /** 錄音/轉錄/匯入進行中回報給父層（用來判斷錄音工作階段、寫回原場）。 */
  onBusyChange?: (busy: boolean) => void;
  /** 一段新轉錄文字（錄音/匯入結果）；交父層併入正確會議＋套用發言人改名。 */
  onRecordedText?: (text: string) => void;
  /** 發言人改名（原名→新名）。 */
  onRenameSpeaker?: (from: string, to: string) => void;
  /** 目前已套用的發言人改名對應（顯示用）。 */
  speakerMap?: Record<string, string>;
}

/** File → base64（去掉 data: 前綴），供匯入音檔轉錄。 */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(",")[1] ?? "");
    reader.onerror = () => reject(new Error("讀取檔案失敗"));
    reader.readAsDataURL(file);
  });
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

export default function TranscriptPanel({
  value,
  onChange,
  onBusyChange,
  onRecordedText,
  onRenameSpeaker,
  speakerMap,
}: TranscriptPanelProps) {
  const [target, setTarget] = useState<TargetLanguage>("en");
  const [translated, setTranslated] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [importing, setImporting] = useState(false); // 匯入音檔轉錄中
  const [recSeconds, setRecSeconds] = useState(0);
  const [liveDraft, setLiveDraft] = useState(""); // 錄音中的即時粗稿（停止後由整檔精修取代）
  const [transLang, setTransLang] = useState<TranscribeLang>("auto"); // 精修轉錄輸出語言
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 錄音/轉錄/匯入任一進行中＝忙碌，回報父層擋切換會議
  useEffect(() => {
    onBusyChange?.(recording || transcribing || importing);
  }, [recording, transcribing, importing, onBusyChange]);

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

  /** 新轉錄文字交父層處理（併入正確會議＋發言人改名）；沒接 onRecordedText 才本地併入。 */
  function emitText(text: string) {
    if (!text) return;
    if (onRecordedText) onRecordedText(text);
    else onChange(value.trim() ? value.trimEnd() + "\n" + text : text);
  }

  function promptRenameSpeaker() {
    const from = window.prompt("要改哪個發言人？（輸入目前顯示的名稱，例如 發言人1）");
    if (!from?.trim()) return;
    const to = window.prompt(`把「${from.trim()}」全部改成：`);
    if (!to?.trim()) return;
    onRenameSpeaker?.(from, to);
  }

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
      const r = await transcribe({ audio: base64, mimeType, lang: transLang });
      emitText(r.transcript.trim());
      setLiveDraft(""); // 精修版已落地，清掉即時粗稿
    } catch (e) {
      setError(e instanceof Error ? e.message : "轉錄失敗");
    } finally {
      setTranscribing(false);
    }
  }

  // 匯入音檔（例如手機錄好的檔）→ 上傳轉錄 → 接到逐字稿框，之後即可分析。
  async function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // 清掉以便能再選同一個檔
    if (!file) return;
    setError(null);
    setImporting(true);
    try {
      const base64 = await fileToBase64(file);
      const r = await transcribe({ audio: base64, mimeType: file.type || "audio/mpeg", lang: transLang });
      emitText(r.transcript.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : "匯入轉錄失敗");
    } finally {
      setImporting(false);
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
        <h2 className="text-sm font-semibold text-fg">會議逐字稿</h2>
        <div className="flex items-center gap-2">
          <select
            value={transLang}
            onChange={(e) => setTransLang(e.target.value as TranscribeLang)}
            disabled={recording || transcribing}
            title="停止後精修轉錄的輸出語言"
            className="rounded-md border border-line bg-brand-panel px-2 py-1.5 text-xs text-fg outline-none focus:border-brand disabled:opacity-50"
          >
            <option value="auto">自動（原文，非中文附中譯）</option>
            <option value="zh">一律繁中</option>
            <option value="en">一律英文</option>
          </select>
          <input
            ref={fileInputRef}
            type="file"
            accept="audio/*"
            className="hidden"
            onChange={handleImportFile}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={recording || transcribing || importing}
            title="匯入音檔轉錄（例如手機錄好的檔）"
            className="flex items-center gap-1.5 rounded-md border border-line bg-hover-weak px-3 py-1.5 text-sm font-medium text-fg transition hover:bg-hover disabled:opacity-50"
          >
            {importing ? "匯入轉錄中…" : "📁 匯入音檔"}
          </button>
          <button
            onClick={handleRecord}
            disabled={transcribing || importing}
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

      {(onRenameSpeaker || (speakerMap && Object.keys(speakerMap).length > 0)) && (
        <div className="flex flex-wrap items-center gap-2">
          {onRenameSpeaker && (
            <button
              onClick={promptRenameSpeaker}
              title="把逐字稿裡的『發言人N』整份改名，之後同場新轉錄也自動套用"
              className="rounded-md border border-line bg-hover-weak px-2.5 py-1 text-xs text-fg-muted transition hover:bg-hover hover:text-fg"
            >
              ✎ 發言人改名
            </button>
          )}
          {speakerMap &&
            Object.entries(speakerMap).map(([f, t]) => (
              <span key={f} className="rounded bg-hover-weak px-1.5 py-0.5 text-[11px] text-fg-faint">
                {f} → {t}
              </span>
            ))}
        </div>
      )}

      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={"[00:05] 王經理: 這次我們決定主打訂閱制。\n[00:20] 李工: 那行動版優先，桌面版延後。"}
        spellCheck={false}
        className="min-h-[200px] flex-1 resize-none rounded-lg border border-line bg-brand-dark/60 p-3 font-mono text-sm leading-relaxed text-fg outline-none placeholder:text-fg-faint focus:border-brand"
      />

      {(recording || transcribing) && (
        <div className="rounded-lg border border-brand-danger/30 bg-brand-danger/5 p-3">
          <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-brand-danger">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-brand-danger" />
            即時粗稿{transcribing ? "（精修中…即將取代）" : "（停止後自動精修取代）"}
          </div>
          <p className="max-h-28 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-relaxed text-fg-muted">
            {liveDraft ? tidyDraft(liveDraft) : "聆聽中…開始說話就會看到文字"}
          </p>
        </div>
      )}

      <div className="flex items-center gap-2">
        <select
          value={target}
          onChange={(e) => setTarget(e.target.value as TargetLanguage)}
          className="rounded-md border border-line bg-brand-panel px-2 py-1.5 text-sm text-fg outline-none focus:border-brand"
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
        <div className="rounded-lg border border-line bg-brand-panel p-3">
          <div className="mb-2 text-xs font-semibold text-brand-accent">翻譯結果</div>
          <pre className="whitespace-pre-wrap break-words font-mono text-sm leading-relaxed text-fg">
            {translated}
          </pre>
        </div>
      )}
    </section>
  );
}
