// ════════════════════════════════════════════════════════════════════
//  DSP 純邏輯單元測試（vitest）
//
//  涵蓋：
//    - VuMeter.computeVu：靜音 / 方波 / 空陣列
//    - Agc.process：小訊號增益爬升並收斂到目標 RMS、大訊號不削波、reset
//    - AudioSync.accept：正常遞增 / 缺口補靜音 / 重送丟棄 / reset
//
//  全部不需要真實音訊裝置或網路，可直接 `vitest run`。
// ════════════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";

import { computeVu } from "../VuMeter";
import { Agc } from "../Agc";
import { AudioSync } from "../AudioSync";
import type { AudioChunk } from "../types";

// ─────────────── 測試輔助：產生樣本 ───────────────

/** 產生長度 n、所有值皆為 value 的常數塊。 */
function constBlock(value: number, n = 1024): Float32Array {
  return new Float32Array(n).fill(value);
}

/** 產生 ±amp 交替的方波（rms === peak === amp）。 */
function squareWave(amp: number, n = 1024): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = i % 2 === 0 ? amp : -amp;
  return out;
}

/** 包成 AudioChunk（手機來源預設）。 */
function chunk(seq: number, samples: Float32Array, source: "computer" | "phone" = "phone"): AudioChunk {
  return { seq, timestampMs: seq * 64, samples, source };
}

// ════════════════ VuMeter ════════════════

describe("VuMeter.computeVu", () => {
  it("全 0 樣本 → rms 0、peak 0、db -100", () => {
    const vu = computeVu(constBlock(0));
    expect(vu.rms).toBe(0);
    expect(vu.peak).toBe(0);
    expect(vu.db).toBe(-100);
  });

  it("空陣列 → rms 0、peak 0、db -100", () => {
    const vu = computeVu(new Float32Array(0));
    expect(vu).toEqual({ rms: 0, peak: 0, db: -100 });
  });

  it("±0.5 方波 → rms≈0.5、peak 0.5", () => {
    const vu = computeVu(squareWave(0.5));
    expect(vu.rms).toBeCloseTo(0.5, 6);
    expect(vu.peak).toBeCloseTo(0.5, 6);
    // 0.5 的 dBFS ≈ 20*log10(0.5) ≈ -6.02
    expect(vu.db).toBeCloseTo(-6.0206, 3);
  });

  it("db 下限 clamp 在 -100（極小訊號不會低於 -100）", () => {
    const vu = computeVu(constBlock(1e-9));
    expect(vu.db).toBeGreaterThanOrEqual(-100);
  });
});

// ════════════════ Agc ════════════════

describe("Agc", () => {
  it("小振幅持續輸入：增益隨時間上升、輸出 rms 往 targetRms 靠近", () => {
    const agc = new Agc(); // targetRms=0.12
    const gains: number[] = [];
    let lastOut: Float32Array = new Float32Array(0);

    // 餵 50 塊 0.01 振幅方波（rms=0.01，遠低於目標）
    for (let i = 0; i < 50; i++) {
      lastOut = agc.process(squareWave(0.01));
      gains.push(agc.gain);
    }

    // 增益單調上升（attack 平滑爬升）
    expect(gains[10]).toBeGreaterThan(gains[0]);
    expect(gains[49]).toBeGreaterThan(gains[10]);

    // 收斂後輸出 rms 應接近目標 0.12（dynamic 拉抬成功）
    const outRms = computeVu(lastOut).rms;
    expect(outRms).toBeGreaterThan(0.08);
    expect(outRms).toBeLessThanOrEqual(0.13);
  });

  it("增益受 maxGain 上限約束（極小訊號不會超過 12 倍）", () => {
    const agc = new Agc({ maxGain: 12 });
    for (let i = 0; i < 100; i++) agc.process(squareWave(0.001));
    expect(agc.gain).toBeLessThanOrEqual(12 + 1e-9);
  });

  it("大振幅輸入：輸出硬限幅在 ±1（無削波溢位）", () => {
    const agc = new Agc();
    for (let i = 0; i < 20; i++) {
      const out = agc.process(squareWave(0.9));
      for (let j = 0; j < out.length; j++) {
        expect(out[j]).toBeLessThanOrEqual(1);
        expect(out[j]).toBeGreaterThanOrEqual(-1);
      }
    }
  });

  it("靜音不會把增益爆衝到 maxGain（避免放大底噪）", () => {
    const agc = new Agc();
    // 先靠真實訊號把增益拉高一點
    for (let i = 0; i < 10; i++) agc.process(squareWave(0.05));
    const before = agc.gain;
    // 餵純靜音多塊：增益應緩降回落，而非爆衝到 maxGain
    for (let i = 0; i < 30; i++) agc.process(constBlock(0));
    expect(agc.gain).toBeLessThanOrEqual(before);
    expect(agc.gain).toBeLessThan(12);
  });

  it("不修改輸入陣列、回傳新陣列", () => {
    const agc = new Agc();
    const input = squareWave(0.2);
    const copy = Float32Array.from(input);
    const out = agc.process(input);
    expect(out).not.toBe(input);
    expect(input).toEqual(copy); // 原陣列不變
  });

  it("reset 把增益歸回 1", () => {
    const agc = new Agc();
    for (let i = 0; i < 30; i++) agc.process(squareWave(0.01));
    expect(agc.gain).not.toBe(1);
    agc.reset();
    expect(agc.gain).toBe(1);
  });

  it("空塊回空陣列且不改變增益", () => {
    const agc = new Agc();
    const g0 = agc.gain;
    const out = agc.process(new Float32Array(0));
    expect(out.length).toBe(0);
    expect(agc.gain).toBe(g0);
  });
});

