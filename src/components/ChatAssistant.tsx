// ── AI 助理（聊天 ＋ 討論完再匯出）──
// 對話式問答：後端結合「當前會議逐字稿 + 跨會議記憶」用 Gemini 回答，記得對話脈絡。
// 匯出：把這段討論 + 會議資料交 Gemini 重組成 Word/Excel/PPT（沒討論＝預設範本）。
// （本元件整合了原本分散的「AI 助理」與「與 AI 討論這份文件」兩個重複面板。）

import { useState, type KeyboardEvent } from "react";
import { chat, composeExport } from "../lib/api";
import type { ActionItem, ChatTurn, ProactiveAnalysis } from "../shared/types";
import type { ExportData } from "../lib/exporters";

const SUGGESTIONS = [
  "幫我總結這場會議的三個重點",
  "有哪些待辦？誰負責、何時交？",
  "整理成給主管的一頁式重點",
];

/** 把分析結果組成 Markdown 會議記錄。 */
function toMarkdown(a: ProactiveAnalysis, items: ActionItem[]): string {
  const out: string[] = ["# 會議記錄", "", "## 會議主題", a.theme || "（無）", "", "## 關鍵討論摘要"];
  if (a.key_summary.length) a.key_summary.forEach((s) => out.push(`- ${s}`));
  else out.push("（無）");
  out.push("", "## 歷史衝突點");
  if (a.historical_conflicts.length) a.historical_conflicts.forEach((c) => out.push(`- ⚠️ ${c}`));
  else out.push("（未發現衝突）");
  out.push("", "## 行動方針");
  if (items.length) {
    out.push("| 任務 | 負責人 | 截止日 |", "|---|---|---|");
    items.forEach((it) => out.push(`| ${it.task} | ${it.assignee} | ${it.deadline} |`));
  } else {
    out.push("（無）");
  }
  return out.join("\n");
}

