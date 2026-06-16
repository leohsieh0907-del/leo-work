// ════════════════════════════════════════════════════════════════════
//  SystemAudioCapture — 電腦系統收音（Windows / DirectShow）
//
//  目標：同時抓「麥克風」與「系統 loopback（立體聲混音 / 虛擬音效卡）」兩軌，
//  用 FFmpeg 的 amix 混成單軌，輸出 16kHz / mono / s16le 的原始 PCM，再切成
//  固定大小的 AudioChunk（Float32 -1..1）丟給上層管線。
//
//  為什麼要兩軌混音：
//    只錄麥克風 → 只聽得到「自己這端」；只錄 loopback → 只聽得到「對方」。
//    線上會議要兩邊都留存，必須把兩軌一起收進來。
//
//  退化策略（務必，避免「只有單邊聲音」這種沉默的失敗）：
//    1. 有麥 + 有 loopback → 雙軌 amix。
//    2. 有麥 + 無 loopback → 退化成只錄麥克風（單軌），並提示使用者。
//    3. 連麥都沒有        → 拋 AppError（IO_ERROR），無法收音。
//
//  Windows dshow 裝置名稱常含中文與空白（如「立體聲混音 (Realtek)」），
//  輸入以 `-i audio=<裝置名>` 形式帶入。我們用 spawn 的「陣列參數」傳遞，
//  argv 不經過 shell，故名稱即使含空白/中文/括號也不需另加引號。
// ════════════════════════════════════════════════════════════════════

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

// ffmpeg-static 無型別宣告（同 AudioRepair.ts 慣例）；執行期匯出 ffmpeg 執行檔絕對路徑，找不到為 null。
// 本模組為了即時把 stdout 的 s16le 流切成 chunk，直接 spawn 此 binary（不透過 fluent-ffmpeg）。
// @ts-ignore — ffmpeg-static 無型別宣告
import ffmpegStatic from "ffmpeg-static";

import { AppError, ErrorCode } from "../../shared/types";
import type { AudioChunk, AudioDeviceList, CaptureSource } from "./types";
import { TARGET_SAMPLE_RATE } from "./types";

/** loopback / 立體聲混音裝置的名稱特徵（不分大小寫比對）。 */
const LOOPBACK_NAME_HINTS = [
  "立體聲混音",
  "stereo mix",
  "cable output",
  "virtual-audio",
  "voicemeeter",
  "what u hear",
];

/** 每塊（chunk）固定樣本數：16kHz 下 1600 samples ≈ 100ms。 */
const FRAME_SAMPLES = 1600;
/** 一個 s16le 樣本佔 2 bytes。 */
const BYTES_PER_SAMPLE = 2;
/** 一塊對應的 byte 數。 */
const FRAME_BYTES = FRAME_SAMPLES * BYTES_PER_SAMPLE;

export interface SystemCaptureOptions {
  /** 指定麥克風裝置名稱；未給則自動取第一個非 loopback 輸入。 */
  micDevice?: string;
  /** 指定 loopback 裝置名稱；未給則自動取第一個 loopbackCandidate。 */
  loopbackDevice?: string;
  /** 取樣率；預設 16000（對接 Whisper）。 */
  sampleRate?: number;
}

export class SystemAudioCapture implements CaptureSource {
  private readonly micDevice?: string;
  private readonly loopbackDevice?: string;
  private readonly sampleRate: number;

  /** 目前的 ffmpeg 子行程；未錄音時為 null。 */
  private proc: ChildProcessWithoutNullStreams | null = null;
  /** s16le 解幀用的殘量緩衝（不足一個 sample 的奇數 byte 會留在這裡）。 */
  private residual: Buffer = Buffer.alloc(0);
  /** 遞增序號（同一 session）。 */
  private seq = 0;
  /** 收集 ffmpeg stderr，供診斷。 */
  private stderrBuf = "";
  /** 是否已主動 stop（避免 stop 觸發的 error 被誤報給上層）。 */
  private stopping = false;

  constructor(opts: SystemCaptureOptions = {}) {
    this.micDevice = opts.micDevice;
    this.loopbackDevice = opts.loopbackDevice;
    this.sampleRate = opts.sampleRate ?? TARGET_SAMPLE_RATE;
  }

