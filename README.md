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
| LLM（摘要/分析/翻譯） | 三選一（`LLM_PROVIDER`）：**Gemini**（現用預設、雲端免費額度、中文強）/ 本地 Ollama（程式內建 fallback、$0 離線）/ Claude（付費）。**轉錄／即時逐字稿／AI 助理對話固定走 Gemini**（需 `GEMINI_API_KEY`） |
| 音訊修復 | `fluent-ffmpeg` + `ffmpeg-static` |
| 匯出 Office | `docx`（Word）/ `exceljs`（Excel）/ `pptxgenjs`（PPT），瀏覽器端離線產檔、動態載入 |

---

## 目錄結構

```
Leo work/
├── src/                          # 前端 webview（React）
│   ├── App.tsx / main.tsx        # 頂部分頁：工作區 / 🦉 記憶聊天
│   ├── components/               # Workspace / HistoryRail / TranscriptPanel / AnalysisPanel / ChatAssistant / MemoryChat
│   ├── lib/api.ts                # → sidecar 的型別化 HTTP 客戶端
│   └── shared/types.ts           # 前後端共用型別契約
├── src/server.ts                 # Node sidecar：把服務包成 HTTP API
├── src/services/                 # 五大服務（只在 Node 跑）
│   ├── SecurityManager.ts        # 階段一：AES-256-GCM 加解密
│   ├── AudioRepair.ts            # 階段一：FFmpeg 標頭修復
│   ├── TextSplitter.ts           # 階段二：滑動視窗切片
│   ├── EmbeddingService.ts       # 階段二：本地 ONNX 嵌入
│   ├── VectorStore.ts            # 階段二：LanceDB 向量檢索
│   ├── GeminiLlmService.ts       # 階段三（現用預設）：分析/翻譯 + 整檔轉錄 + AI 助理對話
│   ├── OllamaLlmService.ts       # 階段三：本地 LLM 分析 / 翻譯（$0 離線；程式內建 fallback）
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
| 三 | 主動式分析（橫向比對歷史衝突、嚴格 JSON）、行動方針（任務/負責人/截止日，相對日期換算）、保時間戳翻譯 | `GeminiLlmService.ts`（現用預設）/ `OllamaLlmService.ts`（離線免費）/ `ClaudeService.ts`（付費選配） |
| 四 | 完整專案結構、`package.json`、`.env.example` | （本專案整體） |

---

## 會議工作流：錄音 → 逐字稿 → AI 助理

逐字稿面板（`TranscriptPanel.tsx`）的一條龍流程。**需設定 `GEMINI_API_KEY`**（語音與對話走 Google Gemini，有免費額度、不吃 GPU、中文強）。

### 1) 錄音與逐字稿（混合式即時轉錄）
- 按 **🎙 錄音**：瀏覽器 `getUserMedia` 收音（`src/lib/recorder.ts`），不靠 FFmpeg/dshow。
- **錄音中（即時粗稿）**：同一份音源以 16kHz PCM 經 `ws://127.0.0.1:8765/live` 串流給 sidecar，由 `GeminiLiveService.ts` 轉接 **Gemini Live API**（`inputAudioTranscription`），邊講邊出字，顯示在「🔴 即時粗稿」框。
- **按停止（整檔精修）**：對完整錄音呼叫 `/transcribe`（`GeminiLlmService.transcribeAudio`），用乾淨、帶 `[mm:ss] 發言人:`、正確標點/發言人的版本**覆蓋粗稿**並落地。
- 即時粗稿是 STT 原始輸出（可能簡體、字間空格，顯示時已收掉空格）；**最終品質以精修版為準**。
- **15 分鐘 session 上限**：upstream 關閉而本端仍錄音時，`GeminiLiveService` 自動重連續錄，空窗期音訊先緩衝、`setupComplete` 後補送。

> 為何用「混合式」而非每分鐘切塊：切塊會切爛斷句、發言人標籤跨塊錯亂、時間戳誤差累積。串流即時稿 + 停止後整檔精修，兼得即時感與最終品質。

### 2) 轉錄語言（精修版輸出）
逐字稿面板右上下拉，控制停止後精修版的輸出語言：

