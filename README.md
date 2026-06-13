# Leo work

桌面錄音 / AI 會議助理（Windows / macOS）。**全本地、免費、可離線**——融合兩大產品優勢：

- **J-Smart PM01-9**：本地隱私安全、硬體級檔案保護（AES-256-GCM 加密、明文絕不落地）。
- **Proactor 式**：主動式智慧分析、**跨場次全局會議記憶**（向量檢索）、自動化行動方針派發。

> 💰 **預設零成本**：轉錄（Whisper）、嵌入（ONNX）、LLM（Ollama 本地模型）全部在你電腦本地跑，無 API 費用、可離線。Claude API 為選配（`LLM_PROVIDER=claude`，逐 token 計費）。

---

## 架構：Tauri 外殼 + React webview + Node sidecar

```
┌────────────────────────── Tauri 桌面視窗 ──────────────────────────┐
│  React webview (前端 UI)  ──HTTP──►  Node sidecar (重服務)          │
│  src/ (components, lib)             src/server.ts + src/services/   │
└────────────────────────────────────────────────────────────────────┘
```

**為什麼要 sidecar？** Tauri 的前端是 webview，**無法執行 Node 原生套件**（`@lancedb/lancedb`、`@anthropic-ai/sdk`、ONNX runtime、node `crypto` 的 `Buffer`…）。因此所有重服務集中在一個只綁 `127.0.0.1` 的 Node 行程（sidecar），前端透過 `src/lib/api.ts` 以 HTTP 呼叫。這樣既能用成熟的 JS/TS AI 生態，又保有 Tauri 的輕量外殼。

### 技術棧
| 層 | 技術 |
|---|---|
| 桌面外殼 | Tauri v2（Rust） |
| 前端 | Vite + React 18 + TypeScript + Tailwind |
| 重服務 | Node.js（TypeScript）sidecar |
| 加密 | node `crypto` AES-256-GCM + scrypt 金鑰推導 |
| 向量庫 | LanceDB（嵌入式，本地落地） |
| 嵌入 | `@xenova/transformers` ONNX `all-MiniLM-L6-v2`（離線；可切 OpenAI / Ollama） |
| LLM（摘要/分析/翻譯） | **本地 Ollama**（預設 `qwen2.5:3b`，$0、離線）；可選 `@anthropic-ai/sdk` Claude（付費） |
| 音訊修復 | `fluent-ffmpeg` + `ffmpeg-static` |

---

## 目錄結構

```
proactor-recorder/
├── src/                          # 前端 webview（React）
│   ├── App.tsx / main.tsx
│   ├── components/               # Workspace / TranscriptPanel / AnalysisPanel / MemorySearch
│   ├── lib/api.ts                # → sidecar 的型別化 HTTP 客戶端
│   └── shared/types.ts           # 前後端共用型別契約
├── src/server.ts                 # Node sidecar：把服務包成 HTTP API
├── src/services/                 # 五大服務（只在 Node 跑）
│   ├── SecurityManager.ts        # 階段一：AES-256-GCM 加解密
│   ├── AudioRepair.ts            # 階段一：FFmpeg 標頭修復
│   ├── TextSplitter.ts           # 階段二：滑動視窗切片
│   ├── EmbeddingService.ts       # 階段二：本地 ONNX 嵌入
│   ├── VectorStore.ts            # 階段二：LanceDB 向量檢索
│   ├── OllamaLlmService.ts       # 階段三（預設）：本地 LLM 分析 / 行動方針 / 翻譯（$0）
│   ├── ClaudeService.ts          # 階段三（選配）：Claude API 版本（付費）
│   └── __tests__/                # 可實跑的單元測試
├── src-tauri/                    # Tauri 外殼（Rust，極簡）
├── tsconfig.json                 # 前端（DOM）
├── tsconfig.sidecar.json         # sidecar + services（Node）
└── package.json
```