  /**
   * 列舉所有 DirectShow 音訊輸入裝置。
   * 用 `ffmpeg -list_devices true -f dshow -i dummy`，裝置清單印在 stderr。
   * 解析失敗（ffmpeg 不存在、輸出格式非預期）一律回空清單，不 throw。
   */
  static async listDevices(): Promise<AudioDeviceList> {
    const bin = resolveFfmpegPath();
    if (!bin) return { inputs: [], loopbackCandidates: [] };

    const stderr = await new Promise<string>((resolve) => {
      let buf = "";
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve(buf);
      };
      try {
        // 注意：-list_devices 會讓 ffmpeg 以「錯誤」退出（找不到 dummy 輸入），
        // 屬正常現象；裝置清單已印在 stderr，故不論 exit code 都解析 stderr。
        const p = spawn(bin, ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"]);
        p.stderr.on("data", (d: Buffer) => {
          buf += d.toString("utf8");
        });
        p.on("error", done); // spawn 失敗（binary 壞掉等）→ 回目前 buf（通常空）
        p.on("close", done);
      } catch {
        done();
      }
    });

    return parseDshowDevices(stderr);
  }

  /**
   * 開始收音：依可用裝置決定雙軌混音或單軌降級，啟動 ffmpeg 並把
   * stdout 的 s16le 流切成 AudioChunk 餵給 onChunk。
   */
  async start(
    onChunk: (chunk: AudioChunk) => void,
    onError: (err: Error) => void,
  ): Promise<void> {
    // 已在錄音：先停掉舊的，確保單一子行程
    if (this.proc) {
      await this.stop();
    }

    const bin = resolveFfmpegPath();
    if (!bin) {
      throw new AppError(ErrorCode.AUDIO_UNREPAIRABLE, "找不到 FFmpeg");
    }

    // ─── 解析要用哪些裝置 ───
    const devices = await SystemAudioCapture.listDevices();
    const mic = this.pickMic(devices);
    if (!mic) {
      throw new AppError(ErrorCode.IO_ERROR, "找不到任何音訊輸入裝置");
    }
    const loopback = this.pickLoopback(devices);

    if (!loopback) {
      // 退化：只錄麥克風，並提示（不可整個失敗）
      const msg = "未偵測到系統 loopback，僅錄麥克風";
      console.warn(`[SystemAudioCapture] ${msg}`);
      try {
        onError(new AppError(ErrorCode.IO_ERROR, msg));
      } catch {
        // onError 自身丟錯不該影響收音啟動
      }
    }

    const args = this.buildFfmpegArgs(mic, loopback);

    // ─── 啟動 ffmpeg ───
    this.stopping = false;
    this.residual = Buffer.alloc(0);
    this.seq = 0;
    this.stderrBuf = "";

    let proc: ChildProcessWithoutNullStreams;
    try {
      proc = spawn(bin, args);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      onError(new AppError(ErrorCode.IO_ERROR, `啟動 FFmpeg 失敗：${e.message}`));
      return;
    }
    this.proc = proc;

    proc.stdout.on("data", (data: Buffer) => {
      try {
        this.handlePcm(data, onChunk);
      } catch (err) {
        onError(err instanceof Error ? err : new Error(String(err)));
      }
    });

    proc.stderr.on("data", (data: Buffer) => {
      // 累積診斷訊息（FFmpeg 把進度與錯誤都印在 stderr），上限避免無限增長
      this.stderrBuf += data.toString("utf8");
      if (this.stderrBuf.length > 64_000) {
        this.stderrBuf = this.stderrBuf.slice(-32_000);
      }
    });

    proc.on("error", (err: Error) => {
      if (this.stopping) return; // 主動停止造成的錯誤忽略
      onError(new AppError(ErrorCode.IO_ERROR, `FFmpeg 執行錯誤：${err.message}`));
    });

    proc.on("close", (code) => {
      const wasStopping = this.stopping;
      if (this.proc === proc) this.proc = null;
      if (wasStopping) return; // 我們自己 kill 的，正常
      // 非預期結束（非 0 退出碼）→ 帶 stderr 診斷回報
      if (code !== 0 && code !== null) {
        const diag = this.stderrBuf.trim().split("\n").slice(-8).join("\n");
        onError(
          new AppError(ErrorCode.IO_ERROR, `FFmpeg 非預期結束（code=${code}）`, diag),
        );
      }
    });
  }

