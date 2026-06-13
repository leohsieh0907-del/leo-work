// ════════════════════════════════════════════════════════════════════
//  WebRtcSoftwareSource — WebRTC 即時串流收音源（實作 AudioSource）
//
//  手機端用瀏覽器 getUserMedia 取麥克風 → 經 WebRTC PeerConnection 把 Opus
//  音訊以 RTP 即時送上來。此來源在 Node sidecar 側用純 TS 的 werift 建立對等
//  端（recvonly audio），收 RTP 後走：
//
//    RTP(Opus) ─▶ AudioReorderingQueue 依 RTP 序號重組
//             ─▶ OpusDecoder 解成 Float32 PCM（48kHz）
//             ─▶ 降採樣 48kHz → 16kHz、混成單聲道
//             ─▶ 組 AudioChunk → onDataReceived（接上既有 AGC/VU/轉寫管線）
//
//  ── 誠實聲明 ──
//  完整端到端要真實瀏覽器 peer（提供 offer/ICE）才跑得起來：handleOffer 收手機
//  的 offer 回 answer、addIceCandidate 餵入對方候選、onIceCandidate 把本地候選
//  往外送（trickle ICE，由 server.ts 的 /webrtc/* 路由轉發給手機）。此檔的「重組
//  → 解碼 → 降採樣 → 組塊」邏輯與型別皆正確且 typecheck-clean，其中最關鍵、易錯
//  的重組佇列（AudioReorderingQueue）已有獨立單元測試覆蓋。werift / opus-decoder
//  以已安裝版本（werift 0.23 / opus-decoder 0.7）的實際型別為準；型別不確定處用
//  最小 `as` 斷言並就地註解，不使用 @ts-nocheck。
// ════════════════════════════════════════════════════════════════════

import {
  RTCPeerConnection,
  RTCRtpCodecParameters,
  RTCIceCandidate,
  type MediaStreamTrack,
  type RtpPacket,
} from "werift";
import { OpusDecoder } from "opus-decoder";

import type { AudioChunk, AudioSource, AudioSourceKind, SourcePriority, WebRtcStatus } from "./types";
import { TARGET_SAMPLE_RATE } from "./types";
import { AppError, ErrorCode } from "../../shared/types";
import { AudioReorderingQueue } from "./AudioReorderingQueue";

/** Opus 在 WebRTC 的標準時鐘率（解碼輸出取樣率）。 */
const OPUS_SAMPLE_RATE = 48_000;

/** background 優先級時，重組佇列加大深度以「批次」釋放，攤平處理頻率、降 CPU。 */
const FOREGROUND_MAX_DEPTH = 16;
const BACKGROUND_MAX_DEPTH = 48;

export interface WebRtcSourceOptions {
  /** 本地產生 ICE candidate 時的回呼（trickle ICE：往手機端送）。 */
  onIceCandidate?: (c: unknown) => void;
}

export class WebRtcSoftwareSource implements AudioSource {
  readonly id = "webrtc" as const;

  private readonly opts: WebRtcSourceOptions;

  /** werift 對等端；startStream 建立、stopStream 關閉。 */
  private pc: RTCPeerConnection | null = null;
  /** RTP 序號重組佇列（裝 Opus RTP 封包）。 */
  private queue = new AudioReorderingQueue<RtpPacket>({ maxDepth: FOREGROUND_MAX_DEPTH });
  /** Opus 解碼器：lazy 初始化並快取（await decoder.ready 後才可解）。 */
  private decoder: OpusDecoder | null = null;
  private decoderReady: Promise<void> | null = null;

  private dataCb: ((chunk: AudioChunk) => void) | null = null;
  private errorCb: ((err: Error) => void) | null = null;

  private isStreaming = false;
  private priority: SourcePriority = "foreground";

  /** 連線是否已建立（ICE/DTLS connected）。 */
  private connected = false;

  /** 輸出 AudioChunk 的單調遞增序號（與 RTP 序號脫鉤，對齊下游管線契約）。 */
  private outSeq = 0;
  /** 串流起始的牆鐘時間（毫秒），用來換算每塊的 timestampMs。 */
  private startedAtMs = 0;
  /** 已輸出的 16kHz 樣本累積數，用來推算每塊起始時間。 */
  private emittedSamples = 0;

  constructor(opts: WebRtcSourceOptions = {}) {
    this.opts = opts;
  }