| 選項 | 行為 |
|---|---|
| 自動（預設） | 用原始說話語言；**非中文句在後面用全形括號附繁中翻譯**（英文會議 → 英文逐字稿＋中譯） |
| 一律繁中 | 不論原語言都轉繁體中文 |
| 一律英文 | 一律轉英文 |

### 3) 🦉 AI 助理（聊天 ＋ 討論完匯出，單一面板）
底部「🦉 AI 助理」面板（`ChatAssistant.tsx`，可收合／可放大，預設展開、為主互動區）：
- **聊天**：對話式問當前逐字稿，並結合**跨會議記憶**（向量檢索）回答；走 `/chat`（`GeminiLlmService.chat`），記得多輪對話脈絡。
- **匯出**：面板上方匯出列 📋複製、⬇.md、**📄Word / 📊Excel / 📽PPT**。聊／討論完直接從這裡產出（詳見第 5 節）。
- 此面板整合自原本分散的「AI 助理」與「與 AI 討論這份文件」兩個功能重複的面板；分析結果面板（`AnalysisPanel.tsx`）回歸純顯示主題/摘要/衝突/行動方針。

### 4) 翻譯
逐字稿可一鍵翻譯成 en / ja / ko / zh，保留 `[mm:ss] 發言人:` 格式（`/translate`）。

### 5) 匯出會議記錄（.md / Word / Excel / PPT，可 AI 客製）
在 🦉 AI 助理面板上方匯出列：📋複製、⬇.md，以及 **📄 Word / 📊 Excel / 📽 PPT**（需先按「分析」有結果才可匯出）。
- 產檔在**瀏覽器端用離線套件直接下載**（`src/lib/exporters.ts`：`docx` / `exceljs` / `pptxgenjs`），產檔庫**動態載入**（按鈕才載、切成獨立 chunk），初始啟動維持輕量。
- **共用中介模型 `ComposedDoc`**（heading/paragraph/bullets/table 區塊，定義於 `shared/types.ts`）→ 三種格式都從同一份區塊渲染。
- **預設範本（沒跟 AI 討論就直接匯出）**：本機把分析結果排版，零 API。Word＝完整記錄含逐字稿；Excel＝概要＋各表獨立工作表；PPT＝封面＋每節一張投影片。
- **AI 客製（與 AI 討論完再產出）**：先在助理裡多輪跟 Gemini 討論要怎麼整理 → 點格式鈕 → sidecar `/export/compose` 交 **Gemini**（`composeExportDoc`，responseSchema 強制 JSON）依「**討論脈絡(history)** ＋格式＋會議資料」重組成 `ComposedDoc` 再渲染。只打一句沒送出也算最後指示（等於一次性客製）。例：「PPT 只放結論和數字」「Word 公文語氣加風險建議」「Excel 行動方針多一欄優先級」。需 `GEMINI_API_KEY`，產檔時多一次 Gemini 呼叫（免費額度內）。
- **圖表（PPT）**：`ComposedDoc` 有 `chart` 區塊型別，PPT 用 `pptxgenjs` 渲染成**原生可編輯圖表**（Word/Excel 退化成資料表，不丟資料）。但 Gemini 常不主動選 chart、且結構化輸出偶發 RECITATION 過濾 → 因此**主要靠「自動把數值表格畫成圖」**：只要 AI 把數字整理成 table（第一欄項目＋其餘欄純數值，這它很穩），`exporters.ts` 的 `tableToChart` 就在 PPT 自動補一張圖表投影片（單欄→圓餅、多欄→長條）。所以「畫成圖」要走 PPT。
- **韌性**：AI 重組失敗（過載／RECITATION 空回應）時，前端**自動退回預設範本**匯出，至少產得出檔、不會卡住（會提示可再試一次）。

