// ── 轉接器：把既有 CaptureSource（如 SystemAudioCapture）包成統一的 AudioSource ──
// 讓 AudioIngestionRouter 能用同一介面驅動「電腦系統混音」這條既有來源（LOCAL_RECORDING）。

import type { AudioChunk, AudioSource, CaptureSource, SourcePriority } from "./types";
import type { AudioSourceId } from "../../shared/types";

export class CaptureSourceAdapter implements AudioSource {
  readonly id: AudioSourceId;
  private readonly inner: CaptureSource;
  private dataCb: ((chunk: AudioChunk) => void) | null = null;
  private errCb: ((err: Error) => void) | null = null;
  private active = false;

  constructor(inner: CaptureSource, id: AudioSourceId) {
    this.inner = inner;
    this.id = id;
  }

  async startStream(): Promise<void> {
    await this.inner.start(
      (chunk) => this.dataCb?.(chunk),
      (err) => this.errCb?.(err),
    );
    this.active = true;
  }

  async stopStream(): Promise<void> {
    this.active = false;
    await this.inner.stop();
  }

  onDataReceived(callback: (chunk: AudioChunk) => void): void {
    this.dataCb = callback;
  }

  onError(callback: (err: Error) => void): void {
    this.errCb = callback;
  }

  // 本機系統混音沒有「背景節流」概念（ffmpeg 自走），優先級切換為 no-op。
  setPriority(_priority: SourcePriority): void {
    /* 無操作：系統混音來源不需節流 */
  }

  get streaming(): boolean {
    return this.active;
  }
}