  get streaming(): boolean {
    return this.isStreaming;
  }

  /**
   * 建立 PeerConnection（含一條 recvonly audio transceiver，預先宣告 Opus codec），
   * 訂閱本地 ICE candidate（trickle 往外送）與連線狀態。實際協商在 handleOffer。
   */
  async startStream(): Promise<void> {
    if (this.isStreaming) return; // 可重入：已在串流則 no-op

    try {
      // 預先宣告 Opus（48kHz/雙聲道協商，實際解碼後我們混成單聲道）。
      const pc = new RTCPeerConnection({
        codecs: {
          audio: [
            new RTCRtpCodecParameters({
              mimeType: "audio/opus",
              clockRate: OPUS_SAMPLE_RATE,
              channels: 2,
              payloadType: 96,
            }),
          ],
        },
      });

      // recvonly：我們只收手機麥克風，不回送音訊。
      pc.addTransceiver("audio", { direction: "recvonly" });

      // 本地 ICE candidate → 透過回呼往手機端送（trickle ICE）。
      // candidate 為 undefined 代表蒐集結束（end-of-candidates），一併往外通知。
      pc.onIceCandidate.subscribe((candidate) => {
        this.opts.onIceCandidate?.(candidate ? candidate.toJSON() : null);
      });

      // 連線狀態：connected/completed 視為已連上，其餘視為未連上。
      pc.connectionStateChange.subscribe((state) => {
        this.connected = state === "connected";
        if (state === "failed" || state === "closed" || state === "disconnected") {
          this.connected = false;
        }
      });

      // 收到遠端音訊 track：掛上 RTP 收音管線。
      pc.onTrack.subscribe((track) => {
        if (track.kind === "audio") {
          this.attachTrack(track);
        }
      });

      this.pc = pc;
      this.queue.reset();
      this.queue = new AudioReorderingQueue<RtpPacket>({ maxDepth: this.maxDepthForPriority() });
      this.outSeq = 0;
      this.emittedSamples = 0;
      this.startedAtMs = Date.now();
      this.isStreaming = true;
    } catch (err) {
      throw new AppError(
        ErrorCode.IO_ERROR,
        `WebRTC 串流啟動失敗：${(err as Error).message}`,
        err,
      );
    }
  }

  /**
   * 停止串流：關 PeerConnection、flush 佇列剩餘封包、釋放 Opus 解碼器。
   * 可重入安全（未在串流時為 no-op，但仍確保資源被釋放）。
   */
  async stopStream(): Promise<void> {
    this.isStreaming = false;
    this.connected = false;

    const pc = this.pc;
    this.pc = null;

    try {
      // 先把佇列殘留封包吐完並嘗試解碼，避免尾端音訊遺失。
      const leftover = this.queue.flush();
      for (const rtp of leftover) {
        await this.decodeAndEmit(rtp);
      }
    } catch {
      // 收尾解碼失敗不阻斷關閉流程（可能 decoder 已釋放）。
    } finally {
      this.queue.reset();
    }

    if (pc) {
      try {
        await pc.close();
      } catch (err) {
        // 關閉失敗只回報、不拋（stopStream 要保證可重入且不中斷上層收尾）。
        this.errorCb?.(
          new AppError(ErrorCode.IO_ERROR, `WebRTC 關閉失敗：${(err as Error).message}`, err),
        );
      }
    }

    // 釋放 Opus 解碼器（free 後下次 startStream 會 lazy 重建）。
    if (this.decoder) {
      try {
        this.decoder.free();
      } catch {
        // free 失敗忽略：解碼器是純記憶體資源，行程結束自然回收。
      }
      this.decoder = null;
      this.decoderReady = null;
    }
  }

  onDataReceived(callback: (chunk: AudioChunk) => void): void {
    this.dataCb = callback;
  }

  onError(callback: (err: Error) => void): void {
    this.errorCb = callback;
  }

