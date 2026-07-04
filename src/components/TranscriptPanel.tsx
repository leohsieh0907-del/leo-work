// ── 逐字稿面板 ──
// 一個大 textarea 讓使用者貼上 / 編輯帶 [mm:ss] 發言人: 的逐字稿，
// 附「匯入音檔轉錄」「翻譯」「發言人改名」。
//
// 註：即時錄音（麥克風 / 電腦系統 / 手機）已收斂到頂部 RouterBar 的收音來源，
//     停止後由 router 自動整檔精修帶入此逐字稿（見 Workspace 的自動精修流程）。
//     本面板只保留「匯入既有音檔」與文字編修，不再自行開麥克風。

import { useEffect, useRef, useState } from "react";
import { translate, transcribeFile } from "../lib/api";
import type { TargetLanguage, TranscribeLang } from "../shared/types";

interface TranscriptPanelProps {
  value: string;
  onChange: (v: string) => void;
  /** 匯入轉錄進行中回報給父層（用來判斷工作階段、擋切換會議）。 */
  onBusyChange?: (busy: boolean) => void;
  /** 匯入音檔的轉錄結果；交父層併入「目前」會議＋套用發言人改名（不走錄音 origin 路由）。 */
  onImportedText?: (text: string) => void;
  /** 發言人改名（原名→新名）。 */
  onRenameSpeaker?: (from: string, to: string) => void;
  /** 目前已套用的發言人改名對應（顯示用）。 */
  speakerMap?: Record<string, string>;
}

/** 正規化匯入音檔的 MIME：瀏覽器對 M4A 常回空字串或 audio/x-m4a；依副檔名補正。 */
function normalizeMime(file: File): string {
  const t = (file.type || "").toLowerCase();
  if (t && t !== "application/octet-stream" && t !== "audio/x-m4a") return t;
  const ext = file.name.toLowerCase().split(".").pop() ?? "";
  const map: Record<string, string> = {
    m4a: "audio/mp4", mp4: "audio/mp4", aac: "audio/aac", mp3: "audio/mpeg",
    wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg",
    webm: "audio/webm", flac: "audio/flac", "3gp": "audio/3gpp", amr: "audio/amr",
  };
  return map[ext] ?? "application/octet-stream";
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
  onImportedText,
  onRenameSpeaker,
  speakerMap,
}: TranscriptPanelProps) {
  const [target, setTarget] = useState<TargetLanguage>("en");
  const [translated, setTranslated] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false); // 匯入音檔轉錄中
  const [transLang, setTransLang] = useState<TranscribeLang>("auto"); // 匯入轉錄輸出語言
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 匯入轉錄進行中＝忙碌，回報父層擋切換會議
  useEffect(() => {
    onBusyChange?.(importing);
  }, [importing, onBusyChange]);

  function promptRenameSpeaker() {
    const from = window.prompt("要改哪個發言人？（輸入目前顯示的名稱，例如 發言人1）");
    if (!from?.trim()) return;
    const to = window.prompt(`把「${from.trim()}」全部改成：`);
    if (!to?.trim()) return;
    onRenameSpeaker?.(from, to);
  }

  // 匯入音檔（例如手機錄好的 M4A）→ 原始位元組直接上傳（不經 base64/JSON，無大小上限）
  // → 後端 ffmpeg 轉檔 + 分段混合轉錄 → 併入「目前」會議（不走錄音 origin 路由）。
  async function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // 清掉以便能再選同一個檔
    if (!file) return;
    setError(null);
    setImporting(true);
    try {
      const r = await transcribeFile(file, normalizeMime(file), transLang);
      const text = r.transcript.trim();
      if (text) onImportedText?.(text);
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
            disabled={importing}
            title="匯入音檔轉錄的輸出語言"
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
            disabled={importing}
            title="匯入音檔轉錄（例如手機錄好的檔）"
            className="flex items-center gap-1.5 rounded-md border border-line bg-hover-weak px-3 py-1.5 text-sm font-medium text-fg transition hover:bg-hover disabled:opacity-50"
          >
            {importing ? "匯入轉錄中…" : "📁 匯入音檔"}
          </button>
        </div>
      </div>

      {/* 收音提示：錄音入口已移到頂部收音列 */}
      <p className="text-xs text-fg-faint">
        🎙 要錄音請用上方收音列（麥克風 / 電腦系統 / 手機）；停止後會自動精修帶入這裡。
      </p>

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
