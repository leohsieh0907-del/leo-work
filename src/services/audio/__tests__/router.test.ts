// ════════════════════════════════════════════════════════════════════
//  AudioIngestionRouter 整合測試（vitest，用假源實跑）
//
//  以實作 AudioSource 的 FakeSource 驅動 router，驗證：
//    1) activate("webrtc") → state=WEBRTC_STREAMING、startStream 被呼叫、發 router 事件
//    2) webrtc 串流中 syncBluetooth() → bluetooth.setPriority("background")、
//       state 仍 WEBRTC_STREAMING、bluetooth.transferring=true（優先權核心）
//    3) activate("local") 後 activate("webrtc") → 先停 local（互斥）再起 webrtc
//    4) 前景源餵塊 → transcriber.push 被呼叫、發 vu 事件
//    5) 並發 activate（不 await 交錯）→ AsyncMutex 保最終狀態一致
//    6) deactivate → 停前景源、回 DISCONNECTED（或藍牙背景續跑 → BLUETOOTH_SYNCING）
//
//  全部不需真實裝置或網路，可直接 `vitest run`。
// ════════════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";

import { AudioIngestionRouter, type AudioRouterDeps } from "../AudioIngestionRouter";
import { Agc } from "../Agc";
import { AudioSourceState } from "../types";
import type {
  AudioChunk,
  AudioEvent,
  AudioSource,
  AudioSourceId,
  SourcePriority,
} from "../types";
import type { TranscriptSegment } from "../../../shared/types";

// ─────────────── 測試輔助 ───────────────

/** 產生 ±amp 交替方波（rms === peak === amp），預設手機來源標記（不影響 router 邏輯）。 */
function squareChunk(seq: number, amp = 0.2, n = 256): AudioChunk {
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) samples[i] = i % 2 === 0 ? amp : -amp;
  return { seq, timestampMs: seq * 16, samples, source: "phone" };
}

/**
 * 假音訊來源：實作 AudioSource，可手動觸發 onDataReceived/onError，
 * 並記錄 startStream/stopStream/setPriority 的呼叫次數與順序。
 */
class FakeSource implements AudioSource {
  readonly id: AudioSourceId;
  private dataCb: ((chunk: AudioChunk) => void) | null = null;
  private errCb: ((err: Error) => void) | null = null;

  startCalls = 0;
  stopCalls = 0;
  priorities: SourcePriority[] = [];
  private _streaming = false;

  /** start 期間若設此值，startStream 會 reject（測試起串流失敗的回滾）。 */
  failOnStart: Error | null = null;
  /** 全域呼叫序（跨多個源共享），用來驗證「先停 A 再起 B」的順序。 */
  static order: string[] = [];

  constructor(id: AudioSourceId) {
    this.id = id;
  }

  async startStream(): Promise<void> {
    this.startCalls++;
    FakeSource.order.push(`${this.id}:start`);
    if (this.failOnStart) {
      const e = this.failOnStart;
      throw e;
    }
    this._streaming = true;
  }

  async stopStream(): Promise<void> {
    this.stopCalls++;
    FakeSource.order.push(`${this.id}:stop`);
    this._streaming = false;
  }

  onDataReceived(callback: (chunk: AudioChunk) => void): void {
    this.dataCb = callback;
  }

  onError(callback: (err: Error) => void): void {
    this.errCb = callback;
  }

  setPriority(priority: SourcePriority): void {
    this.priorities.push(priority);
  }

  get streaming(): boolean {
    return this._streaming;
  }

  // ── 測試操控 ──
  emitData(chunk: AudioChunk): void {
    this.dataCb?.(chunk);
  }
  emitError(err: Error): void {
    this.errCb?.(err);
  }
  get lastPriority(): SourcePriority | undefined {
    return this.priorities[this.priorities.length - 1];
  }
}

/** 假轉寫器：記錄 push/reset/flush，flush 回固定片段。對應 StreamingTranscriber 介面。 */
class FakeTranscriber {
  enabled = true;
  windowSec = 2;
  pushed: AudioChunk[] = [];
  resetCount = 0;
  flushCount = 0;
  flushSegments: TranscriptSegment[] = [];