> **兩套 tsconfig**：前端是 DOM 環境、sidecar 是 Node 環境，型別世界不同，故分開檢查（`npm run typecheck` 會兩個都跑）。前端 bundle 永遠不會把 Node 服務打包進去（只透過 HTTP 溝通）。

---

## 四階段功能對照

| 階段 | 規格 | 檔案 |
|---|---|---|
| 一 | AES-256-GCM 加密存儲（IV + AuthTag 防篡改）、記憶體歸零防 dump、FFmpeg 容錯、結構化錯誤碼 | `SecurityManager.ts`、`AudioRepair.ts`、`shared/types.ts`(ErrorCode) |
| 二 | LanceDB 全局記憶、滑動視窗切片（300/50、附時間戳+會議來源）、餘弦相似度跨會議檢索 | `TextSplitter.ts`、`EmbeddingService.ts`、`VectorStore.ts` |
| 三 | 主動式分析（橫向比對歷史衝突、嚴格 JSON）、行動方針（任務/負責人/截止日，相對日期換算）、保時間戳翻譯 | `OllamaLlmService.ts`（預設、本地免費）/ `ClaudeService.ts`（選配） |
| 四 | 完整專案結構、`package.json`、`.env.example` | （本專案整體） |

---

## 快速開始

```powershell
# 1) 一鍵設定（裝依賴、檢查 Rust、產生 .env）
./scripts/setup.ps1

# 2) 安裝本地 LLM（完全免費）：裝 Ollama（https://ollama.com）後下載模型
ollama pull qwen2.5:3b      # 無 GPU 也能跑；硬體夠可改 qwen2.5:7b

# 3) 編輯 .env：把 ENCRYPTION_SALT 改成你自己的長隨機字串（LLM 預設免費 Ollama，無需金鑰）

# 4) 開發模式（Tauri 會同時起 vite + sidecar）
npm run tauri:dev
```

只跑 Web + sidecar（不開 Tauri 視窗，用瀏覽器測）：
```powershell
npm run dev          # concurrently 同時起 vite(1420) 與 sidecar(8765)
```

### 環境變數（`.env`）
- `LLM_PROVIDER`：`ollama`（**預設、免費、離線**）/ `claude`（選配、付費）
- `OLLAMA_LLM_MODEL`：預設 `qwen2.5:3b`（無 GPU 友善）
- `ENCRYPTION_SALT`：金鑰推導 salt（**請改成隨機長字串；變更後舊加密檔無法解密**）
- `LOCAL_DB_PATH`：LanceDB 路徑（預設 `./data/lancedb`）
- `EMBEDDING_PROVIDER`：`local`（預設、離線）/ `openai` / `ollama`
- `SIDECAR_PORT`：預設 `8765`
- `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL`：**只有 `LLM_PROVIDER=claude` 才需要**（Claude API 逐 token 計費；Claude Max 訂閱不涵蓋 API）

---

## 建置與測試

```powershell
npm run typecheck     # 前端 + sidecar 兩套 tsconfig 型別檢查
npm test              # vitest：加密 round-trip / 竄改偵測 / 切片邏輯
npm run build:web     # 前端打包
npm run build:sidecar # 用 esbuild 把 sidecar 打包成 dist-sidecar/server.cjs
npm run tauri:build   # 桌面正式版（需 Rust + MSVC 工具鏈）
```

---

## 安全設計（階段一重點）

- **AES-256-GCM**：每檔隨機 12-byte IV + 16-byte AuthTag；金鑰由 `scrypt(secretKey, ENCRYPTION_SALT)` 推導。檔案格式 `[MAGIC][IV][AuthTag][密文]`。
- **防篡改**：GCM 驗證失敗（金鑰錯/被改）一律拋 `CRYPTO_DECRYPT_FAILED`，不回亂碼。
- **防 memory dump**：敏感資料一律用 `Buffer` 處理，用畢 `.fill(0)` 歸零（推導金鑰、明文緩衝、API 回傳的明文）。註：JS 字串不可變、無法手動清零，故全程避免把明文長期放進字串/全域。
- **結構化錯誤碼**：`ErrorCode`（`AUDIO_HEADER_CORRUPT`、`CRYPTO_DECRYPT_FAILED`…）跨服務一致，前端可據以提示。
- sidecar 只綁 `127.0.0.1`；`.env`、`/data`、`*.enc` 皆已 `.gitignore`。

