// ════════════════════════════════════════════════════════════════════
//  AGC — 動態自動增益控制
//
//  目標：把忽大忽小的收音音量拉到一致的目標 RMS（讓 Whisper 與 VU 條穩定），
//  同時避免兩個常見毛病：
//    1) 突然爆音 → 用 attack/release 平滑增益，不讓增益瞬間跳動造成抽動感。
//    2) 靜音時把底噪放大成沙沙聲 → rms 低於 noise floor 時凍結增益、不爆衝。
//
//  增益是「跨塊」記憶的狀態：每塊往本塊的理想增益(desired)平滑靠近，
//  上升慢(attack)、下降快(release)，符合一般 AGC 的聽感（怕削波，放大要保守）。
// ════════════════════════════════════════════════════════════════════

import type { AgcOptions } from "./types";

/** 預設參數（與 types.ts 的註解一致）。 */
const DEFAULTS = {
  targetRms: 0.12,
  maxGain: 12,
  attack: 0.2,
  release: 0.05,
} as const;

/**
 * 噪音底線：本塊 rms 低於此值視為「實質靜音」。
 * 此時不再追高增益（否則會把背景底噪放大成噪音），改為讓增益緩緩回落到 1，
 * 以免下一次有人說話時殘留過高增益造成爆音。
 */
const NOISE_FLOOR = 1e-4;

/** 計算 rms 時避免除以 0 的下限。 */
const RMS_EPS = 1e-6;

function clamp(x: number, lo: number, hi: number): number {
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}

export class Agc {
  private readonly targetRms: number;
  private readonly maxGain: number;
  private readonly attack: number;
  private readonly release: number;

  /** 目前平滑後的增益倍率（跨塊保留）；初始 1（不放大不衰減）。 */
  private g = 1;

  constructor(opts: AgcOptions = {}) {
    // 逐項套預設；同時夾住平滑係數在合法區間，避免外部傳入 >1 造成過衝。
    this.targetRms = opts.targetRms ?? DEFAULTS.targetRms;
    this.maxGain = opts.maxGain ?? DEFAULTS.maxGain;
    this.attack = clamp(opts.attack ?? DEFAULTS.attack, 0, 1);
    this.release = clamp(opts.release ?? DEFAULTS.release, 0, 1);
  }

  /**
   * 對一塊樣本套用平滑增益，回傳「新的」Float32Array（不改原陣列），
   * 並更新內部增益狀態。輸出已 clamp 在 -1..1（硬限幅，避免削波溢位）。
   */
  process(samples: Float32Array): Float32Array {
    const n = samples.length;
    const out = new Float32Array(n);
    if (n === 0) {
      return out; // 空塊：不動增益，回空陣列
    }

    // 本塊 rms（自算，避免額外配置）
    let sumSquares = 0;
    for (let i = 0; i < n; i++) {
      const s = samples[i];
      sumSquares += s * s;
    }
    const rms = Math.sqrt(sumSquares / n);

    if (rms < NOISE_FLOOR) {
      // 實質靜音：凍結追高，讓增益以 release 速度緩緩回落到 1，避免放大底噪。
      this.g += (1 - this.g) * this.release;
    } else {
      // 想要的增益：把本塊 rms 拉到 targetRms，夾在 [0, maxGain]。
      const desired = clamp(this.targetRms / Math.max(rms, RMS_EPS), 0, this.maxGain);
      // 上升用 attack（慢、保守，怕爆音）；下降用 release（快，快速壓回避免削波）。
      const coeff = desired > this.g ? this.attack : this.release;
      this.g += (desired - this.g) * coeff;
    }

    // 套用增益並硬限幅在 -1..1
    const g = this.g;
    for (let i = 0; i < n; i++) {
      out[i] = clamp(samples[i] * g, -1, 1);
    }
    return out;
  }

  /** 目前增益倍率（給 status / 測試讀取）。 */
  get gain(): number {
    return this.g;
  }

  /** 重置增益回 1（換來源或重連時呼叫，避免沿用上個來源的增益）。 */
  reset(): void {
    this.g = 1;
  }
}
