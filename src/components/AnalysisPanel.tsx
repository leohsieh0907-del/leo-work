// ── 主動式分析結果面板 ──
// 渲染：會議主題、關鍵討論摘要、⚠️ 歷史衝突點、行動方針表格；可複製/匯出 Markdown。

import { useState } from "react";
import type { ActionItem, ChatTurn, ProactiveAnalysis } from "../shared/types";
import type { ExportData } from "../lib/exporters";
import { chat, composeExport } from "../lib/api";

interface AnalysisPanelProps {
  analysis: ProactiveAnalysis | null;
  actionItems: ActionItem[];
  historicalContext: string;
  loading: boolean;
  transcript?: string;
  meetingTitle?: string;
  meetingDate?: string;
}

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

export default function AnalysisPanel({
  analysis,
  actionItems,
  historicalContext,
  loading,
  transcript,
  meetingTitle,
  meetingDate,
}: AnalysisPanelProps) {
  const [copied, setCopied] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);
  const [exportErr, setExportErr] = useState<string | null>(null);

  // 「與 AI 討論這份文件」：討論完再產出。留空＝預設範本。
  const [discussOpen, setDiscussOpen] = useState(false);
  const [messages, setMessages] = useState<ChatTurn[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatBusy, setChatBusy] = useState(false);

  async function handleCopy() {
    if (!analysis) return;
    await navigator.clipboard.writeText(toMarkdown(analysis, actionItems));
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  function handleDownload() {
    if (!analysis) return;
    const blob = new Blob([toMarkdown(analysis, actionItems)], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `會議記錄-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const aiMode = messages.length > 0 || chatInput.trim().length > 0;

  /** 送出一輪討論（沿用 /chat：當前逐字稿 + 跨會議記憶 + 多輪脈絡）。 */
  async function handleSend() {
    const q = chatInput.trim();
    if (!q || chatBusy) return;
    setExportErr(null);
    setChatBusy(true);
    const prior = messages;
    setMessages([...prior, { role: "user", text: q }]);
    setChatInput("");
    try {
      const { answer } = await chat({ question: q, transcript: transcript ?? "", history: prior });
      setMessages((m) => [...m, { role: "assistant", text: answer }]);
    } catch (e) {
      setExportErr(e instanceof Error ? e.message : "討論失敗");
    } finally {
      setChatBusy(false);
    }
  }

  /**
   * 共用：動態載入產檔庫（只在按下時才載），把當前分析包成匯出資料。
   * 有討論/指示 → 先請 Gemini 依「討論＋會議資料」重組（/export/compose）再渲染；
   * 完全留空 → 走本機預設範本。尚未送出的輸入也會當成最後一句指示帶入。
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
      if (aiMode) {
        const { doc } = await composeExport({
          format: kind,
          instruction: chatInput.trim(), // 尚未送出的輸入＝最後指示（可空）
          history: messages,
          title: data.title,
          date: data.date,
          analysis,
          actionItems,
          transcript,
        });
        await m.exportComposed(doc, kind, data);
      } else {
        const fn = kind === "docx" ? m.exportDocx : kind === "xlsx" ? m.exportXlsx : m.exportPptx;
        await fn(data);
      }
    } catch (e) {
      setExportErr(e instanceof Error ? e.message : "匯出失敗");
    } finally {
      setExporting(null);
    }
  }

  if (loading) {
    return (
      <section className="flex h-full items-center justify-center text-sm text-slate-400">
        AI 分析中…（橫向比對歷史背景）
      </section>
    );
  }

  if (!analysis) {
    return (
      <section className="flex h-full items-center justify-center text-center text-sm text-slate-500">
        貼上逐字稿後按「分析」，這裡會顯示主題摘要、歷史衝突與行動方針。
      </section>
    );
  }

  return (
    <section className="flex h-full flex-col gap-4 overflow-y-auto pr-1">
      {/* 與 AI 討論這份文件（討論完再產出）。可收合，預設收起讓分析有完整高度。 */}
      <div className="rounded-md border border-white/10 bg-black/20">
        <button
          onClick={() => setDiscussOpen((v) => !v)}
          className="flex w-full items-center justify-between px-3 py-2 text-xs font-medium text-slate-100 transition hover:bg-white/5"
        >
          <span>🤖 與 AI 討論這份文件後再匯出{messages.length > 0 ? `（已討論 ${messages.length} 則）` : ""}</span>
          <span className="text-slate-400">{discussOpen ? "▾ 收起" : "▸ 展開"}</span>
        </button>
        {discussOpen && (
          <div className="flex flex-col gap-2 px-3 pb-3">
            {messages.length > 0 && (
              <div className="max-h-44 space-y-2 overflow-y-auto rounded-md bg-black/20 p-2">
                {messages.map((msg, i) => (
                  <div key={i} className={msg.role === "user" ? "text-right" : "text-left"}>
                    <span
                      className={`inline-block max-w-[85%] whitespace-pre-wrap rounded-lg px-2.5 py-1.5 text-xs ${
                        msg.role === "user" ? "bg-brand/30 text-slate-100" : "bg-white/5 text-slate-200"
                      }`}
                    >
                      {msg.text}
                    </span>
                  </div>
                ))}
                {chatBusy && <p className="text-left text-xs text-slate-500">AI 思考中…</p>}
              </div>
            )}
            <div className="flex items-end gap-2">
              <textarea
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void handleSend();
                  }
                }}
                rows={2}
                placeholder="跟 AI 討論要怎麼整理，例「幫我精簡成給投資人看的」「行動方針加一欄優先級」，談完按下方格式鈕產出。Enter 送出 / Shift+Enter 換行"
                className="flex-1 resize-none rounded-md border border-white/10 bg-brand-dark/60 px-2.5 py-1.5 text-xs text-slate-100 outline-none placeholder:text-slate-500 focus:border-brand"
              />
              <button
                onClick={() => void handleSend()}
                disabled={chatBusy || !chatInput.trim()}
                className="shrink-0 rounded-md bg-brand px-3 py-2 text-xs font-medium text-white transition hover:bg-brand/80 disabled:opacity-50"
              >
                送出
              </button>
              {messages.length > 0 && (
                <button
                  onClick={() => setMessages([])}
                  disabled={chatBusy}
                  className="shrink-0 rounded-md border border-white/10 px-2 py-2 text-xs text-slate-400 transition hover:text-slate-200 disabled:opacity-50"
                >
                  清除
                </button>
              )}
            </div>
          </div>
        )}
      </div>
      {aiMode && (
        <span className="-mt-2 text-[11px] text-brand-accent">
          ✨ 已啟用 AI 客製：點下方 Word/Excel/PPT 會依「討論＋會議資料」用 AI 重組後再產檔（多一次 Gemini 呼叫）
        </span>
      )}

      {/* 匯出列 */}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <button
          onClick={handleCopy}
          className="rounded-md border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-slate-200 transition hover:bg-white/10"
        >
          {copied ? "✓ 已複製" : "📋 複製"}
        </button>
        <button
          onClick={handleDownload}
          className="rounded-md border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-slate-200 transition hover:bg-white/10"
        >
          ⬇ .md
        </button>
        <button
          onClick={() => void runExport("docx")}
          disabled={exporting !== null}
          className="rounded-md border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-slate-200 transition hover:bg-white/10 disabled:opacity-50"
        >
          {exporting === "docx" ? "產生中…" : "📄 Word"}
        </button>
        <button
          onClick={() => void runExport("xlsx")}
          disabled={exporting !== null}
          className="rounded-md border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-slate-200 transition hover:bg-white/10 disabled:opacity-50"
        >
          {exporting === "xlsx" ? "產生中…" : "📊 Excel"}
        </button>
        <button
          onClick={() => void runExport("pptx")}
          disabled={exporting !== null}
          className="rounded-md border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-slate-200 transition hover:bg-white/10 disabled:opacity-50"
        >
          {exporting === "pptx" ? "產生中…" : "📽 PPT"}
        </button>
      </div>
      {exportErr && <p className="text-right text-xs text-brand-danger">匯出失敗：{exportErr}</p>}

      {/* 會議主題 */}
      <div>
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">會議主題</h3>
        <p className="text-base font-semibold text-slate-100">{analysis.theme}</p>
      </div>

      {/* 關鍵討論摘要 */}
      <div>
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">關鍵討論摘要</h3>
        {analysis.key_summary.length > 0 ? (
          <ul className="list-disc space-y-1 pl-5 text-sm text-slate-200">
            {analysis.key_summary.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-slate-500">無摘要</p>
        )}
      </div>

      {/* 歷史衝突點 */}
      <div>
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
          ⚠️ 歷史衝突點
        </h3>
        {analysis.historical_conflicts.length > 0 ? (
          <ul className="space-y-2">
            {analysis.historical_conflicts.map((c, i) => (
              <li
                key={i}
                className="rounded-md border border-brand-warn/40 bg-brand-warn/10 px-3 py-2 text-sm text-brand-warn"
              >
                {c}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-brand-accent">未發現衝突</p>
        )}
      </div>

      {/* 行動方針表格 */}
      <div>
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">行動方針</h3>
        {actionItems.length > 0 ? (
          <div className="overflow-hidden rounded-lg border border-white/10">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="bg-white/5 text-left text-xs text-slate-400">
                  <th className="px-3 py-2 font-medium">任務</th>
                  <th className="px-3 py-2 font-medium">負責人</th>
                  <th className="px-3 py-2 font-medium">截止日</th>
                </tr>
              </thead>
              <tbody>
                {actionItems.map((it, i) => (
                  <tr key={i} className="border-t border-white/5">
                    <td className="px-3 py-2 text-slate-100">{it.task}</td>
                    <td className="px-3 py-2 text-slate-300">{it.assignee}</td>
                    <td className="px-3 py-2 text-slate-300">{it.deadline}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-slate-500">未提取到行動方針</p>
        )}
      </div>

      {/* 採用的歷史背景（除錯/透明度） */}
      {historicalContext.trim() && (
        <details className="rounded-lg border border-white/10 bg-brand-panel/60 p-3">
          <summary className="cursor-pointer text-xs font-semibold text-slate-400">
            本次比對採用的歷史背景
          </summary>
          <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-slate-400">
            {historicalContext}
          </pre>
        </details>
      )}
    </section>
  );
}