  push(chunk: AudioChunk): void {
    this.pushed.push(chunk);
  }
  async flush(): Promise<TranscriptSegment[]> {
    this.flushCount++;
    const out = this.flushSegments;
    this.flushSegments = [];
    return out;
  }
  reset(): void {
    this.resetCount++;
  }
}

/** 一次組好 router + 假源 + 事件收集器，方便各測試取用。opts.autoSegmentSeconds 可調自動分段門檻。 */
function makeHarness(opts?: { autoSegmentSeconds?: number }) {
  FakeSource.order = [];
  const bluetooth = new FakeSource("bluetooth");
  const webrtc = new FakeSource("webrtc");
  const local = new FakeSource("local");
  const mic = new FakeSource("mic");
  const transcriber = new FakeTranscriber();
  const events: AudioEvent[] = [];

  const deps: AudioRouterDeps = {
    bluetooth,
    webrtc,
    local,
    mic,
    agc: new Agc(),
    transcriber: transcriber as unknown as never,
    onEvent: (e) => events.push(e),
    autoSegmentSeconds: opts?.autoSegmentSeconds,
  };
  const router = new AudioIngestionRouter(deps);
  return { router, bluetooth, webrtc, local, mic, transcriber, events };
}

// ════════════════ 1) activate("webrtc") ════════════════

describe("activate(webrtc)", () => {
  it("state=WEBRTC_STREAMING、webrtc.startStream 被呼叫、發 router 事件", async () => {
    const { router, webrtc, events } = makeHarness();

    await router.activate("webrtc");

    expect(webrtc.startCalls).toBe(1);
    const st = router.status();
    expect(st.state).toBe(AudioSourceState.WEBRTC_STREAMING);
    expect(st.activeSourceId).toBe("webrtc");

    // 有發出至少一個 router 事件，且其 status 與 router.status() 一致
    const routerEvents = events.filter((e) => e.type === "router");
    expect(routerEvents.length).toBeGreaterThan(0);
    const last = routerEvents[routerEvents.length - 1];
    if (last.type === "router") {
      expect(last.status.state).toBe(AudioSourceState.WEBRTC_STREAMING);
    }
  });

  it("activate(local) → state=LOCAL_RECORDING", async () => {
    const { router, local } = makeHarness();
    await router.activate("local");
    expect(local.startCalls).toBe(1);
    expect(router.status().state).toBe(AudioSourceState.LOCAL_RECORDING);
    expect(router.status().activeSourceId).toBe("local");
  });

  it("activate(mic) → state=MIC_RECORDING", async () => {
    const { router, mic } = makeHarness();
    await router.activate("mic");
    expect(mic.startCalls).toBe(1);
    expect(router.status().state).toBe(AudioSourceState.MIC_RECORDING);
    expect(router.status().activeSourceId).toBe("mic");
  });

  it("mic 與 local 互斥：activate(mic) 後 activate(local) 先停 mic 再起 local", async () => {
    const { router, mic, local } = makeHarness();
    await router.activate("mic");
    await router.activate("local");
    expect(mic.stopCalls).toBe(1);
    expect(local.startCalls).toBe(1);
    expect(router.status().state).toBe(AudioSourceState.LOCAL_RECORDING);
    const stopIdx = FakeSource.order.indexOf("mic:stop");
    const startIdx = FakeSource.order.indexOf("local:start");
    expect(stopIdx).toBeGreaterThanOrEqual(0);
    expect(startIdx).toBeGreaterThan(stopIdx);
  });

  it("起串流失敗 → 回滾前景指標，狀態不留半啟用髒值、發 error 事件", async () => {
    const { router, webrtc, events } = makeHarness();
    webrtc.failOnStart = new Error("PeerConnection 建立失敗");

    await router.activate("webrtc");

    expect(router.status().state).toBe(AudioSourceState.DISCONNECTED);
    expect(router.status().activeSourceId).toBe(null);
    expect(events.some((e) => e.type === "error")).toBe(true);
  });
});

// ════════════════ 2) 優先權核心：webrtc 串流中 syncBluetooth ════════════════

