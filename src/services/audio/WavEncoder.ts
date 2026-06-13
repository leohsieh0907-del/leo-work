// ════════════════════════════════════════════════════════════════════
//  WavEncoder — 單聲道 Float32 PCM → 16-bit PCM WAV
//
//  內部管線統一用 Float32（-1..1）做運算，但 whisper.cpp 等工具吃的是
//  WAV 檔；此模組負責把一段 Float32 樣本編成「標準 44 byte 標頭 + 16-bit
//  小端 PCM data」的 WAV Buffer，或直接寫成 .wav 檔（自動建立目錄）。
//
//  標頭格式（RIFF/WAVE，PCM, mono, 16-bit）：
//    off  size  欄位
//    0    4     "RIFF"
//    4    4     ChunkSize        = 36 + dataSize
//    8    4     "WAVE"
//    12   4     "fmt "
//    16   4     Subchunk1Size    = 16（PCM）
//    20   2     AudioFormat      = 1（PCM）
//    22   2     NumChannels      = 1（mono）
//    24   4     SampleRate
//    28   4     ByteRate         = SampleRate * NumChannels * BitsPerSample/8
//    32   2     BlockAlign       = NumChannels * BitsPerSample/8
//    34   2     BitsPerSample    = 16
//    36   4     "data"
//    40   4     Subchunk2Size    = dataSize（= numSamples * 2）
//    44   ...   PCM 樣本（int16 little-endian）
// ════════════════════════════════════════════════════════════════════

import { promises as fs } from "node:fs";
import path from "node:path";

/** WAV 標頭固定長度（PCM）。 */
const WAV_HEADER_BYTES = 44;
/** 每個 16-bit 樣本佔的位元組數。 */
const BYTES_PER_SAMPLE = 2;
/** 單聲道。 */
const NUM_CHANNELS = 1;
/** 位元深度。 */
const BITS_PER_SAMPLE = 16;

/**
 * 把單聲道 Float32(-1..1) PCM 編成 16-bit PCM WAV 的 Buffer（含 44 byte 標頭）。
 *
 * - Float32 → Int16：先 clamp 到 [-1, 1]，再乘 32767 並四捨五入。
 * - 非有限值（NaN/Infinity）一律當靜音（0）處理，避免寫出垃圾樣本。
 * - sampleRate 必須是正整數，否則拋錯（壞掉的取樣率會讓整個 WAV 無法播放）。
 */
export function encodeWavPcm16(samples: Float32Array, sampleRate: number): Buffer {
  if (!(samples instanceof Float32Array)) {
    throw new TypeError("encodeWavPcm16：samples 必須是 Float32Array");
  }
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError(`encodeWavPcm16：sampleRate 不合法（${sampleRate}）`);
  }

  const numSamples = samples.length;
  const dataSize = numSamples * BYTES_PER_SAMPLE;
  const byteRate = (sampleRate * NUM_CHANNELS * BITS_PER_SAMPLE) / 8;
  const blockAlign = (NUM_CHANNELS * BITS_PER_SAMPLE) / 8;

  const buffer = Buffer.alloc(WAV_HEADER_BYTES + dataSize);

  // ─── RIFF chunk ───
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4); // ChunkSize = 36 + Subchunk2Size
  buffer.write("WAVE", 8, "ascii");

  // ─── fmt subchunk ───
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16); // Subchunk1Size（PCM 固定 16）
  buffer.writeUInt16LE(1, 20); // AudioFormat = 1（PCM）
  buffer.writeUInt16LE(NUM_CHANNELS, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(BITS_PER_SAMPLE, 34);

  // ─── data subchunk ───
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);

  // ─── PCM 樣本（Float32 → Int16, little-endian）───
  let offset = WAV_HEADER_BYTES;
  for (let i = 0; i < numSamples; i++) {
    const int16 = floatToInt16(samples[i]);
    buffer.writeInt16LE(int16, offset);
    offset += BYTES_PER_SAMPLE;
  }

  return buffer;
}

/**
 * 寫成 .wav 檔（自動建立上層目錄）。
 *
 * 失敗（編碼參數不合法、磁碟寫入失敗）直接讓底層錯誤往上拋，由呼叫端
 * 決定如何容錯（StreamingTranscriber 會包成 AppError 並降級）。
 */
export async function writeWavFile(
  filePath: string,
  samples: Float32Array,
  sampleRate: number,
): Promise<void> {
  const wav = encodeWavPcm16(samples, sampleRate);
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath, wav);
}

/**
 * 單一 Float32 樣本 → Int16。
 * clamp 到 [-1, 1]，非有限值視為靜音；正負滿刻度都映到 ±32767（對稱、不溢位）。
 */
function floatToInt16(sample: number): number {
  if (!Number.isFinite(sample)) return 0;
  const clamped = sample < -1 ? -1 : sample > 1 ? 1 : sample;
  return Math.round(clamped * 32767);
}