  /**
   * 調整優先級。WebRTC 自己永遠是 foreground 即時源；此處主要支援被動降載情境
   * （理論上不會發生，但契約要求）：background 時加大重組佇列深度，讓封包以更大
   * 批次釋放、降低解碼/降採樣的呼叫頻率與每次喚醒成本，省 CPU。
   */
  setPriority(priority: SourcePriority): void {
    this.priority = priority;
    // 僅調整未來的釋放批次行為；不丟棄既有緩衝。
    // 重建佇列會清掉緩衝，故只在「深度設定確實改變」時重建，且把舊緩衝 flush 出去。
    const want = this.maxDepthForPriority();
    if (want !== this.currentQueueMaxDepth) {
      const carry = this.queue.flush();
      this.queue = new AudioReorderingQueue<RtpPacket>({ maxDepth: want });
      this.currentQueueMaxDepth = want;
      // 把 flush 出來的封包補回新佇列（保持序號連續、不丟音訊）。
      for (const rtp of carry) {
        const ready = this.queue.push(rtp.header.sequenceNumber, rtp);
        for (const pkt of ready) void this.decodeAndEmit(pkt);
      }
    }
  }

  /** 目前佇列的 maxDepth 設定（給 setPriority 判斷是否需重建）。 */
  private currentQueueMaxDepth = FOREGROUND_MAX_DEPTH;

  // ─────────────── WebRTC 信令（由 server.ts /webrtc/* 路由呼叫）───────────────

