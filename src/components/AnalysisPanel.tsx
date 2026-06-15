// ── 主動式分析結果面板 ──
// 渲染：會議主題、關鍵討論摘要、⚠️ 歷史衝突點、行動方針表格；可複製/匯出 Markdown。

import { useState } from "react";
import type { ActionItem, ProactiveAnalysis } from "../shared/types";
import type { ExportData } from "../lib/exporters";
import { composeExport } from "../lib/api";

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
  const [instruction, setInstruction] = useState(""); // AI 客製匯出指示（留空＝預設範本）

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

  /**
   * 共用：動態載入產檔庫（只在按下時才載），把當前分析包成匯出資料。
   * 有填指示 → 先請 Gemini 依指示重組（/export/compose）再渲染；留空 → 走本機預設範本。
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
      const instr = instruction.trim();
      if (instr) {
        const { doc } = await composeExport({
          format: kind,
          instruction: instr,
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
      {/* AI 客製匯出指示（選填）：留空＝預設範本；填了＝Gemini 依指示重組後再匯出 */}
      <div className="flex flex-col gap-1">
        <input
          type="text"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="🤖 AI 客製匯出（選填）：例「PPT 只放結論和數字」「Word 用正式公文語氣」「Excel 加一欄優先級」"
          className="w-full rounded-md border border-white/10 bg-brand-dark/60 px-2.5 py-1.5 text-xs text-slate-100 outline-none placeholder:text-slate-500 focus:border-brand"
        />
        {instruction.trim() && (
          <span className="text-[11px] text-brand-accent">
            ✨ 已啟用 AI 客製：點下方格式鈕會先請 AI 依你的指示重組內容再產檔（多一次 Gemini 呼叫）
          </span>
        )}
      </div>

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
