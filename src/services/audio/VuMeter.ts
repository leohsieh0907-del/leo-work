// ════════════════════════════════════════════════════════════════════
//  VU 計算 — 純函式
//
//  把一塊 Float32 樣本（-1..1）換算成前端訊號條要的 VuLevel：
//    rms  = sqrt(mean(s^2))   均方根能量
//    peak = max(|s|)          峰值
//    db   = 20*log10(rms)     分貝（dBFS），下限 clamp 在 -100
//
//  無副作用、不依賴任何狀態，方便單元測試與在 AGC 內部重用。
// ════════════════════════════════════════════════════════════════════

import type { VuLevel } from "./types";

/** dBFS 下限：rms 為 0 或極小時統一回報 -100，避免 -Infinity。 */
const DB_FLOOR = -100;

/**
 * 計算單塊樣本的 VU（rms / peak / db）。
 * 空陣列回 { rms:0, peak:0, db:-100 }。純函式，不修改輸入。
 */
export function computeVu(samples: Float32Array): VuLevel {
  const n = samples.length;
  if (n === 0) {
    return { rms: 0, peak: 0, db: DB_FLOOR };
  }

  let sumSquares = 0;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const s = samples[i];
    sumSquares += s * s;
    const abs = s < 0 ? -s : s;
    if (abs > peak) peak = abs;
  }

  const rms = Math.sqrt(sumSquares / n);
  // rms>0 才取 log；否則維持下限避免 log10(0) = -Infinity
  const db = rms > 0 ? Math.max(DB_FLOOR, 20 * Math.log10(rms)) : DB_FLOOR;

  return { rms, peak, db };
}
