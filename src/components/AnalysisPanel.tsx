// ── 主動式分析結果面板（純顯示）──
// 渲染：會議主題、關鍵討論摘要、⚠️ 歷史衝突點、行動方針表格。
// 匯出（複製/.md/Word/Excel/PPT）與「與 AI 討論」已整合到底部的 🦉 AI 助理。

import type { ActionItem, ProactiveAnalysis } from "../shared/types";

interface AnalysisPanelProps {
  analysis: ProactiveAnalysis | null;
  actionItems: ActionItem[];
  historicalContext: string;
  loading: boolean;
}

export default function AnalysisPanel({
  analysis,
  actionItems,
  historicalContext,
  loading,
}: AnalysisPanelProps) {
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
