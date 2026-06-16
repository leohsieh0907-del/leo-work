<!--
  這是維護 skill 的「備份鏡像」（git 追蹤、有版本歷史）。
  正本（實際被 Claude Code 載入的）在：C:\Users\user\.claude\skills\proactor-recorder\SKILL.md
  正本更新後需手動同步此檔；此檔僅作備份/查閱，放在 .claude/skills 之外以免被當成專案層 skill 重複載入。
  最後同步：2026-06-16
-->

---
name: proactor-recorder
description: 維護「Leo work 桌面錄音 / AI 會議助理」（前身 Proactor Recorder / J-Smart 錄音卡 App，現已改名並搬到 D:\Leo work）——Tauri + React webview + Node sidecar（全 TS）。含本地 AES-256 加密、跨會議向量記憶、錄音→Gemini 轉錄、混合式即時逐字稿（Gemini Live /live WS）、AI 助理聊天、雙源收音（系統混音 + 手機 WSS 橋接）、本地 Whisper 轉寫。只要訊息提到「Leo work」「Proactor」「J-Smart」「錄音卡」「錄音 App」「proactor-recorder」「即時逐字稿 / 逐字稿轉錄 / 轉錄語言」「會議 AI 助理」「雙源收音 / 手機收音 / 系統混音 / VU 訊號條」「會議記憶 / 跨會議檢索」「逐字稿加密 / 防拷」，或要在這個錄音 App 專案裡加功能/修 bug/驗證，都務必使用此 skill。它封裝架構決策、Node sidecar 設計、雙 tsconfig 驗證流程與已知雷，確保改動一致、不重蹈覆轍。與投資系統（昕圳/選股/日報/停損）、Readle 英文學習、璟松旅遊完全無關——那些請用各自的 skill，不要觸發本 skill。
---

# Leo work 桌面錄音 / AI 會議助理 維護

桌面錄音 + AI 會議助理 App（前身為搭配 J-Smart PM01-9 錄音卡的 Proactor Recorder）。此 skill 是維護指南——動手前先讀相關段落，避免重犯已知的坑。

## 專案位置與沿革（重要）

| 項目 | 內容 |
|---|---|
| **現況（唯一活躍）** | **`D:\Leo work\`** — Tauri 外殼 + React webview + **Node sidecar（全 TS）**；獨立 git repo（branch `main`，**無 remote**） |
| 沿革 | 前身 `proactor-recorder`（C:）已**改名為 Leo work 並整個搬到 D:\**；純 Rust 版 `jsmart-recorder` 已**刪除**。C: 兩者皆不存在 |
| 命名 | 產品名「Leo work」；skill id 仍叫 `proactor-recorder`（歷史，沿用即可） |

> ⚠️ 所有路徑、指令一律對 **`D:\Leo work`**。git author 用本機 local 設定（庭晰），repo 無 remote，**不主動 push**。

## ⚠️ 環境硬事實（決定一切）
- 本機有 **Node 24 + npm**，**沒有 Rust/cargo/MSVC/cmake**。
- 所以 **Tauri 外殼（Rust）無法在本機編譯驗證**；只能驗證 TS/Node。
- 之所以選「全 TS + Node sidecar」就是為了能在本機完整驗證（typecheck + 實跑 vitest）。

## Leo work 架構（最重要）

```
Tauri 視窗 ─ React webview(前端) ──HTTP/WS──► Node sidecar(重服務)
            src/(components,lib,shared)        src/server.ts + src/services/
