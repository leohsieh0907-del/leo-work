import type { VuLevel } from "../shared/types";

// ── VU 訊號條：把 0..1 的能量畫成分段色條（綠→黃→紅）──
// 資料接口：由父層透過 /events 的 "vu" 事件取得 VuLevel 後傳入。

export default function VuMeter({ level, label }: { level: VuLevel | null; label?: string }) {
  const rms = level ? clamp01(level.rms) : 0;
  const peak = level ? clamp01(level.peak) : 0;
  const segments = 24;
  const litRms = Math.round(rms * segments);
  const peakSeg = Math.round(peak * segments);

  return (
    <div className="flex flex-col gap-1">
      {label && (
        <div className="flex justify-between text-[11px] text-slate-400">
          <span>{label}</span>
          <span className="font-mono">{level ? `${level.db.toFixed(0)} dB` : "—"}</span>
        </div>
      )}
      <div className="flex h-4 items-stretch gap-[2px] rounded bg-black/40 p-[2px]">
        {Array.from({ length: segments }).map((_, i) => {
          const isLit = i < litRms;
          const isPeak = i === peakSeg - 1;
          const color =
            i > segments * 0.85
              ? "bg-brand-danger"
              : i > segments * 0.6
                ? "bg-brand-warn"
                : "bg-brand-accent";
          return (
            <div
              key={i}
              className={`flex-1 rounded-[1px] ${
                isLit || isPeak ? color : "bg-white/5"
              } ${isPeak ? "opacity-100" : isLit ? "opacity-90" : "opacity-100"}`}
            />
          );
        })}
      </div>
    </div>
  );
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