### 6) 整頁「記憶聊天」（跨會議記憶）
App 頂部分頁「🦉 記憶聊天」（`MemoryChat.tsx`，不掛 `RouterPanel`）：純跨會議記憶問答，**不綁當前會議**。
- 空狀態＝歡迎 hero（標題「Leo work 可以幫您做些什麼？／您的記憶在內」+ 大圓角輸入框 + 11 張帶 icon/說明的建議卡）；有對話＝訊息串 + 底部輸入列，可「＋新對話」回首頁。
- 與底部 AI 助理同走 `/chat`，差別是 `transcript:""`（無當前逐字稿、純向量檢索跨會議記憶）。

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
- `LLM_PROVIDER`：`ollama`（免費、離線）/ `gemini`（雲端、有免費額度、不吃 GPU、中文強）/ `claude`（付費）
- `OLLAMA_LLM_MODEL`：預設 `qwen2.5:3b`（無 GPU 友善）
- `ENCRYPTION_SALT`：金鑰推導 salt（**請改成隨機長字串；變更後舊加密檔無法解密**）
- `LOCAL_DB_PATH`：LanceDB 路徑（預設 `./data/lancedb`）
- `EMBEDDING_PROVIDER`：`local`（預設、離線）/ `openai` / `ollama`
- `SIDECAR_PORT`：預設 `8765`
- `GEMINI_API_KEY`：**錄音轉錄 / 即時逐字稿 / AI 助理對話所需**（Google AI Studio 申請，有免費額度；與 `LLM_PROVIDER` 無關，這三項功能固定走 Gemini）
- `GEMINI_MODEL`：對話 / 分析 / 整檔轉錄模型，程式碼預設常數 `gemini-2.5-flash`（目前 `.env` 為 `gemini-3.5-flash`）。**LLM 與 STT 共用此變數**——改它會一次換掉分析/翻譯＋轉錄/聊天
- `GEMINI_LIVE_MODEL`：即時逐字稿用的 Live 模型，預設 `gemini-3.1-flash-live-preview`（只支援 AUDIO 輸出，逐字稿走 `inputAudioTranscription`）
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

> **版面（重要）**：`RouterPanel.tsx` 拆成兩塊 — **`RouterBar`**（狀態燈＋三來源切換＋停止＋VU，**併進頂部 header**，省一條橫列）與 **`RouterDetails`**（手機 QR／藍牙進度／即時逐字稿，放在 header 下方、**無內容時不顯示**）。兩者共用 zustand 音訊 store。
>
> **目前面板接線（重要）**：三來源為 **🖥️ 電腦系統 / 📱 手機收音 / 🔵 藍牙同步**。
> - **📱 手機收音** 走上方「雙源收音」那套**已測試的 WSS 手機橋接**（`PhoneBridgeServer`，自簽 HTTPS + QR + token），**不是 WebRTC**；點選後面板顯示 QR 供手機掃描（以 `CaptureSourceAdapter(phoneBridge,"webrtc")` 接進 router）。`WebRtcSoftwareSource` 與 `/webrtc/*` 信令**保留**為未來「真 WebRTC」備援接點。
> - **即時逐字稿來源**：設了 `WHISPER_BIN`/`WHISPER_MODEL_PATH` → 本地 whisper（`StreamingTranscriber`）；否則有 `GEMINI_API_KEY` → **Gemini Live**（`GeminiStreamingTranscriber`）即時出粗稿。兩者皆無才不出字 → 所以**電腦系統／手機收音不裝 whisper 也能看到逐字稿**。
> - **停止後整檔精修帶入會議**：對「電腦系統 / 手機收音」按停止後，工作區會出現「✨ 精修並帶入會議」（`POST /router/transcribe`）——把整段收音（router 累積的 AGC 後 PCM 編成 WAV）交 Gemini 整檔精修成乾淨繁體稿（含 `[mm:ss]` 與發言人）填入會議逐字稿，再 💾 存檔 / 分析。即時粗稿（可能簡體/語言漂移）只是預覽，**精修版才是可存檔的最終稿**。精修失敗（限流/斷網）會保留錄音供重試，不會白收。

### 關鍵現實（已在程式中誠實處理）
- **`bluer` 是 Linux 專用** → 不用；BLE 走 Node `noble`，且因其為原生套件、Windows 安裝易失敗，改成 **`BleTransport` 介面 + 動態 import**（缺席給明確錯誤，不拖垮 install/typecheck）。
- **PM01-9 的藍牙 GATT 協定為裝置私有** → 續傳邏輯與裝置解耦（自定 framing），UUID 走 env 佔位，標為整合點。
- **Node 沒有 Rust 的真執行緒** → 用 `AsyncMutex`（FIFO 序列化 async 臨界區）對應規格的 `Arc<Mutex>` 語意，防止狀態切換/音訊寫入交錯。
- WebRTC 端到端需真實瀏覽器 peer 才能跑；**重組佇列、續傳、路由狀態機/優先權都有單元測試**。

