// ── 瀏覽器麥克風錄音 → 16kHz 單聲道 WAV（base64）──
// 用 getUserMedia + Web Audio 擷取 Float32，停止時降採樣到 16kHz、編成 WAV、轉 base64，
// 交給 sidecar /transcribe 給 Gemini 轉錄。瀏覽器有直接麥克風存取，不靠 FFmpeg/dshow。

let stream: MediaStream | null = null;
let audioCtx: AudioContext | null = null;
let source: MediaStreamAudioSourceNode | null = null;
let processor: ScriptProcessorNode | null = null;
let mute: GainNode | null = null;
let chunks: Float32Array[] = [];
let inputSampleRate = 48000;
let liveWs: WebSocket | null = null;

const LIVE_WS_URL = "ws://127.0.0.1:8765/live";

export function isRecording(): boolean {
  return stream !== null;
}

/**
 * 開始錄音。權限被拒 / 無裝置會丟出清楚的繁中錯誤。
 * 傳入 onLiveText 即啟用「即時粗稿」：錄音中同步把音訊串流給 sidecar 轉接 Gemini Live，
 * 邊講邊回傳文字。停止後仍會用整檔做精修轉錄（見 stopRecording）。
 */
export async function startRecording(opts?: { onLiveText?: (text: string) => void }): Promise<void> {
  if (stream) throw new Error("已在錄音中");
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
  } catch (e) {
    const name = (e as DOMException)?.name;
    if (name === "NotAllowedError") throw new Error("麥克風權限被拒，請在瀏覽器允許後重試");
    if (name === "NotFoundError") throw new Error("找不到可用的麥克風");
    throw new Error("無法開啟麥克風：" + String(e));
  }
  audioCtx = new AudioContext();
  inputSampleRate = audioCtx.sampleRate;
  source = audioCtx.createMediaStreamSource(stream);
  processor = audioCtx.createScriptProcessor(4096, 1, 1);
  // 靜音節點：ScriptProcessor 要連到 destination 才會觸發 onaudioprocess，
  // 但接 gain=0 才不會把自己的聲音播出來（避免回授）。
  mute = audioCtx.createGain();
  mute.gain.value = 0;
  chunks = [];

  if (opts?.onLiveText) openLive(opts.onLiveText);

  processor.onaudioprocess = (ev) => {
    const block = new Float32Array(ev.inputBuffer.getChannelData(0));
    chunks.push(block); // 累積供停止後整檔精修
    if (liveWs && liveWs.readyState === WebSocket.OPEN) {
      liveWs.send(floatToPcm16le(resampleTo16k(block, inputSampleRate))); // 即時粗稿串流
    }
  };
  source.connect(processor);
  processor.connect(mute);
  mute.connect(audioCtx.destination);
}

/** 開即時逐字稿的 WebSocket；失敗不影響錄音與最終轉錄（粗稿只是加值）。 */
function openLive(onText: (text: string) => void): void {
  try {
    liveWs = new WebSocket(LIVE_WS_URL);
    liveWs.binaryType = "arraybuffer";
    liveWs.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      try {
        const m = JSON.parse(ev.data) as { type?: string; text?: string };
        if (m.type === "text" && m.text) onText(m.text);
      } catch {
        /* 忽略非預期訊息 */
      }
    };
    liveWs.onerror = () => {
      /* 即時稿失敗就靜默放棄，停止後仍有整檔精修 */
    };
  } catch {
    liveWs = null;
  }
}

/** 停止錄音，回傳 16kHz 單聲道 WAV 的 base64。 */
export async function stopRecording(): Promise<{ base64: string; mimeType: string; durationSec: number }> {
  if (!stream || !audioCtx) throw new Error("尚未開始錄音");
  if (liveWs) {
    try {
      liveWs.close();
    } catch {
      /* ignore */
    }
    liveWs = null;
  }
  processor?.disconnect();
  mute?.disconnect();
  source?.disconnect();
  stream.getTracks().forEach((t) => t.stop());
  const sr = inputSampleRate;
  const merged = mergeChunks(chunks);
  await audioCtx.close();
  stream = null;
  audioCtx = null;
  source = null;
  processor = null;
  mute = null;
  chunks = [];

  const samples16k = resampleTo16k(merged, sr);
  const wav = encodeWav16(samples16k, 16000);
  return {
    base64: bytesToBase64(new Uint8Array(wav)),
    mimeType: "audio/wav",
    durationSec: samples16k.length / 16000,
  };
}

// ─────────────── 內部工具 ───────────────

function mergeChunks(parts: Float32Array[]): Float32Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** 線性插值降採樣到 16kHz。 */
function resampleTo16k(input: Float32Array, fromRate: number): Float32Array {
  if (fromRate === 16000 || input.length === 0) return input;
  const ratio = 16000 / fromRate;
  const outLen = Math.round(input.length * ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i / ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = input[Math.min(idx, input.length - 1)];
    const b = input[Math.min(idx + 1, input.length - 1)];
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/** Float32(-1..1) → Int16LE PCM 原始位元組（即時串流用，無 WAV 標頭）。 */
function floatToPcm16le(samples: Float32Array): ArrayBuffer {
  const buf = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

/** Float32(-1..1) → 16-bit PCM WAV（含 44 byte 標頭）。 */
function encodeWav16(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return buffer;
}

/** Uint8Array → base64（分段避免大陣列爆 call stack）。 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
