// ════════════════════════════════════════════════════════════════════
//  雙源收音模組 — 型別與契約
//
//  內部標準音訊格式：單聲道 Float32（-1..1）、16kHz（直接對接 Whisper）。
//  不論來源是「電腦系統混音」或「手機 WSS 二進位流」，都會被正規化成
//  下方的 AudioChunk，再走 AGC → VU → 同步 → 轉寫 的統一管線。
//
//  跨前後端的 DTO（VuLevel / AudioEngineStatus / PhoneSession / AudioEvent /
//  AudioDeviceList / AudioSourceKind）定義在 src/shared/types.ts，此處再 re-export，
//  讓 sidecar 端只需 import 本檔。
// ════════════════════════════════════════════════════════════════════

export type {
  AudioSourceKind,
  VuLevel,
  AudioEngineStatus,
  PhoneSession,
  AudioDeviceList,
  AudioEvent,
  AudioSourceId,
  SourcePriority,
  RouterStatus,
  BluetoothTransferStatus,
  WebRtcStatus,
} from "../../shared/types";
export { AudioSourceState } from "../../shared/types";

import type { AudioSourceKind, AudioSourceId, SourcePriority } from "../../shared/types";

/** Whisper 期望的取樣率。 */
export const TARGET_SAMPLE_RATE = 16_000;

/** 正規化後的音訊塊（管線內部統一單位）。 */
export interface AudioChunk {
  /** 單調遞增序號（同一 session 內）；用於重連去重與補位對齊。 */
  seq: number;
  /** 此塊第一個樣本的擷取時間（毫秒，來源時鐘）。 */
  timestampMs: number;
  /** 單聲道 16kHz PCM，值域 -1..1。 */
  samples: Float32Array;
  source: AudioSourceKind;
}

// ─────────────── 收音來源契約（採回呼注入，避免事件型別繁瑣）───────────────

/**
 * 任一收音來源都實作此介面：start 時注入「收到音訊塊」與「錯誤」回呼。
 * 來源負責把原始音訊正規化成 AudioChunk（單聲道 16kHz Float32）。
 */
export interface CaptureSource {
  start(onChunk: (chunk: AudioChunk) => void, onError: (err: Error) => void): Promise<void>;
  stop(): Promise<void>;
}

/** 手機橋接：除了是 CaptureSource，還能產生 QR session 與回報連線狀態。 */
export interface PhoneBridge extends CaptureSource {
  /** 開伺服器（若尚未開）並回傳 QR / token / 網址。 */
  getSession(): Promise<import("../../shared/types").PhoneSession>;
  /** 目前是否有手機連著。 */
  readonly connected: boolean;
}

// ─────────────── AGC / 同步 契約 ───────────────

export interface AgcOptions {
  /** 目標 RMS（0..1），預設 0.12 */
  targetRms?: number;
  /** 最大增益倍率，預設 12 */
  maxGain?: number;
  /** 增益上升平滑係數 0..1（越小越慢），預設 0.2 */
  attack?: number;
  /** 增益下降平滑係數 0..1，預設 0.05 */
  release?: number;
}

export interface SyncResult {
  /** 是否接受此塊（false = 重複封包，丟棄） */
  accepted: boolean;
  /** 為了維持時間軸對齊而需補入的靜音樣本數（網路斷線造成的缺口） */
  insertedSilence: number;
}

// ════════════════ 雙軌整合：統一音訊輸入抽象 ════════════════

/**
 * 統一音訊輸入介面（對應規格的 `AudioSource` trait）。
 * `BluetoothHardwareSource` 與 `WebRtcSoftwareSource` 各自實作；
 * Router 與下游 Whisper 只認這個介面，不管底層是藍牙還是 WebRTC。
 */
export interface AudioSource {
  readonly id: AudioSourceId;
  /** 開始串流（連線/起 ffmpeg/起 PeerConnection…）。 */
  startStream(): Promise<void>;
  /** 停止串流。可重複呼叫安全。 */
  stopStream(): Promise<void>;
  /** 註冊「收到正規化音訊塊」的回呼。 */
  onDataReceived(callback: (chunk: AudioChunk) => void): void;
  /** 註冊錯誤回呼。 */
  onError(callback: (err: Error) => void): void;
  /**
   * 調整優先級。WebRTC 即時串流進行時，Router 會把藍牙傳輸設為 "background"，
   * 來源據此節流（降低 CPU/IO 佔用），確保即時轉寫不掉幀。
   */
  setPriority(priority: SourcePriority): void;
  /** 目前是否在串流。 */
  readonly streaming: boolean;
}

// ────────── 藍牙傳輸抽象（裝置協定的整合點）──────────

/**
 * 低階藍牙傳輸介面。`BluetoothHardwareSource` 透過它收送位元組，
 * 與「具體用 noble(BLE) 還是別的」解耦——也讓斷點續傳邏輯能用假傳輸做單元測試。
 *
 * ⚠️ PM01-9 實際的 GATT 服務/特徵值與封包格式為裝置私有協定，
 * 需原廠文件；`NobleBleTransport` 只是把 noble 的 notify/write 接到此介面。
 */
export interface BleTransport {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** 訂閱裝置推送的位元組（GATT notify）。 */
  onData(callback: (data: Uint8Array) => void): void;
  /** 對裝置下指令（如請求自 offset 續傳）。 */
  send(data: Uint8Array): Promise<void>;
  readonly connected: boolean;
}

/** 斷點續傳的一次傳輸工作描述。 */
export interface TransferManifest {
  /** 檔案 id（裝置端的錄音檔識別） */
  fileId: string;
  /** 總位元組數 */
  totalBytes: number;
  /** 每塊位元組數 */
  chunkSize: number;
  /** 是否為加密內容（傳完要呼叫 SecurityManager 解密） */
  encrypted: boolean;
}

/** 斷點續傳完成後的結果。 */
export interface TransferResult {
  fileId: string;
  /** 重組後的完整位元組（若 encrypted 則仍為密文，交給上層解密） */
  data: Buffer;
  bytes: number;
}