  /**
   * 停止收音：kill ffmpeg 子行程並清空緩衝。
   * 可重複呼叫不報錯（無進行中行程時直接返回）。
   */
  async stop(): Promise<void> {
    this.stopping = true;
    const proc = this.proc;
    this.proc = null;
    this.residual = Buffer.alloc(0);

    if (!proc) return;

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      proc.once("close", finish);
      proc.once("exit", finish);
      try {
        proc.kill("SIGTERM");
      } catch {
        finish();
        return;
      }
      // 保險：SIGTERM 後若沒在時限內收掉，強制 kill 並放行
      const timer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // 已結束
        }
        finish();
      }, 2_000);
    });
  }

  // ─────────────── 私有：裝置挑選 ───────────────

  /** 麥克風：優先用指定值；否則取第一個「非 loopback」的輸入裝置。 */
  private pickMic(devices: AudioDeviceList): string | undefined {
    if (this.micDevice) return this.micDevice;
    const loopbackSet = new Set(devices.loopbackCandidates);
    return devices.inputs.find((name) => !loopbackSet.has(name));
  }

  /**
   * loopback 來源挑選：
   *  1. 指定值（建構時帶入，如 .env SYSTEM_LOOPBACK_DEVICE）優先——支援完整名稱或片段比對。
   *  2. 否則依偏好順序挑：VoiceMeeter 的 B1 錄音匯流排 > VB-CABLE > 任一 VoiceMeeter
   *     > 立體聲混音 > 其他。如此在「同時裝了 VoiceMeeter/CABLE 又留著 Stereo Mix」時，
   *     才會固定抓到正確的虛擬錄音匯流排，而非 enumeration 順序隨機的第一個（戴藍牙錄音必備）。
   *  3. 都沒有則 undefined（退化成只錄麥克風）。
   */
  private pickLoopback(devices: AudioDeviceList): string | undefined {
    const cands = devices.loopbackCandidates;
    if (this.loopbackDevice) {
      const want = this.loopbackDevice.toLowerCase();
      const hit = cands.find((n) => n === this.loopbackDevice || n.toLowerCase().includes(want));
      return hit ?? this.loopbackDevice;
    }
    if (cands.length === 0) return undefined;
    const byKeyword = (kw: string) => cands.find((n) => n.toLowerCase().includes(kw));
    return (
      byKeyword("voicemeeter out b1") ??
      byKeyword("cable output") ??
      byKeyword("voicemeeter") ??
      byKeyword("stereo mix") ??
      cands[0]
    );
  }

  // ─────────────── 私有：FFmpeg 參數組裝 ───────────────

  /**
   * 組 ffmpeg 參數。雙軌時用 amix 混音；單軌時直接重採樣。
   * 共同輸出：-ac 1 -ar <sampleRate> -f s16le pipe:1。
   */
  private buildFfmpegArgs(mic: string, loopback: string | undefined): string[] {
    const args: string[] = ["-hide_banner", "-loglevel", "warning"];

    // 麥克風輸入
    args.push("-f", "dshow", "-i", `audio=${mic}`);

    if (loopback) {
      // loopback 輸入
      args.push("-f", "dshow", "-i", `audio=${loopback}`);
      // 兩軌混音：normalize=0 保持原始音量比例（避免被自動衰減成一半）
      args.push(
        "-filter_complex",
        "[0:a][1:a]amix=inputs=2:duration=longest:normalize=0[mix]",
        "-map",
        "[mix]",
      );
    }
    // 單軌（只有麥克風）時不加 filter，直接走預設 stream。

    // 統一輸出：單聲道、目標取樣率、s16le 原始 PCM 到 stdout
    args.push(
      "-ac",
      "1",
      "-ar",
      String(this.sampleRate),
      "-f",
      "s16le",
      "pipe:1",
    );

    return args;
  }

  // ─────────────── 私有：PCM 解幀 ───────────────

  /**
   * 把新到的 s16le bytes 接到殘量緩衝，按 FRAME_BYTES 切出整塊，
   * 轉成 Float32（/32768）後組 AudioChunk 丟出。處理「半個 sample」的
   * byte 邊界：不足一個 sample 的尾巴留在 residual，等下一批補齊。
   */
  private handlePcm(data: Buffer, onChunk: (chunk: AudioChunk) => void): void {
    const merged =
      this.residual.length === 0 ? data : Buffer.concat([this.residual, data]);

    let offset = 0;
    // 一次切出一個固定大小的 frame
    while (merged.length - offset >= FRAME_BYTES) {
      const slice = merged.subarray(offset, offset + FRAME_BYTES);
      offset += FRAME_BYTES;

      const samples = new Float32Array(FRAME_SAMPLES);
      for (let i = 0; i < FRAME_SAMPLES; i++) {
        // int16 → Float32：/32768 讓值域落在 [-1, 1)（負滿刻度 -32768 → -1）
        samples[i] = slice.readInt16LE(i * BYTES_PER_SAMPLE) / 32768;
      }

      const chunk: AudioChunk = {
        seq: this.seq++,
        timestampMs: Date.now(),
        samples,
        source: "computer",
      };
      onChunk(chunk);
    }

    // 保留剩餘（< FRAME_BYTES，含可能的奇數半個 sample）等下批
    this.residual = offset === 0 ? merged : Buffer.from(merged.subarray(offset));
  }
}

