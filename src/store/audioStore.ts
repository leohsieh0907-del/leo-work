// ── 雙軌音訊狀態（Zustand）──
// 規格要求用 Zustand/Redux 管理 AudioSourceState；這裡用 Zustand。
// 訂閱 sidecar 的 /events，把 router/vu/transcript/error 事件灌進 store；
// 動作呼叫 /router/* 控制路由，狀態以事件回流為準（單一資料源）。

import { create } from "zustand";
import {
  AudioSourceState,
  type AudioSourceId,
  type RouterStatus,
  type TranscribeLang,
  type VuLevel,
} from "../shared/types";
import { subscribeAudioEvents } from "../lib/audioApi";
import {
  activateSource,
  deactivateSource,
  syncBluetooth,
  transcribeRouterRecording,
} from "../lib/audioRouterApi";

interface AudioStore {
  /** 四態狀態機目前狀態 */
  state: AudioSourceState;
  /** 路由完整狀態（藍牙進度、WebRTC 佇列…） */
  status: RouterStatus | null;
  /** 最新 VU 訊號 */
  vu: VuLevel | null;
  /** 累積即時逐字稿 */
  transcript: string;
  error: string | null;
  busy: boolean;

  /** 停止收音後是否有可「整檔精修帶入會議」的錄音。 */
  recordingReady: boolean;
  /** 該段錄音長度（秒）。 */
  recordingSeconds: number;
  /** 錄音是否因超過上限被截斷（只精修了前段）。 */
  recordingTruncated: boolean;
  /** 精修中（呼叫 /router/transcribe）。 */
  finalizing: boolean;

  /** 連上 /events 並開始接收事件；回傳取消訂閱函式。 */
  connect: () => () => void;
  activate: (id: AudioSourceId) => Promise<void>;
  deactivate: () => Promise<void>;
  syncBluetooth: () => Promise<void>;
  /** 把剛停止的收音整檔精修，回乾淨逐字稿（呼叫端負責帶入會議）。 */
  finalizeRecording: (lang: TranscribeLang) => Promise<string>;
}

export const useAudioStore = create<AudioStore>((set) => ({
  state: AudioSourceState.DISCONNECTED,
  status: null,
  vu: null,
  transcript: "",
  error: null,
  busy: false,
  recordingReady: false,
  recordingSeconds: 0,
  recordingTruncated: false,
  finalizing: false,

  connect: () => {
    return subscribeAudioEvents((e) => {
      switch (e.type) {
        case "router":
          set({ status: e.status, state: e.status.state });
          break;
        case "vu":
          set({ vu: e.level });
          break;
        case "transcript": {
          const text = e.segments.map((s) => s.text).join(" ");
          if (text.trim()) set((s) => ({ transcript: `${s.transcript} ${text}`.trim() }));
          break;
        }
        case "recording":
          // 新 session 開始（ready=false）時順手清掉上一段的即時粗稿。
          set(
            e.ready
              ? { recordingReady: true, recordingSeconds: e.seconds, recordingTruncated: e.truncated }
              : { recordingReady: false, recordingSeconds: 0, recordingTruncated: false, transcript: "" },
          );
          break;
        case "error":
          set({ error: e.message });
          break;
        default:
          break; // status / transfer / ice 不在此 store 處理
      }
    });
  },

  activate: async (id) => {
    set({ busy: true, error: null });
    try {
      const { status } = await activateSource(id);
      set({ status, state: status.state });
    } catch (err) {
      set({ error: String(err) });
    } finally {
      set({ busy: false });
    }
  },

  deactivate: async () => {
    set({ busy: true });
    try {
      const { status } = await deactivateSource();
      set({ status, state: status.state });
    } catch (err) {
      set({ error: String(err) });
    } finally {
      set({ busy: false });
    }
  },

  syncBluetooth: async () => {
    set({ busy: true, error: null });
    try {
      const { status } = await syncBluetooth();
      set({ status, state: status.state });
    } catch (err) {
      set({ error: String(err) });
    } finally {
      set({ busy: false });
    }
  },

  finalizeRecording: async (lang) => {
    set({ finalizing: true, error: null });
    try {
      const { transcript } = await transcribeRouterRecording(lang);
      // 精修版已取走（後端清空緩衝），重置可精修狀態。
      set({ recordingReady: false, recordingSeconds: 0, recordingTruncated: false });
      return transcript;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    } finally {
      set({ finalizing: false });
    }
  },
}));