export default function ChatAssistant({
  transcript,
  analysis,
  actionItems,
  meetingTitle,
  meetingDate,
  big,
  onToggleBig,
  onCollapse,
  collapsed,
  onExpand,
}: {
  transcript: string;
  analysis: ProactiveAnalysis | null;
  actionItems: ActionItem[];
  meetingTitle: string;
  meetingDate: string;
  big?: boolean;
  onToggleBig?: () => void;
  onCollapse?: () => void;
  collapsed?: boolean;
  onExpand?: () => void;
}) {
  const [messages, setMessages] = useState<ChatTurn[]>([]);
  const [suggestions, setSuggestions] = useState<string[]>([]); // 上一則回答後的「接下來可做」建議
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);
  const [exportErr, setExportErr] = useState<string | null>(null);

  const aiMode = messages.length > 0 || input.trim().length > 0;

  async function send(text?: string) {
    const q = (text ?? input).trim();
    if (!q || loading) return;
    const history = messages;
    setMessages((m) => [...m, { role: "user", text: q }]);
    setInput("");
    setSuggestions([]); // 送新問題就先收掉舊建議
    setLoading(true);
    try {
      const r = await chat({ question: q, transcript, history });
      setMessages((m) => [...m, { role: "assistant", text: r.answer }]);
      setSuggestions(r.suggestions ?? []);
    } catch (e) {
      setMessages((m) => [
        ...m,
        { role: "assistant", text: "⚠️ " + (e instanceof Error ? e.message : "出錯了") },
      ]);
    } finally {
      setLoading(false);
    }
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  function handleCopy() {
    if (!analysis) return;
    void navigator.clipboard.writeText(toMarkdown(analysis, actionItems));
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  function handleDownloadMd() {
    if (!analysis) return;
    const blob = new Blob([toMarkdown(analysis, actionItems)], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${meetingTitle?.trim() || "會議記錄"}-${meetingDate || new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  /**
   * 匯出 Word/Excel/PPT：動態載入產檔庫。有討論/指示 → 交 Gemini 依「討論＋會議資料」重組；
   * 完全沒討論 → 走本機預設範本。尚未送出的輸入也會當成最後一句指示。
   */
  async function runExport(kind: "docx" | "xlsx" | "pptx") {
    if (!analysis) return;
    setExportErr(null);
    setExporting(kind);
    try {
      const m = await import("../lib/exporters");
      const data: ExportData = {
        title: meetingTitle?.trim() || "會議記錄",
        date: meetingDate?.trim() || new Date().toISOString().slice(0, 10),
        analysis,
        actionItems,
        transcript,
      };
      const fallback = () => {
        const fn = kind === "docx" ? m.exportDocx : kind === "xlsx" ? m.exportXlsx : m.exportPptx;
        return fn(data);
      };
      if (aiMode) {
        try {
          const { doc } = await composeExport({
            format: kind,
            instruction: input.trim(),
            history: messages,
            title: data.title,
            date: data.date,
            analysis,
            actionItems,
            transcript,
          });
          if (doc.blocks?.length) await m.exportComposed(doc, kind, data);
          else throw new Error("AI 回應為空");
        } catch {
          // AI 重組失敗（過載/安全過濾 RECITATION/空回應）→ 退回預設範本，至少產出檔案
          setExportErr("AI 重組沒成功（可能過載或被安全過濾），已用預設範本匯出，可再試一次");
          await fallback();
        }
      } else {
        await fallback();
      }
    } catch (e) {
      setExportErr(e instanceof Error ? e.message : "匯出失敗");
    } finally {
      setExporting(null);
    }
  }

  /** CSV：資料攤平匯出，走本機預設範本（零 API，不經 AI 重組）。 */
  async function runCsv() {
    if (!analysis) return;
    setExportErr(null);
    setExporting("csv");
    try {
      const m = await import("../lib/exporters");
      await m.exportCsv({
        title: meetingTitle?.trim() || "會議記錄",
        date: meetingDate?.trim() || new Date().toISOString().slice(0, 10),
        analysis,
        actionItems,
        transcript,
      });
    } catch (e) {
      setExportErr(e instanceof Error ? e.message : "匯出失敗");
    } finally {
      setExporting(null);
    }
  }

  const expBtn =
    "rounded-md border border-line bg-hover-weak px-2.5 py-1 text-xs text-fg transition hover:bg-hover disabled:opacity-40";

  // 收合：只顯示一條按鈕，但元件仍掛載 → 對話狀態不會被清空（展開後還在）。
  if (collapsed) {
    return (
      <button
        onClick={onExpand}
        className="flex w-full shrink-0 items-center gap-2 rounded-lg border border-line bg-brand-panel/40 px-4 py-2.5 text-sm text-fg transition hover:bg-brand-panel/60"
      >
        <span className="text-lg">🦉</span>
        <span className="font-medium">AI 助理</span>
        <span className="hidden text-xs text-fg-faint sm:inline">
          — 聊當前會議 ＋ 跨會議記憶，談妥一鍵匯出 Word/Excel/PPT/CSV
        </span>
        {messages.length > 0 && (
          <span className="ml-auto rounded-full bg-brand/20 px-2 py-0.5 text-xs text-fg">
            {messages.length} 則對話
          </span>
        )}
      </button>
    );
  }

  return (
    <section className="flex h-full flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-lg">🦉</span>
        <h2 className="text-sm font-semibold text-fg">AI 助理</h2>
        <span className="hidden text-xs text-fg-faint sm:inline">問當前會議 ＋ 跨會議記憶 ＋ 討論完匯出</span>
        <div className="ml-auto flex items-center gap-3">
          {messages.length > 0 && (
            <button
              onClick={() => {
                setMessages([]);
                setSuggestions([]);
              }}
              className="text-xs text-fg-faint hover:text-fg-muted"
            >
              清空
            </button>
          )}
          {onToggleBig && (
            <button onClick={onToggleBig} className="text-xs text-fg-faint hover:text-fg-muted">
              {big ? "⤡ 縮小" : "⤢ 放大"}
            </button>
          )}
          {onCollapse && (
            <button onClick={onCollapse} className="text-xs text-fg-faint hover:text-fg-muted">
              ▾ 收起
            </button>
          )}
        </div>
      </div>

      {/* 匯出列：聊完／討論完後一鍵產出 */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-fg-faint">匯出：</span>
        <button onClick={handleCopy} disabled={!analysis} className={expBtn}>
          {copied ? "✓ 已複製" : "📋 複製"}
        </button>
        <button onClick={handleDownloadMd} disabled={!analysis} className={expBtn}>
          ⬇ .md
        </button>
        <button onClick={() => void runExport("docx")} disabled={!analysis || exporting !== null} className={expBtn}>
          {exporting === "docx" ? "產生中…" : "📄 Word"}
        </button>
        <button onClick={() => void runExport("xlsx")} disabled={!analysis || exporting !== null} className={expBtn}>
          {exporting === "xlsx" ? "產生中…" : "📊 Excel"}
        </button>
        <button onClick={() => void runCsv()} disabled={!analysis || exporting !== null} className={expBtn}>
          {exporting === "csv" ? "產生中…" : "📑 CSV"}
        </button>
        <button onClick={() => void runExport("pptx")} disabled={!analysis || exporting !== null} className={expBtn}>
          {exporting === "pptx" ? "產生中…" : "📽 PPT"}
        </button>
        {!analysis ? (
          <span className="text-[11px] text-fg-faint">先按上方「分析」才能匯出</span>
        ) : aiMode ? (
          <span className="text-[11px] text-brand-accent">✨ 將依本次討論用 AI 重組後產檔</span>
        ) : null}
      </div>
      {exportErr && <p className="text-xs text-brand-danger">匯出失敗：{exportErr}</p>}

      <div className="flex-1 space-y-2 overflow-y-auto rounded-lg border border-line bg-brand-dark/40 p-3">
        {messages.length === 0 ? (
          <div className="space-y-3">
            <p className="text-sm text-fg-subtle">
              需要什麼？直接問我——我看得到目前的逐字稿，也記得你存過的歷史會議。談妥後可直接從上方「匯出」一鍵產出 Word/Excel/PPT。
            </p>
            <div className="flex flex-wrap gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => void send(s)}
                  className="rounded-full border border-line bg-hover-weak px-3 py-1 text-xs text-fg-muted transition hover:bg-hover"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m, i) => (
            <div key={i} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
              <div
                className={`max-w-[85%] whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-sm leading-relaxed ${
                  m.role === "user" ? "bg-brand text-white" : "bg-brand-panel text-fg"
                }`}
              >
                {m.text}
              </div>
            </div>
          ))
        )}
        {loading && (
          <div className="flex justify-start">
            <div className="rounded-lg bg-brand-panel px-3 py-2 text-sm text-fg-subtle">思考中…</div>
          </div>
        )}
        {!loading && suggestions.length > 0 && (
          <div className="flex flex-col gap-1.5 pt-1">
            <span className="text-[11px] text-fg-faint">💡 接下來可以…</span>
            <div className="flex flex-wrap gap-2">
              {suggestions.map((s) => (
                <button
                  key={s}
                  onClick={() => void send(s)}
                  className="rounded-full border border-brand/40 bg-brand/10 px-3 py-1 text-xs text-fg transition hover:bg-brand/20"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
          placeholder="問問題或討論要怎麼整理…（Enter 送出；談妥按上方匯出）"
          className="flex-1 rounded-md border border-line bg-brand-dark/60 px-3 py-2 text-sm text-fg outline-none placeholder:text-fg-faint focus:border-brand"
        />
        <button
          onClick={() => void send()}
          disabled={loading}
          className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-white transition hover:bg-brand/80 disabled:opacity-50"
        >
          送出
        </button>
      </div>
    </section>
  );
}