// ─────────────── 模組層級工具 ───────────────

/** 取得 ffmpeg-static 提供的執行檔路徑（找不到為 null）。 */
function resolveFfmpegPath(): string | null {
  // 與 AudioRepair.ts 一致：ffmpegStatic 執行期型別為 string | null
  return (ffmpegStatic as unknown as string | null) ?? null;
}

/**
 * 解析 `ffmpeg -list_devices` 的 stderr，取出音訊輸入裝置名稱。
 * 相容兩種 ffmpeg 輸出格式：
 *   舊版：先印「DirectShow audio devices」區段標題，下面才列 "名稱"。
 *   新版（目前 ffmpeg-static）：不印區段標題，改在每行尾標 (audio)/(video)，例如
 *     [dshow @ ...] "Microphone Array (...)" (audio)
 *     [dshow @ ...] "Stereo Mix (Realtek(R) Audio)" (audio)
 *   兩者皆忽略「Alternative name ...」裝置路徑行。
 */
export function parseDshowDevices(stderr: string): AudioDeviceList {
  if (!stderr) return { inputs: [], loopbackCandidates: [] };

  const inputs: string[] = [];
  const seen = new Set<string>();
  let inAudioSection = false; // 舊版 ffmpeg 靠區段標題；新版改用行尾 (audio)/(video) 標籤

  for (const rawLine of stderr.split(/\r?\n/)) {
    const line = rawLine.trim();

    // 舊版區段標題（新版不印，但印了就沿用）
    if (/DirectShow\s+audio\s+devices/i.test(line)) {
      inAudioSection = true;
      continue;
    }
    if (/DirectShow\s+video\s+devices/i.test(line)) {
      inAudioSection = false;
      continue;
    }

    // 忽略 "Alternative name ..." 那種裝置路徑行
    if (/alternative\s+name/i.test(line)) continue;

    // 裝置名稱在雙引號內
    const match = line.match(/"([^"]+)"/);
    if (!match) continue;
    const name = match[1].trim();
    if (!name) continue;

    // 判斷音訊：新版行尾標 (audio)/(video) 以標籤為準；沒標才退回舊版區段判斷。
    const hasAudioTag = /\(audio\)\s*$/i.test(line);
    const hasVideoTag = /\(video\)\s*$/i.test(line);
    const isAudio = hasAudioTag || (!hasVideoTag && inAudioSection);
    if (!isAudio) continue;

    if (seen.has(name)) continue;
    seen.add(name);
    inputs.push(name);
  }

  const loopbackCandidates = inputs.filter((name) => isLoopbackName(name));
  return { inputs, loopbackCandidates };
}

/** 名稱是否符合 loopback / 立體聲混音 / 虛擬音效卡特徵。 */
function isLoopbackName(name: string): boolean {
  const lower = name.toLowerCase();
  return LOOPBACK_NAME_HINTS.some((hint) => lower.includes(hint.toLowerCase()));
}
