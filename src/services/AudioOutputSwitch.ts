// ── 系統預設「播放」裝置切換（Windows / AudioDeviceCmdlets）──
// 用途：讓「耳機錄音模式」按鈕在 Realtek 喇叭 ↔ CABLE Input 之間切換系統預設輸出。
//   • normal(喇叭)：平常聽聲音、音量鍵正常。
//   • record(CABLE)：聲音導進虛擬線給 Leo work 側錄；戴 AirPods 時靠 CABLE Output 的
//     「聆聽此裝置→AirPods」聽對方（一次性 Windows 設定，本檔不管）。
// 走 PowerShell 的 AudioDeviceCmdlets 模組（本機已裝）；僅 Windows 有效。
// 非 Windows / 模組缺席時：getStatus 回 unknown、setMode 拋 AppError，讓前端顯示提示而非整個壞掉。

import { execFile } from "node:child_process";
import { AppError, ErrorCode, type OutputMode, type OutputStatus } from "../shared/types";

// 裝置名稱關鍵字（可用 env 覆寫）。normal＝平常聽的喇叭；record＝錄音用的虛擬線輸入。
const NORMAL_KW = process.env.AUDIO_NORMAL_DEVICE?.trim() || "Realtek";
const RECORD_KW = process.env.AUDIO_RECORD_DEVICE?.trim() || "CABLE Input";

/** 執行一段 PowerShell 回 stdout（去頭尾空白）。可注入以利測試。 */
export type PsRunner = (script: string) => Promise<string>;

const defaultRunner: PsRunner = (script) =>
  new Promise((resolve, reject) => {
    execFile(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, timeout: 8000 },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout).trim())),
    );
  });

/** 依關鍵字把裝置名稱分類成 OutputMode。 */
export function classifyDevice(name: string): OutputMode {
  if (!name) return "unknown";
  const lower = name.toLowerCase();
  if (lower.includes(RECORD_KW.toLowerCase())) return "record";
  if (lower.includes(NORMAL_KW.toLowerCase())) return "normal";
  return "other";
}

export class AudioOutputSwitch {
  constructor(private readonly run: PsRunner = defaultRunner) {}

  /** 讀目前預設播放裝置與分類。查不到（非 Windows / 無模組）回 unknown。 */
  async getStatus(): Promise<OutputStatus> {
    try {
      const name = await this.run("Import-Module AudioDeviceCmdlets; (Get-AudioDevice -Playback).Name");
      return { mode: classifyDevice(name), deviceName: name };
    } catch {
      return { mode: "unknown", deviceName: "" };
    }
  }

  /** 切換預設播放裝置到 normal(喇叭) 或 record(CABLE)；回切換後狀態。 */
  async setMode(mode: "normal" | "record"): Promise<OutputStatus> {
    const kw = (mode === "record" ? RECORD_KW : NORMAL_KW).replace(/'/g, "''");
    const script =
      `Import-Module AudioDeviceCmdlets; ` +
      `$d = Get-AudioDevice -List | Where-Object { $_.Type -eq 'Playback' -and $_.Name -match [regex]::Escape('${kw}') } | Select-Object -First 1; ` +
      `if ($d) { Set-AudioDevice -Index $d.Index | Out-Null; $d.Name } else { 'NOTFOUND' }`;
    let out: string;
    try {
      out = await this.run(script);
    } catch (err) {
      throw new AppError(
        ErrorCode.IO_ERROR,
        "切換音訊裝置失敗（需 Windows + AudioDeviceCmdlets 模組）",
        err instanceof Error ? err.message : err,
      );
    }
    if (!out || out === "NOTFOUND") {
      const what = mode === "record" ? `錄音用虛擬音效卡（${RECORD_KW}）` : `喇叭（${NORMAL_KW}）`;
      throw new AppError(ErrorCode.IO_ERROR, `找不到${what}，無法切換`);
    }
    return { mode: classifyDevice(out), deviceName: out };
  }

  /** 安全網：若目前卡在 record(CABLE)，切回 normal(喇叭)。sidecar 啟動時呼叫，防上次沒切回。 */
  async revertIfRecord(): Promise<void> {
    const { mode } = await this.getStatus();
    if (mode === "record") await this.setMode("normal").catch(() => {});
  }
}
