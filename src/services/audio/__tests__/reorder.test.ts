// ════════════════════════════════════════════════════════════════════
//  AudioReorderingQueue 純邏輯單元測試（vitest）
//
//  涵蓋 WebRTC RTP 重組的關鍵情境：
//    ① 順序到達       → 每次 push 立即依序釋放，緩衝不堆積。
//    ② 亂序 (1,3,2)   → 缺口補齊後依序釋放，且時機正確。
//    ③ 重複 / 遲到    → 被丟棄、dropped 計數正確、不影響輸出序。
//    ④ 缺口超 maxDepth → 強制跳過釋放、不卡死，dropped 計入被跳過數。
//    ⑤ flush / reset  → flush 吐出剩餘並推進基準；reset 全歸零。
//
//  全部不需網路或音訊裝置，可直接 `vitest run`。item 用字串標記方便斷言。
// ════════════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";

import { AudioReorderingQueue } from "../AudioReorderingQueue";

/** 以序號當標記值，方便斷言釋放順序。 */
function tag(seq: number): string {
  return `pkt-${seq}`;
}

describe("AudioReorderingQueue", () => {
  // ① 順序到達：每次 push 立即釋放，緩衝深度恆為 0。
  it("依序到達時逐一立即釋放、緩衝不堆積、無丟棄", () => {
    const q = new AudioReorderingQueue<string>();
    const out: string[] = [];

    for (let seq = 10; seq <= 14; seq++) {
      const released = q.push(seq, tag(seq));
      expect(released).toEqual([tag(seq)]); // 每包到就立刻釋放
      out.push(...released);
      expect(q.depth).toBe(0); // 完全不堆積
    }

    expect(out).toEqual([tag(10), tag(11), tag(12), tag(13), tag(14)]);
    expect(q.dropped).toBe(0);
  });

  // ② 亂序 (1,3,2)：3 先到要等 2，補齊後一次吐出 2、3。
  it("亂序到達時等缺口補齊再依序釋放", () => {
    const q = new AudioReorderingQueue<string>();

    // seq=1 首包，立即釋放並設基準。
    expect(q.push(1, tag(1))).toEqual([tag(1)]);

    // seq=3 先到：缺 2，先緩衝、不釋放。
    expect(q.push(3, tag(3))).toEqual([]);
    expect(q.depth).toBe(1);

    // seq=2 補上：2、3 連續，一次吐出。
    expect(q.push(2, tag(2))).toEqual([tag(2), tag(3)]);
    expect(q.depth).toBe(0);
    expect(q.dropped).toBe(0);
  });

  // ③ 重複 / 遲到封包：被丟棄、dropped 正確、輸出序不受污染。
  it("重複與遲到封包被丟棄且 dropped 計數正確", () => {
    const q = new AudioReorderingQueue<string>();

    expect(q.push(5, tag(5))).toEqual([tag(5)]); // 基準=5，釋放後 nextSeq=6
    expect(q.push(6, tag(6))).toEqual([tag(6)]); // nextSeq=7

    // 重送已釋放的 5、6（遲到，seq < nextSeq）→ 丟棄。
    expect(q.push(5, tag(5))).toEqual([]);
    expect(q.push(6, tag(6))).toEqual([]);
    expect(q.dropped).toBe(2);

    // 緩衝中重複同序號（8 已在等待，再來一個 8）→ 丟棄。
    expect(q.push(8, tag(8))).toEqual([]); // 缺 7，緩衝
    expect(q.push(8, "dup-8")).toEqual([]); // 重複 8 → 丟棄
    expect(q.dropped).toBe(3);
    expect(q.depth).toBe(1);

    // 7 補上：吐出 7、8（應為先到的 tag(8)，非 dup-8）。
    expect(q.push(7, tag(7))).toEqual([tag(7), tag(8)]);
    expect(q.depth).toBe(0);
  });

  // ④ 缺口超過 maxDepth：強制跳過、不卡死，被跳過數計入 dropped。
  it("缺口超過 maxDepth 時強制跳過釋放、不卡死", () => {
    const q = new AudioReorderingQueue<string>({ maxDepth: 3 });

    // 首包 seq=0 釋放，nextSeq=1。
    expect(q.push(0, tag(0))).toEqual([tag(0)]);

    // seq=1 一直不來，後面 5..8 連續到：每個都在等 1，緩衝逐漸變深。
    expect(q.push(5, tag(5))).toEqual([]); // depth 1
    expect(q.push(6, tag(6))).toEqual([]); // depth 2
    expect(q.push(7, tag(7))).toEqual([]); // depth 3（=maxDepth，尚未超過）
    expect(q.depth).toBe(3);
    expect(q.dropped).toBe(0);

    // 第 8 個到 → depth 變 4 > maxDepth 3，強制把最小序號 5 當 nextSeq 釋放。
    // 跳過 seq 1..4（4 個缺口）計入 dropped，接著連續釋放 5,6,7,8。
    const released = q.push(8, tag(8));
    expect(released).toEqual([tag(5), tag(6), tag(7), tag(8)]);
    expect(q.depth).toBe(0);
    expect(q.dropped).toBe(4); // 跳過的 1,2,3,4

    // 之後串流正常推進：9 立即釋放，不再卡住。
    expect(q.push(9, tag(9))).toEqual([tag(9)]);
  });

  // ⑤ flush 吐出剩餘並推進基準；reset 全歸零。
  it("flush 吐出剩餘緩衝、reset 歸零", () => {
    const q = new AudioReorderingQueue<string>();

    expect(q.push(100, tag(100))).toEqual([tag(100)]); // nextSeq=101
    // 缺 101，後面 102、104 緩衝（亂序）。
    expect(q.push(102, tag(102))).toEqual([]);
    expect(q.push(104, tag(104))).toEqual([]);
    expect(q.depth).toBe(2);

    // flush：依序號由小到大吐出剩餘（缺口正常略過、不計 dropped）。
    expect(q.flush()).toEqual([tag(102), tag(104)]);
    expect(q.depth).toBe(0);

    // flush 後基準推進到最後序號之後（104+1=105）：再 push 舊的 103 視為遲到丟棄。
    expect(q.push(103, tag(103))).toEqual([]);
    expect(q.dropped).toBe(1);

    // reset：全部歸零，回到「尚未收到首包」狀態。
    q.reset();
    expect(q.depth).toBe(0);
    expect(q.dropped).toBe(0);
    // reset 後第一個 push 重新建立基準（任意序號皆可當首包）。
    expect(q.push(50, tag(50))).toEqual([tag(50)]);
  });

  // 額外：非有限序號（NaN/Infinity）防呆 → 丟棄、不污染狀態。
  it("非法序號被丟棄、不影響後續正常封包", () => {
    const q = new AudioReorderingQueue<string>();
    expect(q.push(Number.NaN, "bad")).toEqual([]);
    expect(q.push(Number.POSITIVE_INFINITY, "bad")).toEqual([]);
    expect(q.dropped).toBe(2);

    // 正常封包仍可建立基準並運作。
    expect(q.push(1, tag(1))).toEqual([tag(1)]);
  });
});
