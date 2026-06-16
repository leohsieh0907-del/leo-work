import { describe, it, expect } from "vitest";
import { parseDshowDevices } from "../SystemAudioCapture";

// 回歸測試：ffmpeg -list_devices 有兩種輸出格式，解析都要正確，否則「電腦系統」收音
// 會抓不到任何裝置而整個失效（曾因新版 ffmpeg 不印區段標題而靜默壞掉）。
describe("parseDshowDevices", () => {
  it("新版格式（行尾標 (audio)/(video)，無區段標題）", () => {
    const stderr = [
      `[dshow @ 0x1] "USB2.0 FHD UVC WebCam" (video)`,
      `[dshow @ 0x1]   Alternative name "@device_pnp_\\\\?\\usb#vid_3277"`,
      `[dshow @ 0x1] "Microphone Array (Intel® Smart Sound Technology)" (audio)`,
      `[dshow @ 0x1]   Alternative name "@device_cm_{33D9A762}\\wave_{DAC27A2C}"`,
      `[dshow @ 0x1] "Voicemeeter Out B1 (VB-Audio Voicemeeter VAIO)" (audio)`,
      `[dshow @ 0x1] "Stereo Mix (Realtek(R) Audio)" (audio)`,
    ].join("\n");

    const { inputs, loopbackCandidates } = parseDshowDevices(stderr);
    expect(inputs).toEqual([
      "Microphone Array (Intel® Smart Sound Technology)",
      "Voicemeeter Out B1 (VB-Audio Voicemeeter VAIO)",
      "Stereo Mix (Realtek(R) Audio)",
    ]);
    // 攝影機(video)與 Alternative name 行都不該收進來
    expect(inputs.some((n) => /WebCam/.test(n))).toBe(false);
    expect(inputs.some((n) => /device_/.test(n))).toBe(false);
    // loopback 候選：VoiceMeeter 與 Stereo Mix
    expect(loopbackCandidates).toEqual([
      "Voicemeeter Out B1 (VB-Audio Voicemeeter VAIO)",
      "Stereo Mix (Realtek(R) Audio)",
    ]);
  });

  it("舊版格式（DirectShow audio/video devices 區段標題）", () => {
    const stderr = [
      `[dshow @ 0x1] DirectShow video devices`,
      `[dshow @ 0x1]  "HD WebCam"`,
      `[dshow @ 0x1] DirectShow audio devices`,
      `[dshow @ 0x1]  "Microphone (Realtek High Definition Audio)"`,
      `[dshow @ 0x1]  "立體聲混音 (Realtek High Definition Audio)"`,
    ].join("\n");

    const { inputs, loopbackCandidates } = parseDshowDevices(stderr);
    expect(inputs).toEqual([
      "Microphone (Realtek High Definition Audio)",
      "立體聲混音 (Realtek High Definition Audio)",
    ]);
    expect(inputs.some((n) => /WebCam/.test(n))).toBe(false); // video 區段不收
    expect(loopbackCandidates).toEqual(["立體聲混音 (Realtek High Definition Audio)"]);
  });

  it("空輸入回空清單，不丟錯", () => {
    expect(parseDshowDevices("")).toEqual({ inputs: [], loopbackCandidates: [] });
  });
});