describe("優先權管理（核心）", () => {
  it("webrtc 串流中 syncBluetooth → bluetooth.setPriority(background)、state 仍 WEBRTC_STREAMING、transferring=true", async () => {
    const { router, webrtc, bluetooth } = makeHarness();

    await router.activate("webrtc");
    await router.syncBluetooth();

    // 藍牙被降為背景低優先（保護即時轉寫不掉幀）
    expect(bluetooth.priorities).toContain("background");
    expect(bluetooth.lastPriority).toBe("background");
    expect(bluetooth.startCalls).toBe(1);

    // 前景即時態維持不變
    const st = router.status();
    expect(st.state).toBe(AudioSourceState.WEBRTC_STREAMING);
    expect(st.activeSourceId).toBe("webrtc");

    // 藍牙正在傳、優先級為 background
    expect(st.bluetooth.transferring).toBe(true);
    expect(st.bluetooth.priority).toBe("background");
    // webrtc 不應被降優先
    expect(webrtc.priorities).not.toContain("background");
  });

  it("activate(bluetooth) 與 syncBluetooth 等價：前景在跑時皆設 background", async () => {
    const { router, bluetooth } = makeHarness();
    await router.activate("local");
    await router.activate("bluetooth");
    expect(bluetooth.lastPriority).toBe("background");
    expect(router.status().state).toBe(AudioSourceState.LOCAL_RECORDING);
    expect(router.status().bluetooth.transferring).toBe(true);
  });

  it("無前景時藍牙為前景同步 → BLUETOOTH_SYNCING、setPriority(foreground)", async () => {
    const { router, bluetooth } = makeHarness();
    await router.syncBluetooth();
    expect(bluetooth.lastPriority).toBe("foreground");
    expect(bluetooth.startCalls).toBe(1);
    const st = router.status();
    expect(st.state).toBe(AudioSourceState.BLUETOOTH_SYNCING);
    expect(st.bluetooth.transferring).toBe(true);
    expect(st.bluetooth.priority).toBe("foreground");
    expect(st.activeSourceId).toBe(null);
  });

  it("藍牙背景中再啟前景 webrtc → 藍牙被壓回 background", async () => {
    const { router, bluetooth } = makeHarness();
    // 先讓藍牙以前景同步起來
    await router.syncBluetooth();
    expect(bluetooth.lastPriority).toBe("foreground");
    // 再啟前景即時源：藍牙應被壓成 background，狀態切到 WEBRTC_STREAMING
    await router.activate("webrtc");
    expect(bluetooth.lastPriority).toBe("background");
    expect(router.status().state).toBe(AudioSourceState.WEBRTC_STREAMING);
    expect(router.status().bluetooth.transferring).toBe(true);
  });
});

// ════════════════ 3) 互斥：local → webrtc 先停再起 ════════════════

describe("即時源互斥", () => {
  it("activate(local) 後 activate(webrtc) → 先停 local 再起 webrtc", async () => {
    const { router, local, webrtc } = makeHarness();

    await router.activate("local");
    expect(local.startCalls).toBe(1);

    await router.activate("webrtc");
    // local 被停、webrtc 被起
    expect(local.stopCalls).toBe(1);
    expect(webrtc.startCalls).toBe(1);
    expect(router.status().state).toBe(AudioSourceState.WEBRTC_STREAMING);

    // 順序：local:stop 必須在 webrtc:start 之前（互斥切換）
    const stopIdx = FakeSource.order.indexOf("local:stop");
    const startIdx = FakeSource.order.indexOf("webrtc:start");
    expect(stopIdx).toBeGreaterThanOrEqual(0);
    expect(startIdx).toBeGreaterThan(stopIdx);
  });

  it("重複 activate 同一前景源為冪等：不重覆 start/stop", async () => {
    const { router, webrtc } = makeHarness();
    await router.activate("webrtc");
    await router.activate("webrtc");
    expect(webrtc.startCalls).toBe(1);
    expect(webrtc.stopCalls).toBe(0);
    expect(router.status().state).toBe(AudioSourceState.WEBRTC_STREAMING);
  });
});

