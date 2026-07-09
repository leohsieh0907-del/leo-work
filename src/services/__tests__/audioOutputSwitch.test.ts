// ════════════════════════════════════════════════════════════════════
//  AudioOutputSwitch 單元測試（vitest，注入假 PsRunner，不碰真 PowerShell）
//
//  驗證：
//    1) classifyDevice 依關鍵字分類 normal / record / other / unknown
//    2) getStatus 讀裝置名 → 分類；runner 拋錯 → unknown（非 Windows/無模組不壞）
//    3) setMode 依 mode 打對關鍵字、回分類後狀態；找不到裝置(NOTFOUND) → 拋 AppError
//    4) revertIfRecord 只有在目前=record 時才切回 normal
// ════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi } from "vitest";

import { AudioOutputSwitch, classifyDevice, type PsRunner } from "../AudioOutputSwitch";
import { AppError } from "../../shared/types";

const SPK = "Speakers (Realtek(R) Audio)";
const CABLE = "CABLE Input (VB-Audio Virtual Cable)";
const AIRPODS = "耳機 (AirPods Pro - Find My)";

describe("classifyDevice", () => {
  it("依關鍵字分類", () => {
    expect(classifyDevice(SPK)).toBe("normal");
    expect(classifyDevice(CABLE)).toBe("record");
    expect(classifyDevice(AIRPODS)).toBe("other");
    expect(classifyDevice("")).toBe("unknown");
  });
});

describe("AudioOutputSwitch.getStatus", () => {
  it("讀到裝置名 → 分類", async () => {
    const sw = new AudioOutputSwitch(async () => CABLE);
    await expect(sw.getStatus()).resolves.toEqual({ mode: "record", deviceName: CABLE });
  });

  it("runner 拋錯（非 Windows/無模組）→ unknown、不丟例外", async () => {
    const sw = new AudioOutputSwitch(async () => {
      throw new Error("powershell not found");
    });
    await expect(sw.getStatus()).resolves.toEqual({ mode: "unknown", deviceName: "" });
  });
});

describe("AudioOutputSwitch.setMode", () => {
  it("record 用 CABLE 關鍵字、normal 用 Realtek 關鍵字", async () => {
    const runner: PsRunner = vi.fn(async (script: string) =>
      script.includes("CABLE Input") ? CABLE : SPK,
    );
    const sw = new AudioOutputSwitch(runner);

    await expect(sw.setMode("record")).resolves.toEqual({ mode: "record", deviceName: CABLE });
    await expect(sw.setMode("normal")).resolves.toEqual({ mode: "normal", deviceName: SPK });
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("找不到裝置(NOTFOUND) → 拋 AppError", async () => {
    const sw = new AudioOutputSwitch(async () => "NOTFOUND");
    await expect(sw.setMode("record")).rejects.toBeInstanceOf(AppError);
  });

  it("runner 拋錯 → 拋 AppError（含友善訊息）", async () => {
    const sw = new AudioOutputSwitch(async () => {
      throw new Error("boom");
    });
    await expect(sw.setMode("normal")).rejects.toBeInstanceOf(AppError);
  });
});

describe("AudioOutputSwitch.revertIfRecord", () => {
  it("目前=record → 切回 normal", async () => {
    const calls: string[] = [];
    const runner: PsRunner = async (script: string) => {
      if (script.includes("Get-AudioDevice -Playback")) return CABLE; // getStatus：目前卡在 CABLE
      calls.push(script);
      return SPK; // setMode('normal')
    };
    await new AudioOutputSwitch(runner).revertIfRecord();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("Realtek");
  });

  it("目前=normal → 不動作", async () => {
    const runner: PsRunner = vi.fn(async (script: string) =>
      script.includes("Get-AudioDevice -Playback") ? SPK : SPK,
    );
    await new AudioOutputSwitch(runner).revertIfRecord();
    expect(runner).toHaveBeenCalledTimes(1); // 只查一次，不切
  });
});
