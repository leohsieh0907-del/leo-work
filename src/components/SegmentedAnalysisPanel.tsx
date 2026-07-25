// ── 各段獨立分析結果（B 模式）──
// 每個時段一張可摺疊卡片，內含該段的完整分析（重用 AnalysisBody），可各自匯出 Word。
// 預設展開第一段；其餘收合。匯出走動態 import 的 exporters（與 AI 助理匯出同一套）。

import { useState } from "react";
import type { ActionItem, ProactiveAnalysis } from "../shared/types";
import { AnalysisBody } from "./AnalysisPanel";

export interface SegmentResult {
  label: string; // 例如 "1–3 分"
  analysis: ProactiveAnalysis;
  actionItems: ActionItem[];
}

interface Props {
  segments: SegmentResult[];
  title: string; // 會議名稱（組匯出檔名）
  date: string; // YYYY-MM-DD
}

export default function SegmentedAnalysisPanel({ segments, title, date }: Props) {
  const [openIdx, setOpenIdx] = useState(0); // 預設展開第一段（-1 = 全收合）
  const [exporting, setExporting] = useState<number | null>(null);

  async function exportSeg(seg: SegmentResult, i: number) {
    setExporting(i);
    try {
      const m = await import("../lib/exporters");
      await m.exportDocx({
        title: `${title}（${seg.label}）`,
        date,
        analysis: seg.analysis,
        actionItems: seg.actionItems,
      });
    } catch {
      // 匯出失敗不阻斷（使用者可重試）
    } finally {
      setExporting(null);
    }
  }

  return (
    <section className="flex h-full flex-col gap-2 overflow-y-auto pr-1">
      <p className="text-xs text-fg-faint">
        各段獨立分析（{segments.length} 段）· 點標題展開／收合，可各自匯出
      </p>
      {segments.map((seg, i) => {
        const open = i === openIdx;
        return (
          <div key={i} className="rounded-lg border border-line bg-brand-panel/40">
            <div className="flex items-center justify-between gap-2 px-3 py-2">
              <button
                onClick={() => setOpenIdx(open ? -1 : i)}
                className="flex-1 truncate text-left text-sm font-semibold text-fg transition hover:text-brand"
              >
                {open ? "▾" : "▸"} 第 {seg.label}
                <span className="ml-2 font-normal text-fg-muted">{seg.analysis.theme}</span>
              </button>
              <button
                onClick={() => exportSeg(seg, i)}
                disabled={exporting === i}
                className="shrink-0 rounded border border-line px-2 py-0.5 text-xs text-fg-muted transition hover:bg-hover disabled:opacity-50"
              >
                {exporting === i ? "匯出中…" : "⬇ Word"}
              </button>
            </div>
            {open && (
              <div className="border-t border-line p-3">
                <AnalysisBody analysis={seg.analysis} actionItems={seg.actionItems} />
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}