// ════════════════ 4) 音訊管線：餵塊 → push + vu 事件 ════════════════

describe("音訊管線", () => {
  it("前景源餵塊 → transcriber.push 被呼叫、發 vu 事件（source=前景 id）", async () => {
    const { router, webrtc, transcriber, events } = makeHarness();

    await router.activate("webrtc");
    events.length = 0; // 清掉 activate 的 router 事件

    webrtc.emitData(squareChunk(0, 0.3, 256));

    // 餵進轉寫器的是 AGC 處理後樣本（長度相同、保留 seq）
    expect(transcriber.pushed.length).toBe(1);
    expect(transcriber.pushed[0].samples.length).toBe(256);
    expect(transcriber.pushed[0].seq).toBe(0);

    // 發出 vu 事件，且 source 標為前景 id
    const vu = events.find((e) => e.type === "vu");
    expect(vu).toBeDefined();
    if (vu && vu.type === "vu") {
      expect(vu.source).toBe("webrtc");
      expect(vu.level.rms).toBeGreaterThan(0);
    }
  });

  it("webrtc 重複封包被 AudioSync 丟棄、不 push", async () => {
    const { router, webrtc, transcriber } = makeHarness();
    await router.activate("webrtc");
    webrtc.emitData(squareChunk(0, 0.3, 256));
    webrtc.emitData(squareChunk(0, 0.3, 256)); // 重送 → 丟棄
    expect(transcriber.pushed.length).toBe(1);
  });

  it("非前景源（藍牙背景）發塊不進即時管線", async () => {
    const { router, webrtc, bluetooth, transcriber } = makeHarness();
    await router.activate("webrtc");
    await router.syncBluetooth();
    transcriber.pushed.length = 0;

    // 藍牙（背景同步源）偶發發塊：應被忽略，不汙染即時轉寫
    bluetooth.emitData(squareChunk(0, 0.3, 256));
    expect(transcriber.pushed.length).toBe(0);

    // 前景 webrtc 發塊仍正常進管線
    webrtc.emitData(squareChunk(0, 0.3, 256));
    expect(transcriber.pushed.length).toBe(1);
  });

  it("source onError → 發 error 事件，不炸掉 router", async () => {
    const { router, webrtc, events } = makeHarness();
    await router.activate("webrtc");
    webrtc.emitError(new Error("WebRTC 通道中斷"));
    const err = events.find((e) => e.type === "error");
    expect(err).toBeDefined();
    if (err && err.type === "error") expect(err.message).toBe("WebRTC 通道中斷");
    // router 仍可正常運作
    expect(router.status().state).toBe(AudioSourceState.WEBRTC_STREAMING);
  });
});

// ════════════════ 5) AsyncMutex：並發 activate 不錯亂 ════════════════

describe("AsyncMutex 序列化", () => {
  it("並發呼叫多個 activate（不 await 交錯）→ 最終狀態一致、無雙寫", async () => {
    const { router, local, webrtc } = makeHarness();

    // 不 await，故意讓三個轉換交錯送進鎖；鎖保證它們序列化執行
    const p1 = router.activate("webrtc");
    const p2 = router.activate("local");
    const p3 = router.activate("webrtc");
    await Promise.all([p1, p2, p3]);

    // 最終態必為最後一個入鎖者（webrtc），且狀態自洽
    const st = router.status();
    expect(st.state).toBe(AudioSourceState.WEBRTC_STREAMING);
    expect(st.activeSourceId).toBe("webrtc");

    // 互斥不變式：任一時刻僅一個前景源在跑 → 最終 webrtc 在跑、local 已停
    expect(webrtc.streaming).toBe(true);
    expect(local.streaming).toBe(false);

    // start 次數合理（每次入鎖最多起一次目標源；不會因競態爆量）
    expect(webrtc.startCalls).toBeGreaterThanOrEqual(1);
  });

  it("並發 activate + syncBluetooth 交錯 → 前景與藍牙狀態自洽", async () => {
    const { router, bluetooth } = makeHarness();
    await Promise.all([
      router.activate("webrtc"),
      router.syncBluetooth(),
      router.activate("local"),
    ]);
    const st = router.status();
    // 最終前景為某即時源，藍牙在傳且因有前景而為 background
    expect([AudioSourceState.WEBRTC_STREAMING, AudioSourceState.LOCAL_RECORDING]).toContain(st.state);
    expect(st.bluetooth.transferring).toBe(true);
    expect(bluetooth.lastPriority).toBe("background");
  });
});