```

**為什麼 sidecar**：Tauri 前端是 webview，**跑不了 Node 套件**（`@lancedb/lancedb`、`@anthropic-ai/sdk`、ONNX、node `crypto` 的 `Buffer`、`ws`…）。故所有重服務放一個只綁 `127.0.0.1` 的 Node 行程，前端用 HTTP（`src/lib/api.ts`、`src/lib/audioApi.ts`）+ `/events` WebSocket 呼叫。

### 核心服務（`src/services/`）
- `SecurityManager.ts` — AES-256-GCM（scrypt 推導、IV+AuthTag、Buffer.fill(0) 防 dump）。`encryptToFile/decryptFromFile`。
- `MeetingStore.ts` — 會議加密存檔/列表/載入/刪除（檔名用 `sha1(id)` 前 16 字避免中文標題碰撞；`_index.enc` 加密索引）。
- `TextSplitter.ts` — 滑動視窗切片（300字/重疊50，附時間戳+meetingId）。
- `EmbeddingService.ts` — ONNX `all-MiniLM-L6-v2`（@xenova/transformers，離線，384維；可切 openai/ollama）。
- `VectorStore.ts` — LanceDB 餘弦相似度跨會議檢索。
- **LLM 三選一（`LLM_PROVIDER`，皆實作 `llm/types.ts` 的 `LlmService`）**：
  - `GeminiLlmService.ts` — **目前預設（`.env` LLM_PROVIDER=gemini）**。Google Gemini REST（`.env` GEMINI_MODEL，現為 `gemini-3.5-flash`；程式碼預設常數仍為 `gemini-2.5-flash`）：主動式分析/行動方針（`responseSchema` 強制 JSON）、保時間戳翻譯、**整檔語音轉錄 `transcribeAudio`（lang: auto/zh/en）**、**AI 助理對話 `chat`**。
  - `OllamaLlmService.ts` — 本地、、離線（寬鬆 JSON 解析）。
  - `ClaudeService.ts` — Claude API（付費、品質最佳）。
  - 註：`transcribeAudio`/`chat` 是 `GeminiLlmService` 專屬（不在 `LlmService` 介面），`server.ts` 用獨立的 `geminiStt` 實例（需 `GEMINI_API_KEY`，與 LLM_PROVIDER 無關）。**`GEMINI_MODEL` 同時被 LLM 實例與 `geminiStt` 共用**——改它會一次換掉分析/翻譯＋轉錄/聊天；若只想把分析升 pro，要另拆 STT 的模型常數，否則 pro 會拖慢/變貴整檔轉錄。查當前金鑰可用型號：`GET /v1beta/models` 濾 `generateContent`（免費層 `gemini-3-pro-preview` 實測 429）。
- `GeminiLiveService.ts` — **混合式即時逐字稿**：轉接 Gemini Live WebSocket，餵 16kHz PCM、讀 `inputAudioTranscription`（見已知雷 #9）。
- `audio/` — **雙源收音模組**（見下）。

### 會議工作流（前端 `src/components/` + sidecar 路由）
- 錄音：`lib/recorder.ts`（瀏覽器 getUserMedia → 16kHz；**同一份音源邊累積整檔、邊串流 `/live` 即時稿**）。
- `TranscriptPanel.tsx` — 🎙錄音（計時）、即時粗稿框、停止後 `/transcribe` 精修覆蓋、**轉錄語言下拉(自動/繁中/英文)**、翻譯。
- `ChatAssistant.tsx` — 🦉**AI 助理（聊天＋討論完匯出，單一面板）**，在工作區底部、可收合／可放大（`big`/`onToggleBig`）、**預設展開**（`Workspace` 的 `chatOpen` 預設 true、`chatBig` 控高度 h-80↔h-[32rem]）。走 `/chat`（當前逐字稿＋跨會議記憶）；面板上方有匯出列(📋/⬇.md/📄Word/📊Excel/📽PPT)，聊/討論完直接產檔（見下「AI 客製匯出」）。**已整合原本分散的「AI 助理」＋「與 AI 討論這份文件」兩個重複面板**（後者原本擠在 `AnalysisPanel` 內，已移除）。
- `MemoryChat.tsx` — 🦉**整頁「記憶聊天」**：空狀態為歡迎 hero（標題「Leo work 可以幫您做些什麼？／您的記憶在內」+ 大圓角輸入框 + 11 張帶 icon/說明的建議卡），有對話則訊息串 + 底部輸入列；走 `/chat` 但 `transcript:""`（無當前會議、純跨會議記憶）。由 `App.tsx` 頂部「工作區 / 🦉 記憶聊天」分頁切換進入（記憶聊天分頁不掛 `RouterPanel`）。建議卡提示詞照客戶截圖原文（部分如「課程/學期/客服來電」資料庫沒有，點了 AI 會回查無）。
- `Workspace.tsx`／`HistoryRail.tsx`／`AnalysisPanel.tsx` — 主畫面、歷史會議欄、**`AnalysisPanel` 純顯示**分析結果（主題/摘要/⚠️衝突/行動方針表；匯出與討論已移到 `ChatAssistant`）。
- `lib/exporters.ts` — **會議記錄匯出 Word/Excel/PPT**：瀏覽器端離線產檔（`docx`/`exceljs`/`pptxgenjs`，零 API、不上傳）。在 `ChatAssistant` 用**動態 import**（按下匯出鈕才載 → 切成獨立 chunk，不拖慢初始啟動）。**統一中介模型 `ComposedDoc`**（heading/paragraph/bullets/table 區塊，定義在 `shared/types.ts`）→ 三格式同一份區塊渲染。`exportDocx/Xlsx/Pptx`＝無指示走 `analysisToComposedDoc` 本機預設範本；`exportComposed(doc,format,d)`＝渲染 AI 回傳的 doc。**注意**：`exceljs` 帶一個 moderate 的 `uuid`(buf 邊界) 傳遞相依（寫檔不用 buf→不受影響）；別用 SheetJS `xlsx`（high 無修補 CVE，已刻意避開）。
- **AI 客製匯出（討論完再產出）**：在 `ChatAssistant`（🦉 AI 助理）裡多輪跟 AI 討論（沿用 `chat()`/`/chat`），上方匯出列點格式鈕 → sidecar `POST /export/compose` → `GeminiLlmService.composeExportDoc`（responseSchema=`COMPOSED_DOC_SCHEMA`，**巢狀 array(rows[][]) Gemini 實測接受**）依「**討論 history**＋格式＋會議資料」重組成 `ComposedDoc` 再渲染。`ComposeExportRequest` 帶 `instruction`(可空)＋`history`(ChatTurn[])；尚未送出的輸入＝最後指示。`aiMode = messages.length>0 || input`，false＝預設範本零 API。compose 走 `geminiStt` 實例（需 `GEMINI_API_KEY`，與 LLM_PROVIDER 無關）。client：`api.ts` 的 `composeExport`。
- `RouterPanel.tsx` **拆成兩個具名匯出**：`RouterBar`（狀態燈＋三來源切換＋停止＋VU，**併進 `App.tsx` 頂部 header**，省一條橫列；`connect()` 在此）＋ `RouterDetails`（手機 QR／藍牙進度／即時逐字稿，render 在 header 下方、**無內容回 null 不顯示**）。兩者共用 zustand store；App 在 `view==="workspace"` 時於 header 放 `RouterBar`、下方放 `RouterDetails`。手機 QR 仍**可收放**（state `qrOpen`）。**已無 default export**（改動 App 的 import）。
- **Gemini 暫時失敗自動重試**：`GeminiLlmService` 的 `fetchGeminiWithRetry`（包住 `generate`/`transcribeAudio`/`chat` 三處 fetch）：① **5xx 過載**退避重試 2 次(0.8s/1.6s)，解「high demand」；② **429 限流**用 `parse429RetryMs` 讀回應 `retryDelay`/「retry in Ns」——**短等待 ≤15s（每分鐘 RPM）就等一下自動再試**、長等待（每日上限）直接回報（`resp.clone()` 讀以保留原 body 給上層）。不空轉硬打燒額度。`generate()` 的空回應(RECITATION)重試 3 次只在 `resp.ok` 時觸發，429 走 fetchGeminiWithRetry 處理、不進該迴圈。**RPM 限流訊息含「Please retry in 8.6s」＝每分鐘窗口非每日用光，等幾秒即可**。
- **省額度／友善錯誤**：`GeminiLlmService.analyzeAll`（schema `ANALYZE_ALL_SCHEMA`）把「主動式分析＋行動方針」**併成 1 個請求**（原本 2 個），`server.ts` `/analyze` 優先用它（`llm.analyzeAll?` 為選配介面方法，Gemini 才有；Ollama/Claude 無→退回分別呼叫 `generateProactiveAnalysis`＋`extractActionItems`）。429 等錯誤經 module 函式 `geminiErrorMessage` 轉**中文友善提示**（每分鐘上限約 N 秒恢復／每日上限約 N 分鐘）。要再省可換 `.env` `GEMINI_API_KEY` 為**另一個 Google 帳號**的 key（免費額度是 per-帳號/專案，同帳號新 key 不增額度）。
- **🕳️ Gemini RECITATION 空回應（重要踩過）**：`gemini-3.5-flash`（thinking 模型）做結構化輸出（responseSchema）時**偶發觸發「疑似抄襲」安全過濾**——HTTP 200 但 `candidates[0].content` 空、`finishReason:"RECITATION"`、亂引維基條目，多為誤判，實測約 1/3。對策：① `generate()` 遇空回應**自動換一次再試最多 3 次**（同 body，靠 temperature/thinking 變異常能過）；② 匯出端（`ChatAssistant.runExport`）AI 失敗/空 blocks **退回預設範本**。別在 prompt 放 JSON 範例（會更容易觸發 RECITATION）。
- **匯出圖表（PPT）**：Gemini 常不主動選 `chart` 區塊、又有 RECITATION → **不依賴它畫圖**。改在 `exporters.ts` 的 `tableToChart`：renderPptx 對「數值表格」（第一欄項目＋其餘欄純數字）**自動補一張圖表投影片**（單欄→pie、多欄→bar，`pptx.addChart` 原生）。提示改成「數字一律放 table」（它做表很穩）。`chart` 區塊型別與 schema 仍保留（AI 真的給就渲染；Word/Excel 退化成 `chartToTable` 資料表）。pptxgenjs ESM build 是 `export { PptxGenJS as default }`→瀏覽器 `new pptxgen()` OK；Node/tsx 測試要 `(await import).default` 才是 class。
- sidecar 路由：`/transcribe`、`/chat`、`/analyze`、`/ingest`、`/query`、`/meetings`(CRUD)、`/translate`、WS `/events`(VU/狀態) 與 `/live`(即時逐字稿)。

### 雙源收音 `src/services/audio/`
- `SystemAudioCapture.ts` — FFmpeg `dshow` 同抓麥克風+系統 loopback → `amix` 混音 16kHz；無 loopback 自動降級只錄麥克風。
- `PhoneBridgeServer.ts` + `phonePage.ts` — 自簽 HTTPS/WSS + Token + QR；手機 getUserMedia → 降採樣16k → WS 二進位幀 `[uint32 seq][float64 tsMs][Int16 PCM]`。
- `Agc.ts`（動態增益）、`VuMeter.ts`（RMS/peak/dBFS）、`AudioSync.ts`（seq 去重+跳號補靜音，重連不錯位）。
- `AudioCaptureEngine.ts` — 協調器：來源切換、AGC→VU→同步→轉寫管線、`/events` 推播。
- `StreamingTranscriber.ts` — 滾動視窗 spawn whisper.cpp 執行檔（`WHISPER_BIN`/`WHISPER_MODEL_PATH`，未設定則略過）。
- 前端：`AudioSourcePanel.tsx`（來源切換+QR+起停）、`VuMeter.tsx`。

## 雙 tsconfig（務必理解，否則型別檢查會亂）
webview（DOM）與 sidecar（Node）型別世界不同，分開檢查：
- `tsconfig.json` — 前端，含 DOM lib，**exclude `src/services`、`src/server.ts`**。
- `tsconfig.sidecar.json` — `src/services` + `src/server.ts` + `src/shared`，Node types。
- **跨前後端共用的型別放 `src/shared/types.ts`**（兩邊都 include）。前端要用的音訊 DTO 也在這（`audio/types.ts` 只 re-export + 放 Node 內部型別如 `AudioChunk`/`CaptureSource`）。

## 驗證流程（改完一定跑，全綠才算數）
```powershell
cd "D:\Leo work"
npm run typecheck     # = tsc -p tsconfig.json && tsc -p tsconfig.sidecar.json，必須兩個都 exit 0
npm test              # vitest：目前 95 項（加密/切片/WAV/AGC/VU/同步/引擎/雙軌重組/續傳 + 手機橋接整合測試）
npx vite build        # 前端打包確認
```
- 碰錢/加密的程式改完，commit 前先 `/code-review`（medium）再回報（CLAUDE.md 規定）。
- Tauri 外殼編譯需 Rust+MSVC（本機沒有）→ 只能交付+文件，不能在此驗證。
- **Gemini Live / 即時逐字稿**這類靠真音訊的功能，可用 Gemini TTS 合成語音灌進 `/live` 或 `/transcribe` 做端到端實測（不需麥克風；測完刪暫存腳本）。

## 🕳️ 已知雷（踩過的，務必避開）
1. **TS 5.7 把 `Float32Array` 變泛型**：bare `Float32Array` = `<ArrayBufferLike>`，但 `new Float32Array(n)` = `<ArrayBuffer>`，賦值會衝突。解：變數加註解 `let x: Float32Array = ...`，或統一用 bare `Float32Array` 當型別。
2. **LanceDB `db.createTable/add` 的 row 型別**需符合 `Record<string,unknown>`：row interface 要加 `[key: string]: unknown` 索引簽名。
3. **手機 `getUserMedia` 需安全環境**：區網 http 會被瀏覽器擋。故 PhoneBridge 走**自簽 HTTPS/WSS**，QR 指 `https://<LAN-IP>:8443`，手機首次要點「信任憑證」。
4. **Windows 系統 loopback** 需「立體聲混音」或 VB-Audio Virtual Cable / virtual-audio-capturer；偵測不到要降級只錄麥克風（別讓整個失敗）。
5. **WSS/HTTPS server `close()` 會卡死**（外部 server + 殘留連線時 `wss.close()`/`server.close()` 回呼不觸發）。解：先 `wss.clients.forEach(c=>c.terminate())` + `server.closeAllConnections?.()`，再用**逾時保險**包 close（回呼不來最多等 1.5s 就放行）。否則 vitest afterAll 會 10s 超時。
6. **`ws.terminate()` 在 CONNECTING 的 socket 上會非同步 emit 'error'**；若先 `removeAllListeners()` 就變未捕捉例外。清理時補 `ws.on("error",()=>{})`。
7. **`ffmpeg-static`、`selfsigned` 缺型別宣告**：import 加 `// @ts-ignore` + 註解（runtime 靠 esModuleInterop 正常）。沿用既有 `AudioRepair.ts` 的慣例。
8. **二進位幀格式三處要對齊**（phonePage 編碼、PhoneBridgeServer 解析、bridge.test 測試）：`[uint32 LE seq][float64 LE tsMs][Int16 LE PCM]`，header 12 bytes，Int16→Float32 除 32768。
9. **Gemini Live 即時逐字稿（`GeminiLiveService` + `/live` WS，僅 Leo work／D:）**——踩過的硬事實：
   - **bidi 模型只支援 `responseModalities:["AUDIO"]`，沒有 TEXT**（試 TEXT 直接 code 1007 斷線）。要逐字稿走 `inputAudioTranscription:{}`，與輸出模態無關；模型自己的 `modelTurn` 語音一律不讀不轉發。
   - **正確模型 `gemini-3.1-flash-live-preview`**（免費層 Free of charge）。`gemini-live-2.5-flash-preview` 不存在（code 1008）。要列當前可用：`GET /v1beta/models` 濾 `supportedGenerationMethods` 含 `bidiGenerateContent`。
   - **線格式**：`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=`，camelCase。setup→等 `setupComplete` 才能送音訊→`realtimeInput.audio={mimeType:"audio/pcm;rate=16000",data:base64}`→讀 `serverContent.inputTranscription.text`。
   - **逐字稿在「停頓/VAD 收尾」才 finalize**，不是逐字連續吐；連續講才會分段出。模型無法被叫停（systemInstruction、關 VAD 都沒用），照樣回話→只能丟掉。
   - **粗稿是簡體＋字間空格**（STT 原始輸出）；正式存檔靠停止後 `/transcribe` 整檔精修（繁體、有時間戳/發言人）覆蓋。空格用 CJK 正規表達式顯示時收掉。
   - **兩條 WS 共用同一 http server 必須 `noServer:true` + 手動 `upgrade` 依路徑分流**；兩個 `new WebSocketServer({server,path})` 會互相 `abortHandshake` 砍掉對方連線。
   - 15 分鐘 session 上限：`GeminiLiveService` 在 upstream `close` 且本端仍錄音時自動重連，空窗期音訊先緩衝、`setupComplete` 後補送。
