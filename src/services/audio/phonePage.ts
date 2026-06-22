// ════════════════════════════════════════════════════════════════════
//  手機端收音網頁（由 PhoneBridgeServer 的 GET /m 提供）
//
//  純前端原生 JS（不經打包），整段寫在 <script> 內。流程：
//    1. 從 URL query 取 token，連 wss://<location.host>/ws?token=<token>
//    2. getUserMedia 取麥克風（開 echoCancellation / noiseSuppression / AGC）
//    3. AudioContext + ScriptProcessorNode 取 Float32
//    4. 降採樣到 16kHz、轉 Int16，每約 100ms 組成二進位幀送出
//
//  二進位幀格式（與 PhoneBridgeServer 嚴格對齊）：
//    [uint32 LE seq][float64 LE timestampMs][Int16 LE PCM 16kHz mono...]
//    前 4 bytes = seq，接 8 bytes = timestampMs，其餘為 Int16 樣本。
//
//  seq 在整個頁面生命週期內單調遞增，斷線自動重連時「不歸零」，
//  交由 sidecar 端的 AudioSync 做去重與時間軸對齊。
// ════════════════════════════════════════════════════════════════════

/** 手機端網頁的完整 HTML 字串。 */
export const PHONE_PAGE_HTML: string = String.raw`<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<title>語音轉文字 手機收音</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  html, body {
    margin: 0; padding: 0; height: 100%;
    background: #0b0f17; color: #e8edf5;
    font-family: -apple-system, "PingFang TC", "Microsoft JhengHei", system-ui, sans-serif;
  }
  .wrap {
    min-height: 100%; display: flex; flex-direction: column;
    align-items: center; justify-content: center; gap: 28px; padding: 24px;
  }
  h1 { font-size: 20px; font-weight: 600; margin: 0; letter-spacing: 0.5px; }
  .status {
    display: flex; align-items: center; gap: 10px;
    font-size: 15px; padding: 8px 16px; border-radius: 999px;
    background: rgba(255,255,255,0.06); transition: background 0.3s;
  }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: #6b7280; transition: background 0.3s; }
  .dot.on { background: #22c55e; box-shadow: 0 0 8px #22c55e; }
  .dot.err { background: #ef4444; box-shadow: 0 0 8px #ef4444; }
  .dot.wait { background: #f59e0b; box-shadow: 0 0 8px #f59e0b; }
  button#toggle {
    width: 220px; height: 220px; border-radius: 50%; border: none;
    font-size: 26px; font-weight: 700; color: #fff; cursor: pointer;
    background: linear-gradient(145deg, #2563eb, #1d4ed8);
    box-shadow: 0 12px 32px rgba(37,99,235,0.45);
    transition: transform 0.1s, background 0.3s, box-shadow 0.3s;
    touch-action: manipulation;
  }
  button#toggle:active { transform: scale(0.96); }
  button#toggle.recording {
    background: linear-gradient(145deg, #dc2626, #b91c1c);
    box-shadow: 0 12px 32px rgba(220,38,38,0.45);
  }
  button#toggle:disabled { opacity: 0.5; cursor: not-allowed; }
  .vu {
    width: 240px; height: 14px; border-radius: 999px; overflow: hidden;
    background: rgba(255,255,255,0.08);
  }
  .vu > div {
    height: 100%; width: 0%;
    background: linear-gradient(90deg, #22c55e, #eab308, #ef4444);
    transition: width 0.08s linear;
  }
  .hint { font-size: 13px; color: #94a3b8; text-align: center; max-width: 280px; line-height: 1.6; }
</style>
</head>
<body>
<div class="wrap">
  <h1>語音轉文字 手機收音</h1>
  <div class="status">
    <span class="dot" id="dot"></span>
    <span id="statusText">未連線</span>
  </div>
  <button id="toggle" disabled>開始傳送</button>
  <div class="vu"><div id="vuBar"></div></div>
  <div class="hint" id="hint">請允許麥克風權限後，按下按鈕開始將手機收音傳回電腦。</div>
</div>
<script>
(function () {
  "use strict";

  // ─── 內部標準取樣率（與 sidecar 的 TARGET_SAMPLE_RATE 對齊）───
  var TARGET_RATE = 16000;
  // 每幀約 100ms：16000 * 0.1 = 1600 樣本，達成 <200ms 低延遲
  var FRAME_SAMPLES = 1600;
  var HEADER_BYTES = 12; // uint32 seq(4) + float64 timestampMs(8)

  // ─── DOM ───
  var dot = document.getElementById("dot");
  var statusText = document.getElementById("statusText");
  var toggleBtn = document.getElementById("toggle");
  var vuBar = document.getElementById("vuBar");
  var hint = document.getElementById("hint");

  // ─── 從 URL query 取 token ───
  var token = new URLSearchParams(location.search).get("token") || "";

  // ─── 狀態 ───
  var ws = null;
  var audioCtx = null;
  var mediaStream = null;
  var sourceNode = null;
  var processor = null;
  var sending = false;        // 使用者是否按下「開始傳送」
  var seq = 0;                // 全頁面生命週期單調遞增，重連不歸零
  var reconnectTimer = null;
  var srcRate = TARGET_RATE;  // 麥克風實際取樣率，建 AudioContext 後得知
  var resampleResidual = 0;   // 降採樣的小數位置殘留（跨幀連續，避免相位跳動）
  var pendingInt16 = [];      // 已降採樣、尚未湊滿一幀的 Int16 樣本緩衝

  function setStatus(text, cls) {
    statusText.textContent = text;
    dot.className = "dot" + (cls ? " " + cls : "");
  }

  // ─── WebSocket 連線（含自動重連）───
  function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    if (!token) { setStatus("缺少 token，無法連線", "err"); return; }

    setStatus("連線中…", "wait");
    var url = "wss://" + location.host + "/ws?token=" + encodeURIComponent(token);
    try {
      ws = new WebSocket(url);
    } catch (e) {
      setStatus("連線失敗，重試中…", "err");
      scheduleReconnect();
      return;
    }
    ws.binaryType = "arraybuffer";

    ws.onopen = function () {
      setStatus(sending ? "收音中" : "已連線（待命）", "on");
    };
    ws.onclose = function () {
      setStatus("連線中斷，重試中…", "wait");
      ws = null;
      scheduleReconnect();
    };
    ws.onerror = function () {
      // onerror 後瀏覽器一定會接著觸發 onclose，由 onclose 統一處理重連
      setStatus("連線錯誤", "err");
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      connect();
    }, 1500);
  }

  // ─── 啟動麥克風與音訊處理鏈 ───
  function startAudio() {
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false
    }).then(function (stream) {
      mediaStream = stream;
      var Ctx = window.AudioContext || window.webkitAudioContext;
      audioCtx = new Ctx();
      srcRate = audioCtx.sampleRate;
      resampleResidual = 0;
      pendingInt16 = [];

      sourceNode = audioCtx.createMediaStreamSource(stream);
      // ScriptProcessorNode 相容性最好（iOS Safari / Android Chrome 皆穩）
      processor = audioCtx.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = onAudio;
      sourceNode.connect(processor);
      // 不接到 destination 以免回授，但部分瀏覽器需有下游節點才會驅動 callback，
      // 故接到 0 增益節點當「黑洞」維持時脈。
      var sink = audioCtx.createGain();
      sink.gain.value = 0;
      processor.connect(sink);
      sink.connect(audioCtx.destination);
    });
  }

  function stopAudio() {
    if (processor) { try { processor.disconnect(); } catch (e) {} processor.onaudioprocess = null; processor = null; }
    if (sourceNode) { try { sourceNode.disconnect(); } catch (e) {} sourceNode = null; }
    if (mediaStream) { mediaStream.getTracks().forEach(function (t) { t.stop(); }); mediaStream = null; }
    if (audioCtx) { try { audioCtx.close(); } catch (e) {} audioCtx = null; }
    pendingInt16 = [];
    vuBar.style.width = "0%";
  }

  // ─── 每塊原始音訊：降採樣 → Int16 → 湊幀 → 送出 ───
  function onAudio(ev) {
    var input = ev.inputBuffer.getChannelData(0); // Float32 -1..1

    // VU：本塊峰值（不論是否在送出都顯示，給使用者回饋）
    var peak = 0;
    for (var i = 0; i < input.length; i++) {
      var a = input[i] < 0 ? -input[i] : input[i];
      if (a > peak) peak = a;
    }
    vuBar.style.width = Math.min(100, Math.round(peak * 140)) + "%";

    if (!sending) return; // 未按開始：不收集、不送

    // 線性內插降採樣到 16kHz（殘留相位跨塊連續，避免每塊邊界爆音）
    var ratio = srcRate / TARGET_RATE;
    var pos = resampleResidual;
    while (pos < input.length) {
      var idx = Math.floor(pos);
      var frac = pos - idx;
      var s0 = input[idx];
      var s1 = idx + 1 < input.length ? input[idx + 1] : input[idx];
      var sample = s0 + (s1 - s0) * frac;
      var v = Math.max(-1, Math.min(1, sample));
      pendingInt16.push(v < 0 ? v * 0x8000 : v * 0x7fff);
      pos += ratio;
    }
    resampleResidual = pos - input.length; // 帶到下一塊

    // 湊滿一幀（~1600 樣本）就送
    while (pendingInt16.length >= FRAME_SAMPLES) {
      var frame = pendingInt16.splice(0, FRAME_SAMPLES);
      sendFrame(frame);
    }
  }

  // ─── 組裝二進位幀並送出 ───
  function sendFrame(int16Arr) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    var n = int16Arr.length;
    var buf = new ArrayBuffer(HEADER_BYTES + n * 2);
    var dv = new DataView(buf);
    dv.setUint32(0, seq >>> 0, true);              // uint32 LE seq
    dv.setFloat64(4, Date.now(), true);            // float64 LE timestampMs
    for (var i = 0; i < n; i++) {
      dv.setInt16(HEADER_BYTES + i * 2, int16Arr[i] | 0, true); // Int16 LE
    }
    seq = (seq + 1) >>> 0; // 維持 uint32 範圍，連續遞增
    try { ws.send(buf); } catch (e) { /* 送出失敗交由 onclose 重連處理 */ }
  }

  // ─── 開始 / 停止 切換 ───
  function startSending() {
    sending = true;
    toggleBtn.textContent = "停止傳送";
    toggleBtn.classList.add("recording");
    hint.textContent = "收音中：手機麥克風的聲音正即時傳回電腦。";
    if (ws && ws.readyState === WebSocket.OPEN) setStatus("收音中", "on");
  }

  function stopSending() {
    sending = false;
    pendingInt16 = [];
    toggleBtn.textContent = "開始傳送";
    toggleBtn.classList.remove("recording");
    hint.textContent = "已暫停傳送。再按一次可繼續。";
    if (ws && ws.readyState === WebSocket.OPEN) setStatus("已連線（待命）", "on");
    vuBar.style.width = "0%";
  }

  toggleBtn.addEventListener("click", function () {
    if (!audioCtx) {
      // 首按：要求麥克風權限並建立音訊鏈（須在使用者手勢內，iOS 才放行）
      toggleBtn.disabled = true;
      startAudio().then(function () {
        toggleBtn.disabled = false;
        startSending();
      }).catch(function (err) {
        toggleBtn.disabled = false;
        setStatus("無法取得麥克風：" + (err && err.name ? err.name : "錯誤"), "err");
        hint.textContent = "請到瀏覽器設定允許此網站使用麥克風後重試。";
      });
      return;
    }
    // iOS：AudioContext 可能被自動暫停，使用者手勢內 resume
    if (audioCtx.state === "suspended") { audioCtx.resume(); }
    if (sending) stopSending(); else startSending();
  });

  // ─── 進場即連線（音訊待使用者手勢才啟動）───
  connect();
  toggleBtn.disabled = false;

  // 離開頁面時清理
  window.addEventListener("pagehide", function () {
    try { if (ws) ws.close(); } catch (e) {}
    stopAudio();
  });
})();
</script>
</body>
</html>`;

/** 同名函式版本（方便有需要時動態取得）。 */
export function renderPhonePage(): string {
  return PHONE_PAGE_HTML;
}