// ════════════════ 6) deactivate ════════════════

describe("deactivate", () => {
  it("停前景源、回 DISCONNECTED", async () => {
    const { router, webrtc } = makeHarness();
    await router.activate("webrtc");
    await router.deactivate();
    expect(webrtc.stopCalls).toBe(1);
    const st = router.status();
    expect(st.state).toBe(AudioSourceState.DISCONNECTED);
    expect(st.activeSourceId).toBe(null);
  });

  it("藍牙背景續跑時 deactivate → 回 BLUETOOTH_SYNCING、藍牙升回 foreground", async () => {
    const { router, webrtc, bluetooth } = makeHarness();
    await router.activate("webrtc");
    await router.syncBluetooth(); // 藍牙背景（background）
    expect(bluetooth.lastPriority).toBe("background");

    await router.deactivate(); // 停前景 webrtc

    expect(webrtc.stopCalls).toBe(1);
    const st = router.status();
    // 前景已停但藍牙還在傳 → BLUETOOTH_SYNCING，且藍牙升回 foreground（獨佔可全速）
    expect(st.state).toBe(AudioSourceState.BLUETOOTH_SYNCING);
    expect(st.bluetooth.transferring).toBe(true);
    expect(bluetooth.lastPriority).toBe("foreground");
  });

  it("deactivate 觸發收尾 flush，把殘留片段以 transcript 事件推出", async () => {
    const { router, transcriber, events } = makeHarness();
    transcriber.flushSegments = [{ start: 0, end: 1.2, text: "結尾句", speaker: "A" }];
    await router.activate("webrtc");
    events.length = 0;

    await router.deactivate();

    const tr = events.find((e) => e.type === "transcript");
    expect(tr).toBeDefined();
    if (tr && tr.type === "transcript") {
      expect(tr.segments).toEqual([{ start: 0, end: 1.2, text: "結尾句" }]); // speaker 被剝除
    }
  });

  it("deactivate 無前景時為 no-op（安全）", async () => {
    const { router, webrtc, local } = makeHarness();
    await router.deactivate();
    expect(webrtc.stopCalls).toBe(0);
    expect(local.stopCalls).toBe(0);
    expect(router.status().state).toBe(AudioSourceState.DISCONNECTED);
  });
});

// ════════════════ 7) 整檔精修錄音緩衝 ════════════════

/** 從 WAV Buffer 標頭讀 data 區的樣本數（dataSize / 2）。 */
function wavSampleCount(wav: Buffer): number {
  expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
  expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
  return wav.readUInt32LE(40) / 2; // Subchunk2Size / 2 bytes per sample
}

