// ── 主動式分析結果面板 ──
// 渲染：會議主題、關鍵討論摘要、⚠️ 歷史衝突點、行動方針表格；可複製/匯出 Markdown。

import { useState } from "react";
import type { ActionItem, ProactiveAnalysis } from "../shared/types";

interface AnalysisPanelProps {
  analysis: ProactiveAnalysis | null;
  actionItems: ActionItem[];
  historicalContext: string;
  loading: boolean;
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
}: AnalysisPanelProps) {
  const [copied, setCopied] = useState(false);

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
      {/* 匯出列 */}
      <div className="flex items-center justify-end gap-2">
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
          ⬇ 匯出 .md
        </button>
      </div>

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