---

## 雙源收音模組（Dual-Source Audio Capture）

同時支援「電腦本機混音」與「手機跨裝置收音」，統一正規化成單聲道 16kHz Float32 後走
AGC → VU → 同步 → Whisper 管線。檔案位於 `src/services/audio/`。

| 子模組 | 檔案 | 重點 |
|---|---|---|
| 系統混音 | `SystemAudioCapture.ts` | FFmpeg `dshow` 同抓麥克風 + loopback，`amix` 混音 → 16kHz s16le；裝置列舉、無 loopback 自動降級只錄麥克風 |
| 手機橋接 | `PhoneBridgeServer.ts` + `phonePage.ts` | 自簽憑證 **HTTPS/WSS** + Token + QR；手機 `getUserMedia` → 降採樣 16kHz → WS 二進位幀（`[seq][ts][Int16 PCM]`）回傳 |
| 動態增益 | `Agc.ts` | one-pole 平滑增益拉到目標 RMS、靜音凍結防底噪、硬限幅防削波 |
| VU 訊號 | `VuMeter.ts` | RMS / peak / dBFS（前端訊號條資料接口） |
| 時間同步 | `AudioSync.ts` | 依 seq 去重 + 跳號補靜音，**重連不錯位** |
| 引擎協調 | `AudioCaptureEngine.ts` | 來源切換、管線串接、`/events` 推播 vu/status/transcript |
| 串流轉寫 | `StreamingTranscriber.ts` | 滾動視窗 spawn whisper.cpp（`WHISPER_BIN`/`WHISPER_MODEL_PATH`），未設定則略過 |

- 前端：`src/components/AudioSourcePanel.tsx`（來源切換 + QR + 開始/停止）、`VuMeter.tsx`（訊號條），透過 `src/lib/audioApi.ts` 控制與訂閱 `ws://127.0.0.1:8765/events`。
- 控制 API：`GET /audio/devices`、`GET /audio/session`、`POST /audio/start`、`POST /audio/stop`、`GET /audio/status`。

### 兩個現實約束（已在程式中處理）
1. **手機端 `getUserMedia` 需安全環境**：故手機橋接走自簽 HTTPS/WSS，QR 指向 `https://<LAN-IP>:8443`，手機首次需點「信任憑證」。
2. **Windows 系統 loopback**：需「立體聲混音」或 VB-Audio Virtual Cable 等虛擬音源；偵測不到時自動退化為只錄麥克風並提示。

## 雙軌整合引擎（AudioIngestionRouter）

把「實體藍牙同步」與「WebRTC 無線串流」抽象成統一的 `AudioSource`，由 Router 做四態狀態機 + 優先權管理。檔案位於 `src/services/audio/`。

| 子模組 | 檔案 | 重點 |
|---|---|---|
| 統一抽象 | `types.ts` 的 `AudioSource` | `startStream/stopStream/onDataReceived/onError/setPriority`；下游 Whisper 只認這個介面 |
| WebRTC 即時 | `WebRtcSoftwareSource.ts` + `AudioReorderingQueue.ts` | werift PeerConnection 收 Opus → **依序號重組佇列** → opus-decoder → 16kHz；信令 `/webrtc/offer`、`/webrtc/ice` |
| 藍牙同步 | `BluetoothHardwareSource.ts` + `ResumableTransfer.ts` + `NobleBleTransport.ts` | **斷點續傳**（RESUME/ACK framing、亂序/重複/重連）→ 解密 → `onFileSynced` 送批次摘要 |
| 路由協調 | `AudioIngestionRouter.ts` + `AsyncMutex.ts` | 四態狀態機 + **優先權**（WebRTC 串流時藍牙降背景低優先，不掉幀）+ 非同步鎖防並發雙寫 |
| 前端狀態 | `store/audioStore.ts`(**Zustand**) + `RouterPanel.tsx` | `AudioSourceState` 四態、三源切換、藍牙進度條、VU、即時逐字稿 |

