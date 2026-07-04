// 用打包內附的 ffmpeg 把任意音訊格式（M4A/MP3/WebM/AAC…）轉成 16kHz 單聲道 PCM16 WAV，
// 供分段轉錄使用。匯入外部錄音檔（手機常見 M4A）不再依賴 Gemini 認 MIME / Files API：
// ffmpeg 依實際內容自動辨識格式，不看副檔名/MIME，故空 MIME 或 audio/x-m4a 也能處理。

import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { writeFile, readFile, rm } from "node:fs/promises";
// @ts-ignore — ffmpeg-static 無型別宣告（同 SystemAudioCapture 慣例；執行期為 ffmpeg 絕對路徑，找不到為 null）
import ffmpegStatic from "ffmpeg-static";
import { AppError, ErrorCode } from "../shared/types";

function ffmpegPath(): string | null {
  return (ffmpegStatic as unknown as string | null) ?? null;
}

/** 把任意音訊位元組轉成 16kHz 單聲道 PCM16 WAV（走暫存檔以確保 WAV header 大小正確）。 */
export async function decodeToWav16kMono(input: Buffer): Promise<Buffer> {
  const bin = ffmpegPath();
  if (!bin) {
    throw new AppError(ErrorCode.AUDIO_UNSUPPORTED_FORMAT, "找不到 ffmpeg，無法轉換此音檔格式");
  }
  const id = randomUUID();
  const inPath = path.join(tmpdir(), `leo-import-${id}.in`);
  const outPath = path.join(tmpdir(), `leo-import-${id}.wav`);
  try {
    await writeFile(inPath, input);
    await runFfmpeg(bin, [
      "-hide_banner", "-loglevel", "error",
      "-i", inPath,
      "-ac", "1", "-ar", "16000", "-acodec", "pcm_s16le",
      "-f", "wav", "-y", outPath,
    ]);
    return await readFile(outPath);
  } finally {
    await rm(inPath, { force: true }).catch(() => {});
    await rm(outPath, { force: true }).catch(() => {});
  }
}

function runFfmpeg(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args);
    let stderr = "";
    p.stderr.on("data", (d) => {
      stderr += String(d);
      if (stderr.length > 8192) stderr = stderr.slice(-8192); // 只留尾段錯誤訊息
    });
    p.on("error", (e) =>
      reject(new AppError(ErrorCode.AUDIO_UNSUPPORTED_FORMAT, `ffmpeg 啟動失敗：${e.message}`)),
    );
    p.on("close", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new AppError(
            ErrorCode.AUDIO_UNSUPPORTED_FORMAT,
            `音檔轉換失敗（ffmpeg code ${code}）：${stderr.trim().slice(-500)}`,
          ),
        );
    });
  });
}