describe("整檔精修錄音緩衝", () => {
  it("前景收音累積 PCM → deactivate 後 hasRecording、peekRecordingWav 樣本數正確", async () => {
    const { router, local } = makeHarness();
    await router.activate("local"); // local 不過 AudioSync，便於精算樣本數

    local.emitData(squareChunk(0, 0.3, 256));
    local.emitData(squareChunk(1, 0.3, 256));
    expect(router.hasRecording()).toBe(true);

    await router.deactivate();
    const wav = router.peekRecordingWav();
    expect(wav).not.toBeNull();
    expect(wavSampleCount(wav as Buffer)).toBe(512); // 兩塊 256

    // peek 不清空（精修失敗可重試）
    expect(router.hasRecording()).toBe(true);
    expect(router.peekRecordingWav()).not.toBeNull();

    // clearRecording 才清空
    router.clearRecording();
    expect(router.hasRecording()).toBe(false);
    expect(router.peekRecordingWav()).toBeNull();
  });

  it("deactivate 後發 recording 事件（ready + 秒數）", async () => {
    const { router, local, events } = makeHarness();
    await router.activate("local");
    local.emitData(squareChunk(0, 0.3, 16_000)); // 1 秒 @16kHz
    events.length = 0;

    await router.deactivate();

    const rec = events.find((e) => e.type === "recording");
    expect(rec).toBeDefined();
    if (rec && rec.type === "recording") {
      expect(rec.ready).toBe(true);
      expect(rec.seconds).toBe(1);
      expect(rec.truncated).toBe(false);
    }
  });

  it("換源視為新 session：清掉上一段錄音", async () => {
    const { router, local, webrtc } = makeHarness();
    await router.activate("local");
    local.emitData(squareChunk(0, 0.3, 256));
    expect(router.hasRecording()).toBe(true);

    // 切到 webrtc：應重置錄音緩衝
    await router.activate("webrtc");
    expect(router.hasRecording()).toBe(false);

    // 確認新源能繼續累積（webrtc seq 從 0 起，AudioSync 接受）
    webrtc.emitData(squareChunk(0, 0.3, 256));
    expect(router.hasRecording()).toBe(true);
  });

  it("非前景源（藍牙背景）發塊不進精修錄音", async () => {
    const { router, bluetooth } = makeHarness();
    await router.activate("webrtc");
    await router.syncBluetooth();
    router.clearRecording(); // 清掉 activate 後可能的殘留

    bluetooth.emitData(squareChunk(0, 0.3, 256));
    expect(router.hasRecording()).toBe(false);
  });
});

// ════════════════ 自動分段（背景抽取）════════════════

describe("自動分段 auto-segment", () => {
  it("錄音達門檻 → onSegmentReady 觸發、drain 回 WAV + offset，緩衝清空後接續累加時間戳", async () => {
    // 門檻 0.5 秒＝8000 樣本（16kHz）；每次餵 8000 樣本剛好觸發一段。
    const { router, local } = makeHarness({ autoSegmentSeconds: 0.5 });
    const drained: { wav: Buffer; offsetSec: number }[] = [];
    router.onSegmentReady = () => {
      const seg = router.drainRecordingWav();
      if (seg) drained.push(seg);
    };
    await router.activate("local");

    // 第一段：8000 樣本 → 觸發 → drain（offset=0），緩衝清空。
    local.emitData(squareChunk(0, 0.3, 8000));
    expect(drained).toHaveLength(1);
    expect(drained[0].offsetSec).toBe(0);
    expect(drained[0].wav.length).toBe(44 + 8000 * 2); // WAV header + PCM16
    expect(router.hasRecording()).toBe(false); // 抽走後緩衝空

    // 第二段：再 8000 樣本 → 第二段 offset = 0.5s（接續，不從 0 重來）。
    local.emitData(squareChunk(1, 0.3, 8000));
    expect(drained).toHaveLength(2);
    expect(drained[1].offsetSec).toBeCloseTo(0.5, 5);
    // 累計位移 = 兩段共 1 秒（最終段精修會用它接續）。
    expect(router.recordingOffsetSeconds).toBeCloseTo(1.0, 5);
  });

  it("新 session（重新 activate）→ 累計位移歸零", async () => {
    const { router, local } = makeHarness({ autoSegmentSeconds: 0.5 });
    router.onSegmentReady = () => void router.drainRecordingWav();
    await router.activate("local");
    local.emitData(squareChunk(0, 0.3, 8000)); // 觸發一段 → drainedSeconds=0.5
    expect(router.recordingOffsetSeconds).toBeCloseTo(0.5, 5);

    await router.deactivate();
    await router.activate("local"); // 新 session
    expect(router.recordingOffsetSeconds).toBe(0); // 歸零，不延續上一場
  });

  it("未設 onSegmentReady → 不觸發分段（維持累積，走原本 60 分硬上限）", async () => {
    const { router, local } = makeHarness({ autoSegmentSeconds: 0.5 });
    await router.activate("local");
    local.emitData(squareChunk(0, 0.3, 8000)); // 達門檻但沒回呼
    expect(router.hasRecording()).toBe(true); // 沒被抽走，仍在緩衝
    expect(router.recordingOffsetSeconds).toBe(0);
  });
});
