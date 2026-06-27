// WAV 解析與依位元組切片（給 Groq Whisper 後援轉錄用：超過單次上限的長錄音切成多段）。
// 只支援 PCM16（與本專案錄音一致：16kHz/單聲道/16-bit）；非 PCM16 或無法解析時回 null，
// 由呼叫端退回「整檔單次請求」（小檔不受影響）。

export interface WavFormat {
  sampleRate: number;
  numChannels: number;
  bitsPerSample: number;
  data: Buffer; // 純 PCM 資料（不含 header）
}

export interface WavChunk {
  wav: Buffer; // 自帶 44-byte header、可獨立送轉錄的 WAV
  startSec: number; // 此片段在整段錄音中的起始秒數（給時間戳位移）
}

/** 解析 RIFF/WAVE，掃描 chunk 取 fmt 與 data；只接受 PCM16，否則回 null。 */
export function parseWavPcm(buf: Buffer): WavFormat | null {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    return null;
  }
  let fmt: { audioFormat: number; numChannels: number; sampleRate: number; bitsPerSample: number } | null = null;
  let data: Buffer | null = null;
  let p = 12;
  while (p + 8 <= buf.length) {
    const id = buf.toString("ascii", p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    const body = p + 8;
    if (id === "fmt " && body + 16 <= buf.length) {
      fmt = {
        audioFormat: buf.readUInt16LE(body),
        numChannels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      data = buf.subarray(body, Math.min(body + size, buf.length));
    }
    p = body + size + (size % 2); // chunk 以偶數位元組對齊
  }
  if (!fmt || !data) return null;
  if (fmt.audioFormat !== 1 || fmt.bitsPerSample !== 16) return null; // 只支援未壓縮 PCM16
  return { sampleRate: fmt.sampleRate, numChannels: fmt.numChannels, bitsPerSample: fmt.bitsPerSample, data };
}

/** 把純 PCM 資料包成可獨立播放/轉錄的 WAV（44-byte header）。 */
export function wrapPcmAsWav(pcm: Buffer, sampleRate: number, numChannels: number, bitsPerSample: number): Buffer {
  const blockAlign = numChannels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(numChannels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(byteRate, 28);
  h.writeUInt16LE(blockAlign, 32);
  h.writeUInt16LE(bitsPerSample, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/**
 * 依位元組上限把 WAV 切成多段（每段自帶 header、附起始秒數）。
 * 切點對齊整數個 frame（blockAlign），避免破壞取樣。
 * 檔案在上限內、或非 PCM16 無法解析時，回單一段（原始 buffer、startSec=0）→ 呼叫端照舊單次送。
 */
export function chunkWavByBytes(buf: Buffer, maxBytes: number): WavChunk[] {
  const parsed = parseWavPcm(buf);
  if (!parsed || buf.byteLength <= maxBytes) return [{ wav: buf, startSec: 0 }];

  const { sampleRate, numChannels, bitsPerSample, data } = parsed;
  const blockAlign = numChannels * (bitsPerSample / 8);
  const bytesPerSec = sampleRate * blockAlign;

  let maxDataBytes = maxBytes - 44; // 扣掉每段自己的 header
  maxDataBytes -= maxDataBytes % blockAlign; // 對齊 frame
  if (maxDataBytes < blockAlign) maxDataBytes = blockAlign;

  const chunks: WavChunk[] = [];
  for (let off = 0; off < data.length; off += maxDataBytes) {
    const slice = data.subarray(off, Math.min(off + maxDataBytes, data.length));
    chunks.push({
      wav: wrapPcmAsWav(slice, sampleRate, numChannels, bitsPerSample),
      startSec: off / bytesPerSec,
    });
  }
  return chunks;
}
