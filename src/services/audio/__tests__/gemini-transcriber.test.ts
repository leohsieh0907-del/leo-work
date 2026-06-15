// ════════════════════════════════════════════════════════════════════
//  GeminiStreamingTranscriber 單元測試（vitest，注入假 Live 後端，不連網）
//
//  驗證它把 router 餵的 PCM 串給 Gemini Live、累積回吐文字、flush 成 segment，
//  以及 lazy 開 session / reset 重開 / CJK 字間空格收尾 / 無金鑰 no-op。
// ════════════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";

import {
  GeminiStreamingTranscriber,
  type LiveTranscriptBackend,
} from "../GeminiStreamingTranscriber";
import type { AudioChunk } from "../types";

/** 假 Live 後端：記錄 start/stop/pushAudio，並可手動模擬 Gemini 回吐文字。 */
class FakeLiveBackend implements LiveTranscriptBackend {
  startCount = 0;
  stopCount = 0;
  pushed: string[] = [];
  private onText: ((t: string) => void) | null = null;

  start(onText: (t: string) => void, _onError: (m: string) => void): void {
    this.startCount++;
    this.onText = onText;
  }
  pushAudio(pcmBase64: string): void {
    this.pushed.push(pcmBase64);
  }
  stop(): void {
    this.stopCount++;
    this.onText = null;
  }
  /** 測試操控：模擬 Gemini Live 回吐一段轉寫文字。 */
  emit(text: string): void {
    this.onText?.(text);
  }
}

/** 產生 n 個樣本的方波塊（內容不影響邏輯，只要非空）。 */
function chunk(seq: number, n = 1600, amp = 0.3): AudioChunk {
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) samples[i] = i % 2 === 0 ? amp : -amp;
  return { seq, timestampMs: seq * 100, samples, source: "phone" };
}

describe("GeminiStreamingTranscriber", () => {
  it("首次 push 才 lazy 開 Live session，並把 PCM 轉 base64 餵後端", () => {
    const backend = new FakeLiveBackend();
    const t = new GeminiStreamingTranscriber({ backend });

    expect(backend.startCount).toBe(0);
    t.push(chunk(0));
    expect(backend.startCount).toBe(1);
    expect(backend.pushed.length).toBe(1);
    expect(backend.pushed[0].length).toBeGreaterThan(0); // base64 非空

    t.push(chunk(1));
    expect(backend.startCount).toBe(1); // 不重開 session
    expect(backend.pushed.length).toBe(2);
  });

  it("flush 把累積文字當一段 segment 吐出、時間軸用已餵樣本推算", async () => {
    const backend = new FakeLiveBackend();
    const t = new GeminiStreamingTranscriber({ backend });

    expect(await t.flush()).toEqual([]); // 還沒文字

    t.push(chunk(0, 16000)); // 餵 1 秒（16000 樣本 @16kHz）
    backend.emit("你好");
    backend.emit("世界");

    const segs = await t.flush();
    expect(segs).toHaveLength(1);
    expect(segs[0].text).toBe("你好世界");
    expect(segs[0].start).toBe(0);
    expect(segs[0].end).toBeCloseTo(1, 3);

    expect(await t.flush()).toEqual([]); // flush 後清空
  });

  it("連續兩段 flush 的時間軸接續（start = 上次 end）", async () => {
    const backend = new FakeLiveBackend();
    const t = new GeminiStreamingTranscriber({ backend });

    t.push(chunk(0, 16000)); // 累積到 1 秒
    backend.emit("第一段");
    const a = await t.flush();
    expect(a[0].end).toBeCloseTo(1, 3);

    t.push(chunk(1, 16000)); // 再累積到 2 秒
    backend.emit("第二段");
    const b = await t.flush();
    expect(b[0].start).toBeCloseTo(1, 3);
    expect(b[0].end).toBeCloseTo(2, 3);
  });

  it("收掉 CJK 字間空格（STT 粗稿常見）", async () => {
    const backend = new FakeLiveBackend();
    const t = new GeminiStreamingTranscriber({ backend });

    t.push(chunk(0));
    backend.emit("今 天 開 會");
    const segs = await t.flush();
    expect(segs[0].text).toBe("今天開會");
  });

  it("reset 關閉 session 並清空累積；之後再 push 會重開", async () => {
    const backend = new FakeLiveBackend();
    const t = new GeminiStreamingTranscriber({ backend });

    t.push(chunk(0));
    backend.emit("殘留");
    t.reset();

    expect(backend.stopCount).toBe(1);
    expect(await t.flush()).toEqual([]); // 累積已被清

    t.push(chunk(1));
    expect(backend.startCount).toBe(2); // 重開 session
  });

  it("沒有 apiKey 也沒注入後端 → enabled=false、push/flush 皆 no-op", async () => {
    const t = new GeminiStreamingTranscriber({});
    expect(t.enabled).toBe(false);
    t.push(chunk(0));
    expect(await t.flush()).toEqual([]);
  });

  it("有金鑰 → enabled=true、windowSec 預設 2", () => {
    const t = new GeminiStreamingTranscriber({ backend: new FakeLiveBackend() });
    expect(t.enabled).toBe(true);
    expect(t.windowSec).toBe(2);
  });
});