## 驗證狀態（本次交付，皆實際執行）

- ✅ 前端型別檢查 `tsc -p tsconfig.json` → exit 0
- ✅ Sidecar 型別檢查 `tsc -p tsconfig.sidecar.json` → exit 0
- ✅ 單元 / 整合測試 `vitest run` → **95/95 通過**，含：
  - 雙軌：重組佇列(6)、Router 四態+優先權+AsyncMutex+整檔精修錄音緩衝(23)、斷點續傳含斷線重連 RESUME/逾時(14)
  - **Gemini 即時轉寫器（注入假 Live 後端）(7)**：lazy 開 session、PCM→base64、flush 成 segment、CJK 空格收尾、reset 重開、無金鑰 no-op
  - 加密 round-trip、錯誤金鑰、竄改偵測（6）
  - 滑動視窗切片重疊 / 時間回填（6）
  - WAV 編碼標頭 / clamp（5）
  - AGC 增益收斂 / 不削波、VU、同步去重補位、引擎協調（25）
  - **手機橋接整合測試（3）**：真起 WSS server、Token 驗證、二進位幀解析、錯誤 token 拒絕
- ✅ 前端打包 `vite build` → exit 0
- ✅ 改名 Leo work + LLM 改 Gemini 預設後重跑：型別檢查 ×2、vitest 全綠、build 仍全綠
- ⏳ Tauri 外殼編譯：需 Rust + MSVC（本機未裝）。重服務都在 Node sidecar，桌面外殼僅薄薄一層。
- ⏳ 系統混音 / 手機端 / Whisper / Ollama 的「實機」行為需有 loopback 裝置 / 實體手機 / whisper 執行檔 / 已啟動的 Ollama 才能跑（純邏輯已測；外部相依部分為執行期）。

---

## 已知限制 / 後續

- **Whisper 轉寫**：已透過雙源收音的 `StreamingTranscriber.ts` 接上（spawn whisper.cpp 執行檔，路徑走 `WHISPER_BIN`/`WHISPER_MODEL_PATH`；未設定則略過不報錯）。產出的逐字稿經 `/events` 即時推給前端，亦可接進 `/ingest` 建立跨會議記憶。需自備 whisper.cpp 執行檔與 ggml 模型。
  - **未裝 whisper 時的替代**：若有 `GEMINI_API_KEY`，router 自動改用 `GeminiStreamingTranscriber`（Gemini Live）即時出粗稿 → 電腦系統／手機收音不裝 whisper 也能看到逐字稿（雲端、需網路；屬即時粗稿，非整檔精修）。
- **正式版 sidecar 打包**：`npm run build:sidecar` 產出 `server.cjs`；要隨 Tauri 打包，需將其（連同 node 或用 `pkg`/`bun --compile` 包成單一執行檔）設為 Tauri `externalBin` 並於 `lib.rs` 以 shell plugin spawn。目前 dev 由 `concurrently` 啟動。
- 首次使用 `local` 嵌入會自動下載 all-MiniLM 模型到本地快取（之後離線）。
- macOS 打包的 `icon.icns` 未附；在 mac 上以 `npm run tauri icon` 產生。
- **Gemini 暫時過載自動重試**：`GeminiLlmService` 對 **5xx 伺服器過載**（如「This model is currently experiencing high demand」）退避重試最多 2 次（0.8s、1.6s）。**429 不重試**——429 多為免費額度/限流用盡（`free_tier_requests`），再打只會更快燒光額度且短退避救不了，直接回報請使用者稍候 1 分鐘或換模型（改 `.env` `GEMINI_MODEL`）。
- **Gemini RECITATION 空回應**：`gemini-3.5-flash`（thinking 模型）結構化輸出偶發觸發「疑似抄襲」安全過濾（HTTP 200 但 content 空、`finishReason:RECITATION`，多為誤判），約 1/3 機率。`generate()` 遇空回應**自動換一次再試最多 3 次**壓低機率；匯出端再加一層退回預設範本，確保不卡死。圖表因此不直接依賴 Gemini 主動畫，改走「數值表格自動轉圖」更穩。