10. **要「看畫面」驗證時（Leo work 特性）**：① `App.tsx` 用 `health()` 把整個 UI 鎖在 sidecar(8765) 就緒後才渲染；② Claude 的 preview 瀏覽器**連不到本機 sidecar**（只 tunnel vite 那一個 port，實測對 8765 `Failed to fetch`）→ **preview 截不到完整畫面**。要看真畫面請到**自己機器的瀏覽器** `localhost:1420`。③ dev **一律用 `start-leo-work.bat` 獨立視窗**起（殺 port→`npm run dev`）；**別用 Claude 背景程序**拉 dev——工作一被回收/預覽清理就被殺，`concurrently -k` 連帶把 sidecar 收掉（已重複踩過，見 worklog 續2/續4）。

## 環境變數（`.env`，已 gitignore）
`ANTHROPIC_API_KEY`、`ANTHROPIC_MODEL`、`GEMINI_API_KEY`、`GEMINI_MODEL`(現為 gemini-3.5-flash；程式碼預設常數 gemini-2.5-flash)、`GEMINI_LIVE_MODEL`(gemini-3.1-flash-live-preview，即時逐字稿用)、`LLM_PROVIDER`(ollama/gemini/claude)、`LOCAL_DB_PATH`、`EMBEDDING_PROVIDER`(local/openai/ollama)、`ENCRYPTION_SALT`（改了舊加密檔失效）、`SIDECAR_PORT`(8765)、`PHONE_BRIDGE_PORT`(8443)、`WHISPER_BIN`、`WHISPER_MODEL_PATH`。

## 開發 / 啟動
```powershell
npm run dev          # concurrently 同起 vite(1420) + sidecar(8765)；tsx watch 會自動熱重載 sidecar
npm run tauri:dev    # 連 Tauri 視窗（需 Rust）
```
- 一鍵啟動：`D:\Leo work\start-leo-work.bat`（殺舊 port → npm run dev → 8 秒後開瀏覽器）；桌面捷徑 `Leo work.lnk` 指向它。
- 瀏覽器測試入口：http://localhost:1420

## 慣例
- 繁中註解、簡潔、不過度抽象、不加多餘錯誤處理（除非規格明示防呆）。
- 子代理人並行開發時：主代理人先寫 `shared/types.ts` + `server.ts` 鎖死契約，子代理人各寫不重疊檔案。
- 改完同步更新對應文件/README，避免「程式對但文件舊」。

## 邊界
此 skill **只處理 Leo work 這個錄音 App（D:\Leo work）**。不要碰 `投資系統(昕圳/investment_company)`、`readle-app`、`璟松旅遊`，也不要被它們的觸發詞拉進來。