  /**
   * 收手機端 offer SDP，回 answer SDP（trickle ICE：candidate 之後另經
   * addIceCandidate / onIceCandidate 交換）。startStream 須先呼叫以建立 pc。
   */
  async handleOffer(sdp: string): Promise<string> {
    const pc = this.pc;
    if (!pc) {
      throw new AppError(ErrorCode.IO_ERROR, "WebRTC 尚未啟動（請先 startStream）");
    }
    try {
      await pc.setRemoteDescription({ type: "offer", sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      // setLocalDescription 後 localDescription 必有值；回傳協商完成的 answer SDP。
      const local = pc.localDescription;
      if (!local) {
        throw new Error("createAnswer 後仍無 localDescription");
      }
      return local.sdp;
    } catch (err) {
      throw new AppError(
        ErrorCode.IO_ERROR,
        `WebRTC 處理 offer 失敗：${(err as Error).message}`,
        err,
      );
    }
  }

  /**
   * 餵入對方（手機）的 ICE candidate（trickle ICE）。candidate 形狀為瀏覽器
   * RTCIceCandidateInit（{ candidate, sdpMid, sdpMLineIndex }）。
   */
  async addIceCandidate(candidate: unknown): Promise<void> {
    const pc = this.pc;
    if (!pc) {
      throw new AppError(ErrorCode.IO_ERROR, "WebRTC 尚未啟動（請先 startStream）");
    }
    // end-of-candidates 以 null/undefined 表示，忽略即可。
    if (candidate == null) return;
    try {
      // candidate 來自前端 JSON，型別上是任意物件；werift 的 addIceCandidate 接受
      // RTCIceCandidateInit（含可選的 candidate/sdpMid/sdpMLineIndex），故以最小斷言轉入。
      const init = candidate as { candidate?: string; sdpMid?: string | null; sdpMLineIndex?: number | null };
      await pc.addIceCandidate(new RTCIceCandidate(init as Partial<RTCIceCandidate>));
    } catch (err) {
      throw new AppError(
        ErrorCode.IO_ERROR,
        `WebRTC 加入 ICE candidate 失敗：${(err as Error).message}`,
        err,
      );
    }
  }

  /** 即時通道狀態（給 RouterStatus / 前端訊號條）。 */
  status(): WebRtcStatus {
    return {
      connected: this.connected,
      reorderQueueDepth: this.queue.depth,
      droppedPackets: this.queue.dropped,
    };
  }

  // ─────────────── 內部：收音管線 ───────────────

  /** 掛上遠端音訊 track，逐 RTP 丟進重組佇列、依序釋放後解碼輸出。 */
  private attachTrack(track: MediaStreamTrack): void {
    track.onReceiveRtp.subscribe((rtp) => {
      try {
        // RTP 序號（16-bit）作為重組鍵。重組佇列會自動處理亂序/重複/缺口。
        const ready = this.queue.push(rtp.header.sequenceNumber, rtp);
        for (const pkt of ready) {
          void this.decodeAndEmit(pkt);
        }
      } catch (err) {
        this.errorCb?.(
          new AppError(ErrorCode.IO_ERROR, `WebRTC 收音失敗：${(err as Error).message}`, err),
        );
      }
    });
  }

  /** 確保 Opus 解碼器就緒（lazy 建立並快取，避免每塊重建 wasm）。 */
  private async ensureDecoder(): Promise<OpusDecoder> {
    if (this.decoder && this.decoderReady) {
      await this.decoderReady;
      return this.decoder;
    }
    // 強制單聲道輸出（forceStereo 不設）；預設輸出 48kHz Float32。
    const decoder = new OpusDecoder();
    this.decoder = decoder;
    this.decoderReady = decoder.ready;
    await this.decoderReady;
    return decoder;
  }

  /** 解碼單一 Opus RTP → 降採樣 → 組 AudioChunk → onDataReceived。 */
  private async decodeAndEmit(rtp: RtpPacket): Promise<void> {
    // 串流已停止後可能還有殘包進來：不再輸出。
    const cb = this.dataCb;
    if (!cb) return;

    let decoder: OpusDecoder;
    try {
      decoder = await this.ensureDecoder();
    } catch (err) {
      this.errorCb?.(
        new AppError(ErrorCode.IO_ERROR, `Opus 解碼器初始化失敗：${(err as Error).message}`, err),
      );
      return;
    }

    // payload 是 Buffer；opus-decoder 收 Uint8Array。Buffer 本身即 Uint8Array 子型別。
    const opusFrame = new Uint8Array(rtp.payload.buffer, rtp.payload.byteOffset, rtp.payload.byteLength);

    let decoded;
    try {
      decoded = decoder.decodeFrame(opusFrame);
    } catch (err) {
      // 單一壞封包不應中斷整條串流：回報後略過。
      this.errorCb?.(
        new AppError(ErrorCode.IO_ERROR, `Opus 解碼失敗：${(err as Error).message}`, err),
      );
      return;
    }

    if (decoded.samplesDecoded <= 0 || decoded.channelData.length === 0) {
      return; // 空幀（如 DTX 靜音）：跳過。
    }

    // 多聲道 → 單聲道（平均混音）。decoded.sampleRate 通常為 48000。
    const mono = downmixToMono(decoded.channelData, decoded.samplesDecoded);

    // 48kHz → 16kHz（或其它比率）。TARGET_SAMPLE_RATE 為 Whisper 期望的 16kHz。
    // decoded.sampleRate 在型別上是字面 48000，轉成 number 再比較（避免字面型別無交集警告）。
    const srcRate = decoded.sampleRate as number;
    const resampled =
      srcRate === TARGET_SAMPLE_RATE ? mono : downsample(mono, srcRate, TARGET_SAMPLE_RATE);

    if (resampled.length === 0) return;

    // 以「累積樣本數 / 目標取樣率」推算本塊起始時間（毫秒），對齊串流起點。
    const timestampMs = this.startedAtMs + (this.emittedSamples / TARGET_SAMPLE_RATE) * 1000;
    this.emittedSamples += resampled.length;

    const chunk: AudioChunk = {
      seq: this.outSeq++,
      timestampMs,
      samples: resampled,
      // AudioChunk.source 型別是 AudioSourceKind（"computer" | "phone"），不含 "webrtc"。
      // WebRTC 即時源在語意上就是「手機」收音（手機瀏覽器送上來的麥克風），故標 "phone"。
      source: "phone" as AudioSourceKind,
    };

    cb(chunk);
  }

  /** 依目前優先級決定重組佇列深度（background 加大批次以省 CPU）。 */
  private maxDepthForPriority(): number {
    return this.priority === "background" ? BACKGROUND_MAX_DEPTH : FOREGROUND_MAX_DEPTH;
  }
}

// ─────────────── 純函式：DSP 輔助（可獨立測試）───────────────

/** 多聲道 Float32 平均混成單聲道；單聲道時直接回傳第 0 軌的切片。 */
function downmixToMono(channels: Float32Array[], frames: number): Float32Array {
  const ch = channels.length;
  if (ch === 1) {
    // 只取實際解碼出的 frames 長度（channelData 可能有尾端冗餘）。
    return channels[0].subarray(0, frames).slice();
  }
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < ch; c++) {
      sum += channels[c][i] ?? 0;
    }
    out[i] = sum / ch;
  }
  return out;
}

/**
 * 線性內插降採樣（fromRate → toRate，要求 toRate < fromRate）。
 * 即時串流以「夠用且低延遲」為原則，採線性內插（非多相 FIR）：足以餵 Whisper，
 * CPU 成本極低。輸出長度 = floor(input.length * toRate / fromRate)。
 */
function downsample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input;
  if (input.length === 0) return input;
  const ratio = fromRate / toRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcPos = i * ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = srcPos - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}