// ════════════════ AudioSync ════════════════

describe("AudioSync", () => {
  it("第一塊建立基準、補 0", () => {
    const sync = new AudioSync();
    const r = sync.accept(chunk(0, constBlock(0, 256)));
    expect(r).toEqual({ accepted: true, insertedSilence: 0 });
    expect(sync.lastSeq).toBe(0);
  });

  it("seq 0→1→3：缺口幀補靜音 = 1 * 本塊長度", () => {
    const sync = new AudioSync();
    const len = 256;
    sync.accept(chunk(0, constBlock(0, len)));
    const r1 = sync.accept(chunk(1, constBlock(0, len)));
    expect(r1).toEqual({ accepted: true, insertedSilence: 0 });

    // 跳到 seq 3：中間掉了 seq 2（missing=1），補 1*len 靜音
    const r3 = sync.accept(chunk(3, constBlock(0, len)));
    expect(r3.accepted).toBe(true);
    expect(r3.insertedSilence).toBe(1 * len);
    expect(sync.lastSeq).toBe(3);
  });

  it("重送 seq3（<= lastSeq）→ 丟棄", () => {
    const sync = new AudioSync();
    sync.accept(chunk(0, constBlock(0, 256)));
    sync.accept(chunk(3, constBlock(0, 256))); // 跳號接受，lastSeq=3
    const dup = sync.accept(chunk(3, constBlock(0, 256)));
    expect(dup).toEqual({ accepted: false, insertedSilence: 0 });
    // 亂序更舊的也丟
    const older = sync.accept(chunk(1, constBlock(0, 256)));
    expect(older).toEqual({ accepted: false, insertedSilence: 0 });
    expect(sync.lastSeq).toBe(3);
  });

  it("缺口補位用『本塊長度』估算每幀樣本數", () => {
    const sync = new AudioSync();
    sync.accept(chunk(0, constBlock(0, 100)));
    // 掉了 seq 1,2,3（missing=3），本塊長度 200 → 補 3*200=600
    const r = sync.accept(chunk(4, constBlock(0, 200)));
    expect(r.insertedSilence).toBe(3 * 200);
  });

  it("reset 後可從任意 seq 重新開始", () => {
    const sync = new AudioSync();
    sync.accept(chunk(5, constBlock(0, 256)));
    expect(sync.lastSeq).toBe(5);
    sync.reset();
    expect(sync.lastSeq).toBe(-1);
    const r = sync.accept(chunk(42, constBlock(0, 256)));
    expect(r).toEqual({ accepted: true, insertedSilence: 0 });
    expect(sync.lastSeq).toBe(42);
  });
});
