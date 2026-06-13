// ── 雙軌音訊狀態（Zustand）──
// 規格要求用 Zustand/Redux 管理 AudioSourceState；這裡用 Zustand。
// 訂閱 sidecar 的 /events，把 router/vu/transcript/error 事件灌進 store；
// 動作呼叫 /router/* 控制路由，狀態以事件回流為準（單一資料源）。

import { create } from "zustand";
import {
  AudioSourceState,
  type AudioSourceId,
  type RouterStatus,
  type VuLevel,
} from "../shared/types";
import { subscribeAudioEvents } from "../lib/audioApi";
import { activateSource, deactivateSource, syncBluetooth } from "../lib/audioRouterApi";

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

  /** 連上 /events 並開始接收事件；回傳取消訂閱函式。 */
  connect: () => () => void;
  activate: (id: AudioSourceId) => Promise<void>;
  deactivate: () => Promise<void>;
  syncBluetooth: () => Promise<void>;
}

export const useAudioStore = create<AudioStore>((set) => ({
  state: AudioSourceState.DISCONNECTED,
  status: null,
  vu: null,
  transcript: "",
  error: null,
  busy: false,

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
}));