### 關鍵現實（已在程式中誠實處理）
- **`bluer` 是 Linux 專用** → 不用；BLE 走 Node `noble`，且因其為原生套件、Windows 安裝易失敗，改成 **`BleTransport` 介面 + 動態 import**（缺席給明確錯誤，不拖垮 install/typecheck）。
- **PM01-9 的藍牙 GATT 協定為裝置私有** → 續傳邏輯與裝置解耦（自定 framing），UUID 走 env 佔位，標為整合點。
- **Node 沒有 Rust 的真執行緒** → 用 `AsyncMutex`（FIFO 序列化 async 臨界區）對應規格的 `Arc<Mutex>` 語意，防止狀態切換/音訊寫入交錯。
- WebRTC 端到端需真實瀏覽器 peer 才能跑；**重組佇列、續傳、路由狀態機/優先權都有單元測試**。

## 驗證狀態（本次交付，皆實際執行）

- ✅ 前端型別檢查 `tsc -p tsconfig.json` → exit 0
- ✅ Sidecar 型別檢查 `tsc -p tsconfig.sidecar.json` → exit 0
- ✅ 單元 / 整合測試 `vitest run` → **84/84 通過**，含：
  - 雙軌：重組佇列(6)、Router 四態+優先權+AsyncMutex(19)、斷點續傳含斷線重連 RESUME/逾時(14)
  - 加密 round-trip、錯誤金鑰、竄改偵測（6）
  - 滑動視窗切片重疊 / 時間回填（6）
  - WAV 編碼標頭 / clamp（5）
  - AGC 增益收斂 / 不削波、VU、同步去重補位、引擎協調（25）
  - **手機橋接整合測試（3）**：真起 WSS server、Token 驗證、二進位幀解析、錯誤 token 拒絕
- ✅ 前端打包 `vite build` → exit 0
- ✅ 改名 Leo work + LLM 改本地 Ollama 後重跑：型別檢查 ×2、84/84、build 仍全綠
- ⏳ Tauri 外殼編譯：需 Rust + MSVC（本機未裝）。重服務都在 Node sidecar，桌面外殼僅薄薄一層。
- ⏳ 系統混音 / 手機端 / Whisper / Ollama 的「實機」行為需有 loopback 裝置 / 實體手機 / whisper 執行檔 / 已啟動的 Ollama 才能跑（純邏輯已測；外部相依部分為執行期）。

---

## 已知限制 / 後續

- **Whisper 轉寫**：已透過雙源收音的 `StreamingTranscriber.ts` 接上（spawn whisper.cpp 執行檔，路徑走 `WHISPER_BIN`/`WHISPER_MODEL_PATH`；未設定則略過不報錯）。產出的逐字稿經 `/events` 即時推給前端，亦可接進 `/ingest` 建立跨會議記憶。需自備 whisper.cpp 執行檔與 ggml 模型。
- **正式版 sidecar 打包**：`npm run build:sidecar` 產出 `server.cjs`；要隨 Tauri 打包，需將其（連同 node 或用 `pkg`/`bun --compile` 包成單一執行檔）設為 Tauri `externalBin` 並於 `lib.rs` 以 shell plugin spawn。目前 dev 由 `concurrently` 啟動。
- 首次使用 `local` 嵌入會自動下載 all-MiniLM 模型到本地快取（之後離線）。
- macOS 打包的 `icon.icns` 未附；在 mac 上以 `npm run tauri icon` 產生。
