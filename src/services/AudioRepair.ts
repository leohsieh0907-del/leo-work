// ════════════════════════════════════════════════════════════════════
//  AudioRepair — 音訊標頭 / 容器修復
//
//  策略：先做輕量驗證（ffprobe，若 binary 不可用則略過），驗證不過或
//  無法驗證時，直接嘗試以 FFmpeg `-c copy`（stream copy / remux）把音訊
//  重新封裝到系統暫存目錄的新檔。remux 不重新編碼、只重建容器與標頭，
//  能修好大多數「錄到一半中斷、moov atom 缺失、標頭損壞」的檔案。
//
//  注意：ffmpeg-static 只提供 ffmpeg，不含 ffprobe；故 ffprobe 失敗時
//  不視為致命，改走 remux 路線。
// ════════════════════════════════════════════════════════════════════

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

import ffmpeg from "fluent-ffmpeg";
// ffmpeg-static 沒有型別宣告檔，預設 import 會報 TS7016；以 declare 補上最小型別。
// （它在執行期匯出「ffmpeg 執行檔的絕對路徑字串」，找不到時為 null。）
// @ts-ignore — ffmpeg-static 無型別宣告，見上方說明
import ffmpegStatic from "ffmpeg-static";

import { AppError, ErrorCode } from "../shared/types";

/** 允許處理的音訊副檔名（小寫，含點）。 */
const ALLOWED_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".mp4"]);

export class AudioRepair {
  /** ffmpeg 執行檔絕對路徑；ffmpeg-static 找不到時為 null。 */
  private readonly ffmpegPath: string | null;

  constructor() {
    // ffmpegStatic 型別為 string | null
    this.ffmpegPath = (ffmpegStatic as unknown as string | null) ?? null;
    if (this.ffmpegPath) {
      ffmpeg.setFfmpegPath(this.ffmpegPath);
    }
  }

  /**
   * 檢查音訊檔；標頭 / 容器損壞時用 FFmpeg remux 修復。
   * @returns 可用檔案的路徑：修復則為新暫存檔，原本就正常則回傳原路徑。
   * @throws AppError 不支援格式 / 檔案不存在 / 無法修復。
   */
  async repairIfNeeded(inputPath: string): Promise<string> {
    // ─── 防呆：輸入 ───
    if (typeof inputPath !== "string" || inputPath.length === 0) {
      throw new AppError(ErrorCode.INVALID_INPUT, "inputPath 不可為空");
    }

    // ─── 防呆：FFmpeg 是否可用 ───
    if (!this.ffmpegPath) {
      throw new AppError(ErrorCode.AUDIO_UNREPAIRABLE, "找不到 FFmpeg");
    }

    // ─── 副檔名檢查 ───
    const ext = path.extname(inputPath).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      throw new AppError(
        ErrorCode.AUDIO_UNSUPPORTED_FORMAT,
        `不支援的音訊格式：${ext || "(無副檔名)"}（僅支援 .mp3/.wav/.m4a/.mp4）`,
      );
    }

    // ─── 檔案是否存在且為一般檔案 ───
    try {
      const stat = await fs.stat(inputPath);
      if (!stat.isFile()) {
        throw new AppError(ErrorCode.IO_ERROR, `路徑不是檔案：${inputPath}`);
      }
    } catch (err) {
      if (err instanceof AppError) throw err;
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") {
        throw new AppError(ErrorCode.IO_ERROR, `音訊檔不存在：${inputPath}`, code);
      }
      throw new AppError(
        ErrorCode.IO_ERROR,
        `讀取音訊檔失敗：${inputPath}`,
        err instanceof Error ? err.message : err,
      );
    }

    // ─── 步驟一：輕量驗證（ffprobe）。可用且通過 → 原檔即可，免修復。 ───
    const probeOk = await this.tryProbe(inputPath);
    if (probeOk) {
      return inputPath;
    }

    // ─── 步驟二：ffprobe 不通過 / 不可用 → 嘗試 remux 修復 ───
    const outputPath = this.makeTempPath(ext);
    try {
      await this.remux(inputPath, outputPath);
    } catch (err) {
      // remux 也失敗 → 確定無法自動修復；清掉殘留的半成品輸出檔
      await this.safeUnlink(outputPath);
      const stderr = err instanceof Error ? err.message : String(err);
      throw new AppError(
        ErrorCode.AUDIO_UNREPAIRABLE,
        "音訊檔損壞且無法自動修復",
        { code: ErrorCode.AUDIO_HEADER_CORRUPT, stderr },
      );
    }

    // remux 成功，但若輸出檔為空（0 bytes）視同失敗
    try {
      const outStat = await fs.stat(outputPath);
      if (outStat.size === 0) {
        await this.safeUnlink(outputPath);
        throw new AppError(
          ErrorCode.AUDIO_UNREPAIRABLE,
          "音訊檔損壞且無法自動修復",
          { code: ErrorCode.AUDIO_HEADER_CORRUPT, stderr: "remux 產出空檔" },
        );
      }
    } catch (err) {
      if (err instanceof AppError) throw err;
      await this.safeUnlink(outputPath);
      throw new AppError(
        ErrorCode.AUDIO_UNREPAIRABLE,
        "音訊檔損壞且無法自動修復",
        { code: ErrorCode.AUDIO_HEADER_CORRUPT, stderr: err instanceof Error ? err.message : err },
      );
    }

    return outputPath;
  }

  /**
   * 嘗試以 ffprobe 驗證檔案可讀。
   * ffmpeg-static 不含 ffprobe，故任何失敗（包含「找不到 ffprobe」）一律
   * 回傳 false，讓上層改走 remux，而不是直接判定檔案壞掉。
   */
  private tryProbe(inputPath: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      ffmpeg.ffprobe(inputPath, (err, data) => {
        if (err) {
          resolve(false);
          return;
        }
        // 至少要有一條 stream 才算可讀
        const hasStream = Array.isArray(data?.streams) && data.streams.length > 0;
        resolve(hasStream);
      });
    });
  }

  /**
   * 以 stream copy（`-c copy`）remux 到 outputPath，包成 Promise。
   * 不重新編碼，僅重建容器/標頭。失敗時 reject 帶 stderr 內容。
   */
  private remux(inputPath: string, outputPath: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let stderrBuf = "";

      ffmpeg(inputPath)
        // 重建容器/標頭但不轉碼，速度快且無損
        .outputOptions(["-c", "copy"])
        // 對 mp4/m4a 把 moov atom 移到檔頭，避免壞檔殘留問題
        .outputOptions(["-movflags", "+faststart"])
        .on("stderr", (line: string) => {
          // 累積 ffmpeg 過程訊息，失敗時帶回供診斷
          stderrBuf += line + "\n";
        })
        .on("error", (err: Error) => {
          const detail = stderrBuf.trim() || err.message;
          reject(new Error(detail));
        })
        .on("end", () => {
          resolve();
        })
        .save(outputPath);
    });
  }

  /** 在系統暫存目錄產生一個唯一輸出路徑。 */
  private makeTempPath(ext: string): string {
    const token = randomBytes(8).toString("hex");
    return path.join(os.tmpdir(), `proactor-fix-${token}${ext}`);
  }

  /** 刪除檔案但吞掉錯誤（清理用，不應因清理失敗而中斷主流程）。 */
  private async safeUnlink(p: string): Promise<void> {
    try {
      await fs.unlink(p);
    } catch {
      // 檔案不存在或已被清掉皆無妨
    }
  }
}
