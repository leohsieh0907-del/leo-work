# Leo work 工作日誌

> 用途：每次庭晰說「**存對話**」時，把該段對話的重點（做了什麼、關鍵決定、目前狀態、待辦）寫成一筆有日期的紀錄，append 在最上面（最新在上）。寫完庭晰可 `/clear` 清空對話，下次讀此檔 + CLAUDE.md + skill + README 即可快速接續。
>
> 這是「人看的進度紀錄」，不是完整對話備份；完整逐字對話另有 Claude Code 自動存的 session 檔（.jsonl）。

---

## 2026-07-06 — v0.1.23：錄音自動分段 + Groq 後援 auto 補中譯

### ✅ 做了什麼
- **Groq 後援 auto 模式補中譯（commit `b811e72`）**：Gemini 忙不過來轉 Groq 時，auto 模式原本只出英文原文、沒補中譯 → 與 Gemini「中英並進」不一致。`GroqLlmService.transcribeAudio(auto)` 轉錄後跑一次雙語標註（`annotateBilingualAuto`）：非中文行行尾補（繁中翻譯）、中文行不動；`hasLatinText` 全中文跳過省 API、過長跳過防呆、失敗回原文。真 Groq 端到端驗過。
- **錄音自動分段（commit `5b9b354`）**：錄音緩衝硬上限 60 分，超過會截斷掉內容。改成錄到 **45 分自動「背景抽取」**——`AudioIngestionRouter` 累積達門檻(`autoSegmentSeconds`，deps 可覆寫) → `onSegmentReady` → server **同步** `drainRecordingWav()` 取走該段（緩衝清空、**收音不中斷不掉音**）→ 背景整檔精修 → `shiftTimestamps` 位移接續 → broadcast `segment_transcript` → 前端 `routeSessionText(consume=false)` 併入會議。`drainedSeconds` 累計位移，最終段 `/router/transcribe` 也位移接續（沒分段時 offset=0 行為不變）。60 分硬上限保留為安全網；新 session 位移歸零。
- 使用者提問釐清：**會議建議每 45~50 分停一次**（60 分硬上限）——現在有自動分段就不必手動停了；**auto 模式＝中英並進**（英文原文+全形括號繁中譯），一律繁中＝只中文。

### 驗證結果
- typecheck ×2、**vitest 129**（+雙語標註 hasLatinText、+路由自動分段 3：觸發/位移累加/session歸零/無回呼不觸發）、vite build 全綠。
- 真 API 端到端：Groq 雙語標註（英文補中譯、中文原樣、全中文跳過）；自動分段核心走單元測試（真 45 分實跑待庭晰實機確認，有 60 分安全網兜底）。

### 現況 / 待辦
- 發版 v0.1.23（tag→CI→OTA）進行中。**自動分段的完整實跑**建議庭晰實際錄一場 >45 分的長會議確認。
- 手機收音仍需外部兩道牆（McAfee `mc-fw-host`＋路由器 AP 隔離）才連得上。

## 2026-07-05 — v0.1.22：手機收音自簽憑證 SAN 修正（修 iOS 判「憑證無效」）

### ✅ 做了什麼（commit `e5b6d08`）
- **#4.1 手機收音「三修」逐項對現有程式碼確認**——你這份清單是「收音來源合一」重構(2026-06-28)前寫的，重構後：
  - **② 連線死結（開始收音鍵 disabled=!phoneConnected）＝已不存在**：RouterBar 點「📱手機收音」直接 `activate()`、只 `busy` 時 disabled，無 phoneConnected 閘。
  - **③ 撈錯緩衝（phoneRecordedChunks vs audioRouter）＝已不存在**：手機是 router 的 `webrtc` 來源(`phoneSource`)，音訊走同一 `recordedChunks`，`/router/transcribe` 讀的就是它。
  - **① 憑證 SAN ＝真的還缺、本次補**：`PhoneBridgeServer` 自簽憑證原只設 `commonName`，**現代 iOS/Safari 只認 SAN**→ 手機判「憑證無效」擋 wss。
- **修法**：新增 `certAltNames()` 組 SAN（localhost(DNS)+127.0.0.1+`listLanIps()` 所有區網 IPv4，去重）；`selfsigned.generate` 的 `extensions` 加 `basicConstraints/keyUsage/extKeyUsage(serverAuth)/subjectAltName`。每次 boot 重產、未持久化→天生最新無舊壞檔。
- **驗證**：typecheck ×2、**vitest 124**、node-forge 解析實際憑證確認 SAN(3 altNames)+serverAuth 皆入。**「iPhone 真的連上」需本人手機測**（自簽仍會跳一次「不受信任」需點繼續，但這次點得下去；且外部兩道牆 McAfee/AP 隔離仍要處理）。

## 2026-07-04 — v0.1.21：匯入音檔可靠性大改 + 長逐字稿全面支援（分析/聊天/翻譯不再撞 Groq TPM）

### ✅ 做了什麼（起因：庭晰回報匯入手機 M4A 常轉不出/大檔靜默失敗，接著長逐字稿分析/聊天連撞 Groq 上限）
- **匯入音檔改造（commit `bf94708`）**：
  - 舊路徑 base64+JSON 被 `express.json` 50MB 擋 → 改**原始位元組直接上傳** `POST /transcribe/file`（`express.raw`，無大小限制）。
  - 新 `AudioDecoder.ts`：ffmpeg 把任意格式（M4A/MP3/WebM…）轉 16k 單聲道 PCM16 WAV，**依實際內容辨識格式、不看 MIME**（解 M4A 空 MIME/Gemini Files API 不穩）。前端 `normalizeMime`。
  - 匯入**不走錄音 origin 路由**（`onImportedText`→併入目前會議，不會靜默送去別場）。
- **轉錄改分段並行管線 `transcribePipeline.ts`**：切段（6MB≈3 分/段，Gemini 可 inline 避開 Files API）→ 每段 **Gemini 主力、失敗 per-chunk Groq 後援** → 時間戳位移接回 → **多段並行(3條)** 加速；單段全敗只補缺漏標記不拖垮整檔。
- **進度條**：新 WS 事件 `transcribe_progress`（開頭先發 0/N 讓條立刻出現）＋前端脈動/百分比/預估剩餘；**單段用脈動動畫**（無法顯示分段百分比）。
- **長逐字稿三大文字任務全補**（根因：整份逐字稿一次送 LLM，Gemini 被匯入吃滿額度→轉 Groq→13000+ tokens 超過 Groq 免費層 **12000 TPM**）：
  - **分析** `analyzePipeline.ts`：**map-reduce**（>6000 字切 5000 字/段各自摘要→合併；reduceInput 仍太長階層式再 reduce）。每段小、Gemini/Groq 都吃得下。
  - **聊天** `relevance.ts`：只帶**與問題相關的片段**（CJK n-gram 關鍵詞比對，≤5000 字）→ **省額度**（不每句重送整份，解「怎麼這麼快用完」）＋不撞 TPM。
  - **翻譯** `translatePipeline.ts`：**逐批翻**（保留每一行、不能像聊天只挑片段）；某批失敗保留原文不丟整份。
  - 匯出：早已 cap 8000 字，本來就安全。

### 關鍵決定 / 事實
- **共同根因＝「長逐字稿整份丟給 LLM」**；共通解法＝分段（transcribe/analyze/translate 並行切段、chat 相關選取）。Groq 免費層 **12000 TPM** 是硬牆，任一整份請求超過即 `Request too large`。
- 匯入並行 3 段會較快吃 Gemini 每分鐘額度 → 緊接著的分析/聊天易轉 Groq；已靠上述分段讓 Groq 也接得住，不再硬噴。
- **dev 期踩到**：Claude 一邊改檔→sidecar 重啟→App 的 health-gate remount 整個畫面→**未存檔的逐字稿被清**（誤以為匯入沒填）。非程式 bug，打包版日常不會遇到。

### 驗證結果
- typecheck ×2 exit 0、**vitest 122**（+transcribePipeline/analyzePipeline/relevance/translatePipeline 測試）、vite build 全綠。
- 真 API 端到端（在 dev sidecar 上，用合成音檔/長逐字稿）：匯入 M4A→ffmpeg→WAV 往返、3 段並行轉錄(21s)、15k 字分析 map-reduce(21.8s)、長逐字稿聊天相關選取(4.8s)、270 行翻譯逐批(16.9s，行數不掉) 皆通過。
- 非碰錢/加密，未強制 /code-review（CLAUDE.md 規定）。

### 現況 / 待辦
- 已 commit 本機 main（`bf94708` 程式 + 本次版號/日誌/skill）。**發版 v0.1.21** 進行中（tag→CI→OTA）。
- 桌面新增「**Leo work 開發版**」捷徑（指向 start-leo-work.bat）供 dev 測試，與打包版「語音轉文字」區分。
- 手機收音兩道外部牆探測結論：McAfee `mc-fw-host` 目前停(Automatic 重開機會回)、防火牆 8443 規則在(Profile Any)、**Tailscale 佔 8443 但只綁 Tailscale IP、不影響手機走 Wi-Fi 192.168.0.204**（實測 0.0.0.0:8443 綁得上）；剩「路由器 AP 隔離」需手機實測。

## 2026-06-29~30 — v0.1.18/19/20 連發：分析會議/課程自動辨識 + 手機收音選IP + 匯出選資料夾 + 揪出雙安裝當機真因

### ✅ 做了什麼
- **v0.1.18 分析修正（commit `ffb5f55`，已 OTA）**：庭晰回報「同一份錄音，分析只吃新錄的段、前面不整合」。三次真 Gemini 實測證實**與時間戳 restart / 段落順序無關**——根因是分析提示自我定位成「商務會議助理」只抽決策/待辦，把課程的講解/舉例當雜訊濾掉。修法：抽共用 `src/services/llm/prompts.ts`（`analysisSystemPrompt`/`analysisUserPrompt`，**會議/課程自動辨識**＋多段 restart 視為同一場完整涵蓋每段、不因像閒聊就略過），Gemini+Groq 的 `generateProactiveAnalysis`/`analyzeAll` 共 4 處改用。端到端驗證雙段（訂閱制＋生活化舉例）皆涵蓋。
- **kill_sidecars 釐清（非新做）**：skill/記憶原記「v0.1.18=kill_sidecars 未上」是**誤判**。其實它在 commit `6212e09`（v0.1.17 後進 main），而 `6212e09` 是 `ffb5f55`(v0.1.18) 的父 commit → **已隨 v0.1.18 出貨**（lib.rs Tauri command + updater.ts killSidecars + App.tsx/SettingsModal 兩條更新流程都接好）。v0.1.17 tag 不含。
- **v0.1.19 手機收音選 IP（commit `eacf704`，已 OTA）**：`PhoneBridgeServer.detectLanIp` 原本只取列舉第一個非 internal IPv4，多網卡（VB-CABLE/iPhone tether/Hyper-V）會選錯 → QR 指到手機連不到的 IP。改：排除 `169.254.*`(APIPA)、虛擬網卡名稱往後排；`PhoneSession` 加 `candidates[]`；`/audio/session?ip=` 可指定；`RouterDetails` QR 面板加 IP 下拉（>1 候選才顯示）。實測當下 PC 只連 iPhone 熱點（172.20.10.4/28），故只 1 候選。
- **v0.1.20 匯出選資料夾（commit `c93129a`，已 OTA）**：歷史 ⬇ 匯出原走瀏覽器下載只能進 Downloads。改：桌面版點 ⬇ → **Tauri dialog 外掛**開「選資料夾」（預設 localStorage `exportDir`，初值 `D:\Leo work\語音備份`）→ sidecar `POST /meetings/:id/backup {dir}` 直接寫 `<會議名>_<日期>.json`(可救回)＋`.txt`(表頭+逐字稿+AI分析+行動方針)。新增 `tauri-plugin-dialog`（Cargo + lib.rs + capabilities `dialog:default` + JS dep）。瀏覽器/dev 退回原下載。
- **6 場會議備份**：批次解密匯出到 `D:\Leo work\語音備份`（.json+.txt，含分析）；其中 3 場原無分析（EMBA會計/1009/1511）補跑分析（課程式 9/14/8 點重點）並**寫回 App 存檔**。`.gitignore` 加 `/語音備份`（含解密內容、repo 為 public）。

### 🕳️ 反覆「當機/Failed to fetch」的真因（重要，未來別重查）
- 症狀：歷史會議「Failed to fetch」、sidecar 8765 連不上。前期以為是 sidecar 偶發崩潰，重開可救。
- **真因（最後揪出）**：機器上有**兩個安裝、桌面兩個捷徑**——「**語音轉文字**」(`AppData\Local\語音轉文字\`，OTA 跟到的真版 0.1.20)＋舊「**Leo work**」(`AppData\Local\Leo work\`，停在 **0.1.4**、早於所有 sidecar spawn 修正、起不了後端)。**點到舊「Leo work」捷徑就當**。那個 6/22 的 `sidecar.log`(EISDIR 'C:') 也是 0.1.4 留下的。
- **處置**：刪掉舊安裝資料夾 + 舊捷徑，只留「語音轉文字」。兩版共用資料（identifier 同 `com.leowork.desktop`，資料在 `Roaming\com.leowork.desktop`，刪舊程式不傷資料）。**鐵則：以後只從「語音轉文字」捷徑開**。
- 另：沙盒擋 `Remove-Item` 含 `\*` 萬用字元 → 改用 .NET `[IO.Directory]::Delete($dir,$true)`。

### 📌 發版流程踩到的 token 視角問題
- **草稿 release 只有「具 push 權」的 token 看得到**；用唯讀 token 查 `/releases` 會看不到草稿、誤判「build 失敗」。實際 CI 都成功。對策：發佈前**逐條憑證找出能看到草稿的那把**（也是能 PATCH 發佈的那把），`.git-credentials` 條目順序會變、別寫死第幾條。
- 三版都驗證：CI success → latest.json version 對 + Windows 穩定 tagged 網址 → PATCH 發佈 → 匿名 `releases/latest/download/latest.json` + exe(200) 通過。

### 驗證結果
- 每版皆 typecheck（兩 tsconfig exit 0）＋ vitest 100/100 ＋ vite build 全綠；Tauri(Rust，含 dialog 外掛)由 CI matrix 驗。
- git：本機 main 與 origin 同步，commit `ffb5f55`/`eacf704`/`c93129a` + tag v0.1.18/19/20 皆已推遠端並發佈成 Release。

### TODO / 提醒
- 手機收音核心前提不變：**PC 與手機須同一網路**；公司 WiFi 常開「用戶端隔離」會擋裝置互連（與程式無關）。v0.1.19 的 IP 下拉只在 PC 有多個可用網路時幫得上。
- 庭晰一律從「語音轉文字」捷徑開 App（舊「Leo work」已移除）。

## 2026-06-27（續）— v0.1.16 OTA 發佈 + 錄音 UX 修正 + 手機收音排查 + 無金鑰備份

### ✅ 做了什麼
- **v0.1.16 OTA 發佈完成、已安裝**：push tag → CI → 草稿 6 產物 → `latest.json` 穩定網址驗證 → 發佈 → 匿名 OTA 驗證通過（exe 302→200）。庭晰已 OTA 更新到 v0.1.16。
- **問題 A（分析/聊天/翻譯後援）已生效**：庭晰在打包版 ⚙️ 設定填 Groq 金鑰並重啟，`/config` 回 `hasGroqKey:true`。
- **錄音 UX 修正（commit `81791de`，已 push main，未發版 → 待 v0.1.17 進打包版）**：
  1. `RouterBar`（RouterPanel.tsx）「電腦系統/手機」即時源錄音時，**停止鈕旁顯示 `mm:ss` 計時器**（UI setInterval 計數；`recordingSeconds` 只在停止後帶 seconds、非即時跳，故用 UI 計數）。
  2. `Workspace.tsx`：**錄音中 AI 助理面板自動讓出空間**（`effectiveChatOpen = chatOpen && !captureActive`），解「錄音時下方逐字稿區被 chat(320px)+頂部即時稿條擠到看不見」；停止後自動恢復原本展開狀態。

### 🕳️ 手機收音（手機當無線麥克風）連不上——完整排查結論（耗時，未來別重查）
症狀：iPhone 掃 QR / 開 `https://192.168.0.105:8443/m` →「Safari 無法連接伺服器」。PC 端全正常（8765 up、8443 listen 0.0.0.0、QR 指向對的 192.168.0.105、`detectLanIp` 這次抓對）。**有兩道牆，要兩個都解才會通**：
1. **McAfee 隱藏防火牆 `mc-fw-host`**（`C:\Program Files\McAfee\wps\...\mc-fw-host.exe`，註冊為 SecurityCenter FirewallProduct；GUI 只有「McAfee Security Scan Plus」掃描器、**沒有防火牆開關**）。它在跑時：PC 連自己 LAN IP 的 8443/8765 都 False（loopback True）；它停掉後立刻變 True。**StartType=Automatic，重開機會回來**。Windows 防火牆已加 `Leo work phone 8443`(TCP/8443 Inbound Allow Any) 但被 McAfee 蓋過、無效。永久解：系管 PowerShell `Stop-Service mc-fw-host -Force; Set-Service mc-fw-host -StartupType Disabled`，或移除 McAfee WebAdvisor。
2. **路由器 AP 隔離（用戶端隔離）**：McAfee 停掉、PC 自連 8443=True 後，手機仍連不到。PC `ping 192.168.0.1`(路由器)=True、`ping 192.168.0.182`(iPhone)=False，但 iPhone 在 ARP 表（d2-d4-…，iOS 隨機 MAC）→ 廣播通、單播被擋 = 典型 AP 隔離。需登入路由器(192.168.0.1)關「AP 隔離/Client Isolation」，或別連訪客網路。
- **結論/建議**：主場景錄線上課用「**電腦系統**」即可（FFmpeg amix 已同時收麥克風+系統喇叭，兩邊聲音都有），手機收音是備援；要硬通需同時破上述兩道牆。

### 📦 無金鑰可還原備份
- `D:\Leo work_備份_2026-06-27`：純原始碼（去 `.git`、去 `.env`，排除 node_modules/build/本地加密資料，~1.5MB）＋ `給CLAUDE的還原說明.md`（要申請的 key + 申請網址 + 可直接貼的 Claude Code 提示詞）＋ 更新版 `.env.example`。掃過全無金鑰。

### TODO
- v0.1.17 發版（把 `81791de` 錄音 UX 修正帶進打包版）。
- 手機收音若要用：關路由器 AP 隔離 + 永久停 `mc-fw-host`。

## 2026-06-27 — v0.1.16：整檔精修加 Groq Whisper 後援（Gemini 限流時自動接手＋長錄音分段）

### ✅ 做了什麼
- **起因**：庭晰錄「EMBA會計課程」時整檔精修＋分析都噴「Gemini 免費額度暫時用盡」，問「不是有加 Groq？」。
- **根因（實測 `/config`）**：① 打包版 `hasGroqKey:false`——打包版讀 app 資料夾 `config.json`、**不讀 dev 的 .env**，從沒填過 Groq 金鑰 → `FallbackLlmService` 沒掛上（問題 A）。② 整檔精修是 `transcribeAudio`（Gemini 專屬），`FallbackLlmService` 設計上**不接轉錄**（問題 B）。
- **問題 A（設定，不用發版）**：庭晰在打包版 ⚙️ 設定填 Groq 金鑰重啟 → `/config` 變 `hasGroqKey:true`，分析/聊天/翻譯後援即生效。
- **問題 B（程式，v0.1.16）**：
  - `GroqLlmService.transcribeAudio`（Groq Whisper `whisper-large-v3`，OpenAI 相容 `/audio/transcriptions`，`verbose_json`→`[mm:ss] 發言人:`）。
  - `server.ts` `transcribeWithFallback`：`/transcribe`、`/router/transcribe` 在 **Gemini 轉錄失敗時自動切 Groq Whisper**（server 層 helper，非走 FallbackLlmService）。
  - **長錄音分段**：新 `src/services/wavChunk.ts`（`parseWavPcm`/`wrapPcmAsWav`/`chunkWavByBytes`）把 >24MB 的 WAV 切多段（16kHz 單聲道≈13 分/段）、逐段轉錄、時間戳位移後接合 → 整堂課(1~3hr)也能後援。
  - env 新增 `GROQ_WHISPER_MODEL`（預設 whisper-large-v3）。

### 驗證結果
- typecheck（兩 tsconfig exit 0）＋ **vitest 107/107**（新增 wavChunk 5 項＋格式化 4 項）＋ vite build。
- 真 API 端到端（Gemini TTS 合成中文→Groq Whisper）：**單段**（繁體、含時間戳、~1s）＋**多段**（25MB→2 段、第二段時間戳正確位移、無 reset 回 00:xx）皆過。
- `/code-review`（medium）：唯一重要發現＝Groq 免費層 25MB≈13 分上限 → 已用分段解掉。

### 發版 / 限制 / 備份
- v0.1.16：push main+tag → CI 打包（~13 分）→ 草稿 6 產物 → `latest.json` 穩定 tag 網址驗證 → 發佈 → **匿名 OTA 驗證通過**（latest.json 回 0.1.16、exe 302→200）。OTA 已上線，打包版重開即跳更新。
- 限制：Whisper 無發言人辨識（統一「發言人」）、中文可能簡體、分段邊界少數字句可能誤差；Gemini 主力品質仍較佳，Groq 僅過載時接手。
- 備份：`D:\Leo work_備份_2026-06-27`（**不含 .env 金鑰**、排除 node_modules/build/本地加密資料，含 .git，1.4MB）。

## 2026-06-27 — 發 v0.1.14 + v0.1.15（版本顯示／亮暗主題／改名／CSV／匯入音檔／錄音回原場／發言人改名）

### ✅ 做了什麼（依版本）
- **v0.1.14 發版**：header 加版本號顯示 `v{__APP_VERSION__}`（Vite `define` 從 package.json 注入，單一來源；`tsconfig.node.json` 補 `resolveJsonModule`）。連同先前已 commit 的 OTA 修正（穩定網址、更新前自動關 sidecar）一起上線。OTA v0.1.13→v0.1.14 仍卡 lancedb 檔鎖（符合預期：自動關 sidecar 要在「執行中的版本」才生效）→ 手動結束 `leo-node` PID + 按「重試」即過。
- **v0.1.15（一次發 6 功能＋1 調整）**：
  1. **亮/暗主題切換**：配色全語意化（`index.css` 定義 `--bg/--panel/--inset/--fg(.muted/.subtle/.faint)/--line/--hover(.weak)`，`:root` 暗、`[data-theme=light]` 亮）；`tailwind.config.js` 把 `brand-dark/panel` 改綁 CSS 變數＋新增語意色；全 12 元件用 sed 把寫死的 `text-slate-*/border-white/bg-black|white/*` 換成語意 class（彩色按鈕白字、modal `bg-black/60` 遮罩、`brand-accent/danger/warn` 強調色刻意保留）；`App.tsx` header ☀️/🌙 鈕＋`src/lib/theme.ts`（localStorage）＋`index.html` 開機前先套主題防閃白。亮底用柔和 `#eef2f7` 非純白。
  2. **會議改名**：解耦「穩定 id」與「顯示名 title」。`MeetingStore.rename(id,title)`（只改 title、id/檔名/向量記憶不動、不產生重複檔）＋ `PATCH /meetings/:id` ＋ `api.renameMeeting` ＋ 歷史欄每筆 hover ✎ 改名。**新會議內部 id 改用「秒＋亂數」（`newMeetingId`）**，避免同分鐘連開兩場各自存檔撞 id 互蓋（改名不再換 id 後浮現的風險）。
  3. **CSV 匯出**：`exporters.exportCsv`（ComposedDoc 攤平、含 UTF-8 BOM，Excel 中文不亂碼，本機零 API）＋ ChatAssistant 匯出列加 📑 CSV。
  4. **匯入音檔**：TranscriptPanel 📁 匯入鈕（`<input type=file accept=audio/*>` → base64 → `/transcribe`）。
  5. **防資料遺失（選 B：錄音中可看別場、資料自動回原場）**：`recordingOriginRef` 在收音/錄音/匯入「開始」時快照原場會議；`routeRecordedText` 把停止後逐字稿寫回原場（切走了就 `persistMeeting` 直接存回 + 提示，不污染目前畫面），沒切走才併入目前。`confirmSwitch` 改成錄音中允許切換（離開原場前更新快照），非錄音有未存才確認。
  6. **發言人改名**：整份字串替換 ＋ `speakerMapRef` 同場後續新轉錄（錄音/匯入）自動套用；換場重置、但錄音中切走時保留（讓寫回原場的那段也套用），寫回後清。
  7. **AI 助理收合不卸載**：原本收合是條件渲染整個卸載 → 對話被清空。改成永遠掛載、`collapsed` prop 只切顯示 → 收起/展開/放大都不再清空對話。
  - 關閉 webview 預設右鍵選單（`main.tsx` `contextmenu` preventDefault，輸入框/textarea/contenteditable 保留貼上）。

### 設計決策 / 踩過的坑
- **錄音回原場最關鍵 bug**：`capturing`（含 `finalizing`）會在「router 停止→精修」造成**第二次快照上升緣**，把原場快照重抓成（可能已切走的）目前會議 → 寫錯場（正是要修的症狀）。解法＝另用 `captureActive`（**不含 finalizing**）只抓「收音開始」那次上升緣。
- 發言人改名是「名稱對應」非聲紋：靠 Gemini 仍標「發言人N」再替換；它哪次標成別號就要再補一條。字串替換為子字串比對（`發言人1` 會誤匹配 `發言人10` 內，會議實務 ≤9 人影響極小）。
- 配色重構零改背景靠「`brand-dark/panel` 綁變數」；文字/邊框/浮層才需逐處換語意 class。

### 驗證結果
- 每批 typecheck（兩 tsconfig exit 0）＋ vite build ＋ vitest **98/98** 全綠。
- `/code-review`（medium）跑兩批，揪出並修：① 同分鐘撞 id 互蓋 ② finalizing 二次快照寫錯場。
- 庭晰在 dev（`localhost:1420`）實測通過（錄音回原場、發言人改名、收合不清空）才發版。
- v0.1.15 已發佈上線，OTA `latest.json` 匿名驗 = 0.1.15 + 穩定網址。

### 現況 / 待辦
- **線上最新 = v0.1.15**（已發佈、latest）。庭晰裝的 v0.1.14 開啟會自動跳更新，這次起 OTA 不再卡檔鎖。
- **手機獨立版（未開工，已討論架構）**：需求＝不開電腦也能用手機錄音→轉錄→分析→存手機→匯出回電腦。結論＝獨立 **Vercel PWA**（client-side 直打 Gemini，手機自帶 key、需網路）＋桌面加「匯入」；與桌面版是兩個東西。待庭晰要做時開規劃。
- 最新 commit：`73e014c`。

---

## 2026-06-25 — 修「收音沒逐字稿」根因 + AI 建議模式/改名/Groq 後援/OTA 全套（v0.1.8 → 0.1.14）

### ✅ 做了什麼（依版本）
- **v0.1.8**：AI 助理＋記憶聊天「答完給後續建議鈕」（單次 `/chat` + `###建議###` 純文字標記切出建議，**刻意不用 responseSchema**，避開 Gemini thinking 模型的 RECITATION 空回應）；產品**改名 Leo work → 語音轉文字**（productName/視窗標題/標頭/hero/手機收音頁）；換 App 圖示為麥克風 logo（`src-tauri/app-icon.svg` → `tauri icon` 全套重產）。**保留 identifier `com.leowork.desktop`**，舊會議/加密 salt 不失。
- **v0.1.9**：手機/電腦收音「停止後**自動整檔精修**帶入逐字稿」＋ Gemini 上傳偶發 `fetch failed` 自動重試。
- **v0.1.10（最關鍵）**：打包版 webview CSP `connect-src` **漏 `ws://`** → `/events`、`/live` 兩條 WebSocket 被擋 → VU 不動、即時稿不出、`recording` 事件收不到（連 v0.1.9 自動精修都不觸發）。dev(`localhost:1420`)無 Tauri CSP 故測不出來。補 `ws://127.0.0.1:8765 ws://localhost:8765`。**這才是「收音沒逐字稿」真因。**
- **v0.1.11**：Groq 當 Gemini 後援（`GroqLlmService` + `FallbackLlmService`）——分析/翻譯/聊天遇 Gemini 503 過載/429 限流自動轉 Groq；用庭晰專屬 Groq key。
- **v0.1.12**：一批精修——① `lib.rs` `RunEvent::Exit` kill sidecar（根治 8765 殘留/檔鎖）② ffmpeg 收音卡死看門狗（4s 無 PCM 自動重啟，上限 2 次）③ Groq 進設定畫面 + `hasGroqKey` ④ 即時稿沒字給「預覽/停止後精修」提示 ⑤ 匯出 compose 也走 Groq 後援（`normalizeComposedDoc` 改 export 共用）⑦ 修模型 placeholder。（⑥⑧ 清桌面裸露金鑰 token.txt 與散落 config.json）
- **v0.1.13**：OTA——repo **設 public**（庭晰手動於 GitHub Settings 改；token 無 Administration 權限）＋ CI 加 `updater-json` job 補產 `latest.json`（tauri-action 在 Win+Mac matrix 下不產統一 latest.json）。
- **v0.1.14（已 commit、未發版）**：修 OTA 下載 404（`latest.json` 改用穩定網址 `.../download/<tag>/<name>`，不用草稿的 `untagged-xxx`）＋ 更新失敗顯示原因（不再「按了沒用」靜默）＋ **更新前自動 `/shutdown` sidecar 釋放檔鎖**（免再手動收 leo-node）。

### 設計決策 / 踩過的坑（已寫進 skill 已知雷 #12–#14 + OTA 段）
- 收音→逐字稿**兩條路**：即時 Gemini Live（盡力預覽、會靜默失敗）vs 停止後整檔精修（可靠、gemini-2.5-flash）。後者才是存檔版。
- OTA：① latest.json url 必用穩定網址，mac 的 `_aarch64.app.tar.gz` **無版號前綴**；② OTA 安裝卡 lancedb 檔鎖 → 更新前關 sidecar（修正須在「正在跑的版本」才生效）；③ repo public 後 token 選取改靠「**能看到草稿**」（fine-grained PAT 的 `.permissions.push` 回擁有者權限、不可靠）；④ **`gh api` 後別接 `2>$null`**（PowerShell 把 native stderr 包成 ErrorRecord 汙染 stdout，害 ConvertFrom-Json 變 1 筆、誤判限流）。

### 驗證結果
- 每版 typecheck（兩 tsconfig exit 0）＋ vitest **98/98** ＋ vite build OK；Rust(`lib.rs`)靠 CI 編譯通過（Win+Mac 安裝檔都出 = 編過）。
- OTA 端到端實機驗：偵測 ✅、下載 ✅（curl 匿名 exe HTTP 200）、驗章 ✅、跑安裝 ✅，只差最後檔鎖（v0.1.14 已修）。
- Groq 專屬 key 實測可用。

### 現況 / 待辦
- **庭晰目前在 v0.1.12**：功能完整、9 項精修全在。中止了 v0.1.13 的 OTA 安裝，**無損失**（v0.1.13 與 v0.1.12 功能相同、僅版號差）。
- **v0.1.14 已 commit 未發版**：下次有實際新功能要發版時一起帶。**升到 v0.1.14 的那一次 OTA 仍需手動「重試」一次**（自動關 sidecar 要在執行中的版本才生效），之後才完全免手動。
- repo 已 public、OTA 機制就緒。金鑰：Gemini + Groq 都在 Roaming `config.json` + `.env` + `金鑰.txt`（`LEO_WORK_GROQ_API_KEY`）。
- 最新 commit：`ffaa16b`。

---

## 2026-06-21 — 排查「桌面與網站都連不上」：實為 dev server 沒啟動（非崩潰）

### ✅ 結果（全部完成 2026-06-22）
- **v0.1.7 已發佈並安裝，庭晰正常開啟後完全獨立運作**：App 自己 spawn sidecar（leo-node）、8765 health OK、CORS 放行、**Gemini 金鑰生效**（`hasGeminiKey=true`、`llmProvider=gemini`）。不用 bat、不用手動 sidecar。
- GitHub latest release = v0.1.7（v0.1.1~0.1.6 草稿仍未發佈、無妨）。

### 🕳️ 最大教訓（務必記住，省下大量鬼打牆）
- **絕對不要從 Claude（桌面版，MSIX 沙盒）用 `Start-Process` 啟動 leo-work.exe 來「驗證」**。Claude 是 MSIX 封裝 App，子行程會繼承它的 **AppData 重導向**（`%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\...`），導致 `app_data_dir()`／資源路徑變成被虛擬化的怪路徑 → sidecar spawn 出現假性 `EISDIR 'C:'`。**這是 v0.1.5/0.1.6 反覆「還是壞」的真兇——不是程式 bug，是我的啟動方式**。
- **正確驗證法**：請庭晰**自己從桌面/開始功能表開啟**，Claude 端只用 `Invoke-RestMethod http://localhost:8765/health`、`Get-Process leo-node`、讀 `/config` 從**外部**觀察（不受沙盒影響）。
- lib.rs 的 spawn 強化（candidate 乾淨路徑優先＋CWD＋相對檔名 server.cjs）仍是**更穩健、該留**；只是「一直壞」的觀感主要來自上面的啟動方式。

### 仍未做（選配，不急）
- 🟠 自動更新：repo 是 **private** → tauri 更新器匿名抓不到 → 不會 OTA。要嘛把 repo 設 public，要嘛每次發版手動下載安裝（已驗證可行：`gh release download`）。
- 🟡 lib.rs spawn 的 sidecar 在 App 關閉時未 kill（8765 殘留；下次靠舊 sidecar 也能連，但會用到舊版）。
- gh 環境備忘：已 winget 裝 gh；認證用 `GH_TOKEN`（token 取自 `~/.git-credentials` **第 2 條** leohsieh，第 1 條是別 repo）；此 PAT **無 Actions 權限**（看 build 只能用 releases 端點，不能用 Actions）。

### 狀況
- 桌面 App 卡在「本機服務未就緒，重試中…」「離線」；瀏覽器 `localhost` `ERR_CONNECTION_REFUSED`。

### 根因 / 處理
- 實測 `Get-NetTCPConnection 1420,8765` → **兩個 port 都無程序在聽**（一堆 node 程序是 Claude/MCP 自己的，不在那兩 port）。根因＝**dev server 根本沒在跑**，不是當機。
- 用 `start-leo-work.bat` **獨立 cmd 視窗**啟動（殺舊 port → `npm run dev` → 8s 後開瀏覽器）；**不掛 Claude 背景程序**（會被回收殺掉，已知雷 #10）。
- 輪詢確認：vite 1420 ✅、sidecar 8765 ✅、`GET /health` 回 `{ok:true}`。桌面 App 會自動由「重試中」轉在線。

### 釐清一個誤判（重要，別再踩）
- `/health` 回 `provider:"local"` **不是 LLM**，是 **embedding provider**（`server.ts:236` 回的是 `EMBED_PROVIDER`＝`EMBEDDING_PROVIDER=local`，本地離線 ONNX 向量，刻意如此）。
- 查 `.env`：`LLM_PROVIDER=gemini` ✅、`GEMINI_API_KEY` 已設(39字) ✅、`GEMINI_MODEL=gemini-2.5-flash`、`server.ts:7 import "dotenv/config"` 確認有載入。
- 結論：**LLM 本來就是 Gemini，分析/翻譯/聊天/轉錄/STT/匯出都走 Gemini，無需改動**。

### 桌面 App 仍離線 → 根因＝CORS 漏放行 Windows Tauri 來源（已修 server.ts）
- 網站(1420)修好後**桌面 App 仍「離線」**。實測程序：`leo-work` PID 在跑＝**正式打包版桌面 App**；8765 被我用 bat 起的 dev sidecar 佔住，正式版自己 spawn 的 sidecar（`leo-node`）起不來。
- 真正根因（curl 帶 Origin 實測）：`server.ts` CORS 白名單只有 `http://localhost:1420`、`127.0.0.1:1420`、`tauri://localhost`（後者是 **mac/Linux** 的來源）。**Windows 上 Tauri v2 webview 來源是 `http(s)://tauri.localhost`** → 回應無 `Access-Control-Allow-Origin` → webview 的 `/health` 被 CORS 擋 → 一直「未就緒」。這也解釋桌面 App 在 Windows 上一直連不上（即使用自己的 sidecar 也會被同 CORS 擋）。
- **修法**：`server.ts:226` CORS origin 陣列加入 `http://tauri.localhost`、`https://tauri.localhost`。dev sidecar(tsx watch)熱重載後 curl 帶 `Origin: http://tauri.localhost` 已回正確 ACAO；`npm run typecheck` 雙 tsconfig 全綠。
- **但書（重要）**：現在桌面 App 能連是因為接到「我熱重載過的 dev sidecar」。**正式打包版自己內建的 sidecar 仍是舊 build、仍含舊 CORS** → 一旦不靠 dev、回去用自帶 sidecar 就會再壞。**永久修＝此 commit 走 CI 重新打包**（本機無 Rust 不能打包）。

### AI 助理「沒有產生回覆」→ chat() 空回應未重試（已修 GeminiLlmService）
- 桌面 App 問「幫我總結三個重點」回「（沒有產生回覆，請換個方式問問看）」。直接打 `/chat` 重現→其實間歇成功（還引用到跨會議記憶，記憶檢索正常）。
- 根因：`GeminiLlmService.chat()` 雖用 `fetchGeminiWithRetry`（處理 5xx/429），但**沒處理「HTTP 200 但內容空」的 RECITATION 誤判**（約 1/3），且**只試一次就回 fallback**，不像 `generate()` 會重試 3 次。
- 修法：`chat()` 改為 for 迴圈、空回應自動換一次再試最多 3 次，3 次都空才回 fallback。typecheck 雙 tsconfig 綠、`/chat` 連打皆正常、`npm test` 98 全綠。

### 發版：v0.1.5（CI 打包；B/C＝GitHub 發佈草稿 + App 自動更新）
- 升版 `0.1.4 → 0.1.5`（package.json + tauri.conf.json），push main + 推 tag `v0.1.5` 觸發 `.github/workflows/release.yml`（Win+Mac matrix → 草稿 Release）。
- 本次三修正**都在 sidecar**（不動 Rust 外殼/前端）：CORS 放行 Windows Tauri 來源、chat() 空回應重試。
- 前置：GitHub Secrets 需有 `TAURI_SIGNING_PRIVATE_KEY`（自動更新簽章）；過去 v0.1.0~0.1.4 build 是否成功未驗證，第一次 build 可能要看 Actions log 除錯。

### B/C 執行結果（已發佈；但自動更新受阻於 private repo）
- CI 已自動建出 v0.1.5 草稿，**Win+Mac 產物齊全**：`x64-setup.exe`(97MB) + `aarch64.dmg` + `app.tar.gz` + 各 `.sig` + `latest.json`；latest.json **兩平台條目都在**（含 `windows-x86_64`，帶簽章與 URL）。
- 已用 `gh` 發佈 v0.1.5（`draft=false, make_latest`），GitHub latest release = v0.1.5。
- 🔴 **C 自動更新對本 repo 無效**：repo 是 **private**。更新器端點 `releases/latest/download/latest.json` 是**匿名抓取**，private repo 的 release 產物即使發佈、匿名仍 **404**（實測兩個公開 URL 皆 404）。
- ✅ 替代：擁有者登入下可手動下載。已把 `Leo.work_0.1.5_x64-setup.exe` 抓到 `~/Downloads`，**關閉 App → 執行安裝檔即更新**到 0.1.5（含 CORS + chat 修正）。
- gh 環境：已 `winget` 裝 gh；token 取自 `~/.git-credentials`（**第 2 條**才有 leo-work 權限，第 1 條是別的 repo）。此 PAT **無 Actions 權限（讀 runs 403）**，故無法用 gh 看 build log；releases/contents 可用。

### 🔴→✅ 裝完 v0.1.5 仍離線：sidecar spawn 的 `\\?\` 路徑 bug（已修 lib.rs，發 v0.1.6）
- 裝好 v0.1.5 開啟 → 仍「本機服務未就緒」、8765 沒起來、**無 leo-node 程序**。手動 `leo-node.exe sidecar/server.cjs`（純路徑）**完全正常** → 問題在 lib.rs spawn 本身。
- `app_data_dir/sidecar.log`（lib.rs 已把 spawn 的 stdio 導到這）真因：`Error: EISDIR ... lstat 'C:'` at `resolveMainPath`。
- 根因：lib.rs spawn 第一順位用 `app.path().resolve("sidecar/server.cjs", Resource)`，**Windows 回傳 `\\?\C:\...` 擴充長度路徑** → Node 模組解析器把主程式路徑誤判成 `C:` → sidecar 永遠起不來。用 `\\?\` 前綴路徑手動跑，error 完全一致（鐵證）。**這就是「打包/spawn 從沒驗證成功」一直卡住的真因**。
- 修：`lib.rs` spawn 傳給 Node 當主程式前 `strip_prefix(r"\\?\")`（非 verbatim 路徑原樣）。升版 0.1.6 重走 CI。本機無 Rust 不能編譯，但 strip 後＝純路徑、純路徑已實證能正常啟動 sidecar。
- 過渡：已手動 `Start-Process leo-node.exe sidecar/server.cjs` 起一顆 8765 sidecar 頂著，現有 v0.1.5 App 可正常用（重開機/關掉就沒了，等 0.1.6）。
- 安裝位置：`%LOCALAPPDATA%\Leo work\`（leo-node.exe 72MB + sidecar/server.cjs + leo-work.exe）。

### 待辦
- ⏳ v0.1.6 CI build → 發佈 → 手動下載重裝（同 private repo 限制，更新器匿名抓不到）。裝完才是**真正獨立、不靠 bat/手動 sidecar** 的版本。
- 🟠 **決定自動更新策略**：要真正 OTA → repo 設 **public**（程式碼公開；`.env`/金鑰已 gitignore）；或維持 private、每次發版**手動下載安裝**（不建議把 token 包進 App）。
- 🟡 **里程碑 3 殘留**：lib.rs spawn 的 sidecar 在 App 關閉時仍未 kill → 8765 殘留（下次靠舊 sidecar 也能連，但會用到舊版）。本次未一起改（避免無法本機編譯的 Rust 改動過大），留待下次。
- 🟡 dev sidecar 與正式版 sidecar 都要 8765 → **不能同時跑**；用桌面 App 時別同時開 bat 的 `npm run dev`。
- 🔴 `lib.rs` spawn 的 sidecar 在 App 關閉時未 kill → 8765 殘留下次起不來。
- 🔴 CI 尚未實際 build 成功驗證打包/spawn（首次 build 是舊 commit，不含里程碑 3）。

---

## 2026-06-16（續）— 長會議整檔精修 + 系統收音修復 + 線上會議收音落地(VB-CABLE) + 功能說明文件

### 程式（已 commit，全綠 98 測試）
1. **`6e52247` 長會議整檔精修**：`GeminiLlmService.transcribeAudio` 音訊 >~12MB(約8分鐘)自動改走 **Gemini Files API**(resumable 上傳→輪詢 ACTIVE→file_uri)，繞過 inline ~20MB 請求上限；小檔維持 inline。`MAX_RECORD_SECONDS` 600→3600(10→60分)。已對真 Gemini 端到端實測(TTS 合成→墊到12.6MB→走 Files API→轉錄成功)。
2. **`602dcd0` 系統收音修復(重要)**：`parseDshowDevices` 原本只認舊版 ffmpeg「DirectShow audio devices」區段標題，**新版 ffmpeg-static 改成每行尾標 (audio)/(video)、無區段標題 → 解析回空 → 「電腦系統」收音整個失效(抓不到任何裝置)**。改成兩格式相容。另 `pickLoopback` 加偏好序(VoiceMeeter B1 > CABLE Output > 任一 VoiceMeeter > Stereo Mix)、`server.ts` 加 `SYSTEM_LOOPBACK_DEVICE` env 覆寫、新增 dshow-parse 回歸測試。
3. **`356a99b`/`4089f5e`/`5f3d552`** 功能介紹與用法 **HTML＋Word**（含 VooV/Zoom/Teams 線上會議章節）；**`57fdc4c`** 同步 skill 鏡像 `docs/maintenance-skill.md`(原 drift)＋CLAUDE.md 日期。

### 環境設定（非 repo，給接續者：戴耳機/喇叭錄線上會議系統聲）
- **VoiceMeeter 試了但與機器既有 Potato 驅動版本不匹配、過不了 → 已 `winget uninstall` 移除**。
- **改用 VB-CABLE**(官網裝、需重開機)：`CABLE Input`(播放)/`CABLE Output`(錄音)。`.env` 加 `SYSTEM_LOOPBACK_DEVICE=CABLE Output`(VoiceMeeter 移除後其實 priority 也會自然選它)。**錄音鏈已用 Leo work 實際收音程式驗證有訊號**。
- **桌面捷徑「切換錄音音訊」**→ `C:\Users\user\AudioToggle\toggle-audio.ps1`(用 PSGallery 的 AudioDeviceCmdlets，純 ASCII)：一鍵切「CABLE Input(錄音模式) ↔ 喇叭/AirPods(正常)」。
- **接聽**：CABLE Output「聆聽此裝置 → Speakers」已設(錄音模式時從喇叭聽得到)。**AirPods 在這台藍牙極不穩(當天斷 5~6 次)故走喇叭**；要改 AirPods 私密聽：把接聽目標改成「耳機」。
- 用法：點捷徑進錄音模式 → 開會議＋Leo work 開🖥️電腦系統錄 → 完再點一次切回。

### 待辦 / 下一步（皆選配）
- 若 AirPods 要穩定當錄音聽音裝置：解決藍牙連線不穩(或就維持喇叭)。
- Word/Excel 原生圖表(目前只 PPT)；上 GitHub(建私有 repo + 放行 token)。

---

## 2026-06-16 — 匯出 Word/Excel/PPT（含 AI 客製＋PPT 自動圖表）+ AI 面板合併 + 收音列移上 header + Gemini 容錯

### 這段做了什麼（共 6 個 commit）
1. **`ba1f772`** 先把續4 未提交的「整頁記憶聊天 + LLM 升 3.5-flash」commit；同步修文件（CLAUDE.md 測試數 84→95、README 補 MemoryChat/目錄名改 Leo work/GEMINI_MODEL 註現值）。
2. **`92461fb` 匯出 Word/Excel/PPT**：新 `src/lib/exporters.ts`，瀏覽器端離線產檔（`docx`/`exceljs`/`pptxgenjs`），按鈕原放分析面板、**動態 import**（按了才載、切獨立 chunk，主程式維持 ~182KB）。**棄用 SheetJS `xlsx`（high 無修補 CVE）改 `exceljs`**。順手把手機 QR 做成可收放（避免擋位置）。
3. **`fc42888` AI 客製「討論完再產出」**：`ComposeExportRequest` 加 `history`；`composeExportDoc`（responseSchema 強制 JSON）依「討論＋格式＋會議資料」重組成通用 `ComposedDoc`（heading/paragraph/bullets/table）再渲染。
4. **`1a73d7b` 合併兩個重複 AI 面板**：原本「分析面板裡的討論框」與「底部🦉AI 助理」功能重複 → 併成單一 `ChatAssistant`（聊天＋匯出一體），全寬底部、預設展開、加放大鈕；`AnalysisPanel` 回歸純顯示。
5. **`251ebad` 收音列移上 header**：`RouterPanel` 拆 `RouterBar`（控制列→併進頂部 header）＋`RouterDetails`（QR/藍牙/即時稿→下方、無內容不顯示），省一條橫列。同 commit 加 Gemini 過載重試。
6. **`fe51023` PPT 自動圖表 + 容錯**：見下「關鍵決定」。

### 關鍵決定 / 踩過的雷（重要）
- **🕳️ Gemini RECITATION 空回應**：`gemini-3.5-flash`（thinking）做 responseSchema 結構化輸出時，**約 1/3 機率被「疑似抄襲」安全過濾清空**（HTTP 200、content 空、`finishReason:RECITATION`、亂引維基，誤判）。對策：`generate()` 遇空回應**自動重試最多 3 次**；匯出端 AI 失敗/空 blocks **退回預設範本**不卡死。**別在 prompt 放 JSON 範例**（更易觸發 RECITATION）。
- **圖表怎麼產**：Gemini 常不主動選 `chart` 區塊、又有 RECITATION → **不依賴它畫圖**。改在 `exporters.ts` `tableToChart`：PPT 把「數值表格」（首欄項目＋其餘欄純數字）**自動畫成圖**（單欄→pie、多欄→bar，`pptx.addChart` 原生）；提示改「數字一律放 table」（它做表很穩）。**目前圖表只有 PPT**（Word/Excel 是資料表）。`chart` 區塊型別與 schema 仍保留。
- **pptxgenjs**：ESM build `export { PptxGenJS as default }` → 瀏覽器 `new pptxgen()` OK；Node/tsx 測試要 `(await import).default`。
- **Gemini 過載**：`fetchGeminiWithRetry`（429/5xx 退避重試 2 次）包住 generate/transcribe/chat（解「This model is currently experiencing high demand」）。
- 全程驗證：typecheck ×2 exit 0、vitest 95/95、vite build OK；圖表/compose 多次對真 Gemini 端到端實測（暫存腳本測完即刪）。

### 續（同日，額度/容錯收尾）— 共再 +3 commit，已實機驗收通過 ✅
7. **`bf3cec3`** Gemini 429 先改「不重試」（避免額度用完還硬打更快燒光）+ 寫本 worklog。
8. **`719488e` 429 智慧重試**：`parse429RetryMs` 讀回應 `retryDelay`/「retry in Ns」——**短等待 ≤15s（每分鐘 RPM）就等一下自動再試**、長等待（每日上限）直接回報；5xx 維持退避重試。
9. **`ccc534d` 省額度 + 友善錯誤**：`GeminiLlmService.analyzeAll`（選配介面方法）把「分析＋行動方針」**併成 1 個請求**（原本 2 個，`/analyze` 砍半用量；Ollama/Claude 無此法→退回 2 呼叫）；`geminiErrorMessage` 把 429 轉**中文友善提示**（每分鐘約 N 秒／每日約 N 分鐘恢復）。

**踩過的雷（新增）**：
- **🕳️ Gemini 免費額度是 per-帳號/專案**：同帳號建新 key **不會增加額度**。庭晰最後**用另一個 Google 帳號**開 key（獨立額度）才順。建 key 走 AI Studio (`aistudio.google.com/apikey`) 最簡單；Cloud Console 要先啟用「Generative Language API」才會出現在金鑰限制清單。
- **🕳️ `.env` `GEMINI_MODEL` 重複前綴**：庭晰手改成 `GEMINI_MODEL=GEMINI_MODEL=gemini-2.5-flash`（多打一次 key 名）→ Gemini 回「unexpected model name format」。修法：值只留 `gemini-2.5-flash`。改 `.env` 一律要**重啟 sidecar**（dotenv 只在啟動讀）。
- **RPM 限流訊息「Please retry in 8.6s/59s」＝每分鐘窗口**（非每日用光），等幾秒～1 分鐘恢復；連點會一直撞同窗口。

### 目前狀態（最終）
- **共 9 個 commit**全在本機 `main`，**未 push（repo 無 remote）**。`.docx` 個人筆記維持未追蹤。
- `.env`：`LLM_PROVIDER=gemini`、`GEMINI_MODEL=gemini-2.5-flash`、`GEMINI_API_KEY`＝**庭晰另一帳號的新 key（獨立免費額度）**。
- 文件（README、skill `proactor-recorder`）已同步。
- **✅ 庭晰已在 `localhost:1420` 實機驗收通過**（分析/匯出/圖表/合併面板/收音列/容錯，新 key＋分析砍半下順跑）。

### 待辦 / 下一步（未做，皆選配）
- Word/Excel 也加原生圖表（Word 需 Chart.js 畫圖片嵌入；Excel `exceljs` 不支援原生圖表，只能嵌圖片）。目前只 PPT。
- ~~skill 鏡像 `docs/maintenance-skill.md` 已 drift（122 行 vs 正本），未同步~~ → **2026-06-16 已整份重新同步**（補齊 analyzeAll/429 重試/RECITATION/GEMINI_MODEL 共用/合併面板/MemoryChat/exporters/PPT 圖表/雷 #10，測試數 84→95）。
- 上 GitHub（建私有 repo + 放行 token → 加乾淨 remote）。
- （想再省額度）chat/compose 仍走 Gemini；要支援 Claude/Ollama 接手聊天+匯出需把 `/chat`、`/export/compose` 改成跟 `LLM_PROVIDER`（轉錄/即時逐字稿無法給 Claude）。

---

## 2026-06-15（續4）— 新增整頁「記憶聊天」+ LLM 升 gemini-3.5-flash

### 這段做了什麼
1. **新功能：整頁「記憶聊天」（`src/components/MemoryChat.tsx` + `App.tsx` 分頁）**。庭晰拿客戶截圖（「Potor 可以幫您做些什麼？／您的記憶在內」+ 一排建議卡）問能否加。先確認三個方向：**整頁**（非升級底部小面板）、**照截圖 11 條提示詞原文**、**維持深色**。實作：
   - 空狀態＝歡迎 hero（🦉 標題「Leo work 可以幫您做些什麼？」+ 副標「您的記憶在內」+ 大圓角輸入框 + 11 張帶 icon/說明的建議卡）；有對話＝訊息串 + 底部輸入列、可「＋新對話」回首頁。
   - 走 `/chat` 但 `transcript:""`（無當前會議、純跨會議記憶，對應「您的記憶在內」）。
   - `App.tsx` 頂部加「工作區 / 🦉 記憶聊天」分頁切換；記憶聊天分頁不掛 `RouterPanel`。
   - 標題用現用產品名「Leo work」**不用**截圖舊名「Potor」（避免把死掉的名字加回來）。
2. **模型升級：`GEMINI_MODEL` `gemini-2.5-flash` → `gemini-3.5-flash`**。先更正一個誤判：`/health` 回的 `provider:"local"` 是**嵌入模型**欄位，**不是 LLM**；`.env` 其實早就 `LLM_PROVIDER=gemini`，LLM 本來就是 Gemini。真正還「老」的只有本地嵌入 `all-MiniLM-L6-v2`。用 `GET /v1beta/models` 查金鑰可用清單→`gemini-3.5-flash` 實測 generateContent OK；`gemini-3-pro-preview` 回 **429（免費層額度）**，故選 flash（也避免 pro 拖慢轉錄）。
3. **驗證全綠**：`typecheck` ×2 exit 0、`vite build` OK、`vitest` 95/95；重啟 sidecar 後 `/chat` 端到端實測通（回正常繁中）。
4. **文件同步**：skill `proactor-recorder` 補 `MemoryChat`、`GEMINI_MODEL` 共用 LLM+STT 的雷、測試數 84→95、新增雷 #10（preview 截不到畫面 + 別用背景程序拉 dev）。

### 關鍵決定 / 事實
- **`GEMINI_MODEL` 同時被 LLM 實例與 `geminiStt`（轉錄/聊天）共用**——改它一次換掉分析+轉錄；要單獨把分析升 pro 得另拆 STT 模型，否則 pro 會拖慢/變貴整檔轉錄。免費層 pro-preview 實測 429。
- **這次升級不花錢**：同一把金鑰、同為 flash 等級、免費層內 $0；沒做會花錢的兩件事（升 pro、嵌入換 OpenAI）。
- **preview 瀏覽器連不到本機 sidecar(8765)**（只 tunnel vite 一個 port，實測 `Failed to fetch`），App 又把 UI 鎖在 health 之後 → **preview 截不到 live 畫面**（工具限制，非 bug）。改用 `show_widget` 出一張忠實深色 mock 給庭晰看；真畫面看自己機器 `localhost:1420`。
- **又踩「背景程序拉 dev 會被回收」雷（續2 記過）**：我用 `run_in_background` 起的 dev 中途被殺（vite 被外部終止→`concurrently -k` 連收 sidecar），靠 `start-leo-work.bat` 獨立視窗那台撐住。教訓已寫進 skill 雷 #10：dev 一律用 bat、別靠對話。

### 目前狀態
- App 在 `localhost:1420` 跑（`start-leo-work.bat` 獨立視窗），sidecar 8765 健康，LLM=**gemini-3.5-flash**，`/chat` OK。
- 記憶聊天功能 live、驗證全綠。
- **未 commit**（本次純前端 + `.env`/skill/worklog，未碰加密/錢；庭晰未要求 commit）。

### 待辦 / 下一步（未做）
- （選）建議卡提示詞客製成貼合 Leo work 實際資料（目前照截圖原文，部分如「課程/學期/客服來電」點了 AI 會回查無）。
- （選）嵌入模型 `all-MiniLM-L6-v2`（本地 384維）→ `text-embedding-3-small`（雲端 1536維，檢索更準）：需 `OPENAI_API_KEY` + **重建既有會議索引**（維度變了不相容），成本較高，待庭晰決定。
- 本次變更未 commit；要進版控再說。

---

## 2026-06-15（續3）— 自動模式強制繁體 + 釐清「手機收音→帶入會議」操作流程 + 首次 commit

### 這段做了什麼
1. **庭晰回報三個現象，逐一查根因（沒臆測硬改）**：
   - 「即時逐字稿餵不進會議逐字稿」→ **不是 bug，是流程沒走完**。即時稿只是預覽，永遠不自動流入會議稿；必須「手機收音 → 🔴停止 → 冒出『✨ 精修並帶入會議』橫幅 → 點它」才會把整段送 Gemini 精修並填入。庭晰截圖一直停在「手機收音中」（沒按停止）→ 故沒東西進去。讀 `AudioIngestionRouter` 確認：VU 有跳＝音訊確實進來且**同路徑已存進可精修緩衝**（onData→appendRecording），收音沒壞。
   - 「即時稿變韓文/日文/西班牙文/簡體」→ **已知語言漂移**：上方即時稿走 Gemini Live 串流、**沒鎖語言**，手機音質一糊就亂猜語言。只是預覽，以精修版為準。
   - 「要不要再按下方🎙錄音」→ **不用**。上方 RouterPanel（手機/電腦系統）與下方 TranscriptPanel🎙錄音是**兩套獨立收音**：前者來源是手機/電腦系統聲、停止後**手動**點✨帶入；後者來源是**電腦本機麥克風**、停止後**自動**填入。**只挑一套，別同時開**（會雙錄＋撞 Gemini 限流）。
2. **小修正：`transcribeAudio` 的「自動」模式補上硬規定「中文一律輸出繁體（正體）字，絕不可輸出簡體」**（`GeminiLlmService.ts`）。原本只有「一律繁中」會強制繁體，auto 模式有缺口可能吐簡體；現在 auto 也保證繁體（非中文附繁中翻譯的行為不變）。
3. **庭晰實測通過**：走完「停止→選一律繁中→✨精修並帶入會議」後可正常填入會議逐字稿。
4. **首次 commit**：把累積多次未提交的變更（Feature A 收音精修帶入會議、A+B 雙軌 Gemini 逐字稿/WSS 手機橋接、本次 auto 繁體修正、新建專案 CLAUDE.md、GeminiStreamingTranscriber + 測試、README/worklog）一次提交。`.gitignore` 補 `~$*`（排除 Office 鎖檔）。

### 關鍵決定 / 事實
- 「手機收音→帶入會議」的**唯一正確操作**：手機收音 → 停止 → ✨精修並帶入會議（語言選一律繁中最穩）。即時稿只是預覽。
- 即時稿語言漂移是 Gemini Live 沒鎖語言的已知行為，**精修版才是成品**；若連精修版都亂＝手機收音音質太差（離太遠/Wi-Fi 不穩），非程式問題。
- 兩套收音系統獨立、別並用。
- repo 仍**無 remote、不 push**（純本機）；庭晰的 `語音轉文字app注意事項.docx` 為個人筆記，未納入版控。

### 目前狀態
- 驗證全綠：typecheck ×2 exit 0、vitest 95/95、（本次只改提示字串，未動測試）。
- 已 commit 至本機 main。App 跑在 http://localhost:1420（start-leo-work.bat 獨立視窗）。

### 待辦 / 下一步（未做）
- （選）即時粗稿語言漂移：研究幫 Gemini Live 加語言提示（CP 值低，精修已蓋掉）。
- 藍牙仍不可用（未裝 noble + 無 PM01-9 GATT 私有文件，且庭晰無此卡），維持現狀。
- （選）上 GitHub：建私有 repo「Leo-work」+ 放行 token → 加乾淨 remote。
- Phase 4 UI 美化：等庭晰指定畫面。

---

## 2026-06-15（續2）— 服務重啟根因 + 真實裝置實測 + Feature A（收音精修帶入會議）

### 這段做了什麼
1. **修「本機服務未就緒」反覆出現的根因**：vite(1420) 從早一直開著，但 **sidecar(8765) 沒有穩定擁有者**——前面是用 Claude 背景程序拉起，工作一被回收就跟著死。改用 `start-leo-work.bat` 在**獨立 cmd 視窗**啟動（殺舊 port → npm run dev = vite + tsx watch sidecar），獨立於 Claude、不再被回收。**非程式 bug**（err log 無例外堆疊）。→ 教訓：日常啟動一律用桌面捷徑 / bat，別靠對話。
2. **釐清兩個使用者困惑**：
   - 「Grammarly 彈窗」是瀏覽器擴充功能，**非 App**。
   - 「逐字稿出現日文」：頂部即時粗稿是 **Gemini Live 原始 STT**，未鎖語言＋手機音質糊 → **語言漂移**亂猜，屬 skill 已知行為（粗稿只是預覽，**以停止後整檔精修為準**）。
   - 釐清**兩套收音系統原本沒接通**：頂部 RouterPanel（手機/電腦/藍牙）只進「即時逐字稿」預覽條；下方 TranscriptPanel「🎙錄音」才走 /live+/transcribe 進「會議逐字稿」並可存檔。
3. **真實裝置實測（待辦①②）後端全鏈路驗證**（用 Gemini TTS 合成語音灌進相同路徑，這台機器也能測）：① 麥克風→`/live`→Gemini 即時回字 ✅；② 手機 WSS 橋接幀→router→Gemini 出字 ✅（真實 LAN IP 172.20.10.x、錯誤 token 被拒、vu+transcript 皆出）。庭晰也已用真手機掃 QR 收音成功（音量條跳、即時稿出）。
4. **Feature A — 手機/電腦收音 → 停止 → 整檔精修帶入會議可存檔**（庭晰拍板要做）：
   - sidecar：`AudioIngestionRouter` 前景收音時累積 AGC 後 PCM；新端點 `POST /router/transcribe`（lang）→ `peekRecordingWav()` 編 WAV → `geminiStt.transcribeAudio` 精修 → 回乾淨繁體稿（[mm:ss]+發言人）。
   - 前端：停止後工作區跳「✨ 精修並帶入會議」（可選語言）→ 填入會議逐字稿 → 可 💾 存檔 / 分析。`audioStore` 加 recording 狀態 + `finalizeRecording`；新增 `recording` 事件型別。
   - **修掉 data-loss bug**：原先「先清錄音再送 Gemini」失敗即丟失整段；改成 **peek 不清空、精修成功才 `clearRecording()`**，失敗保留可重試。

### 關鍵決定 / 事實
- sidecar 啟動用 `start-leo-work.bat` 獨立視窗（耐用），別靠 Claude 背景程序。
- 即時粗稿語言漂移是已知；**精修版（/transcribe、/router/transcribe）才是最終可存檔稿**。
- Gemini 免費層 **20 req/min** 限流（連續測會 429，會保留錄音重試）；router 錄音上限 **600s**（超過 truncated）。
- 非加密/碰錢程式，依 CLAUDE.md 未跑 `/code-review`（但自查並修了 data-loss bug）。

### 目前狀態
- 驗證全綠：typecheck ×2 exit 0、**vitest 95/95**（+4 錄音緩衝測試）、vite build OK。
- Feature A 端到端實測通過：手機收音→停止→精修回 `[00:00] 發言人1: 我們決定第三季主打訂閱制…`（乾淨繁體，無日文漂移），並驗證失敗後不重串流、只重打即成功（retry-safety）。
- App 跑在 http://localhost:1420（start-leo-work.bat 獨立視窗）。多檔未 commit（含先前 A+B 舊變更 + 本次 feature A）。

### 待辦 / 下一步（未做）
- （選）即時粗稿語言漂移：研究幫 Gemini Live 加語言提示（CP 值低，精修已蓋掉）。
- 藍牙仍不可用（未裝 noble + PM01-9 GATT 私有）。
- （選）commit 本機變更 / 上 GitHub（建私有 repo「Leo-work」+ 放行 token → 加乾淨 remote）。
- Phase 4 UI 美化：等庭晰指定畫面。

---

## 2026-06-15（續）— 電腦系統走 Gemini 逐字稿(A) + 手機收音改 WSS 橋接(B)

### 這段做了什麼
背景：RouterPanel 三來源面板（電腦系統/手機/藍牙）原本只有「電腦系統」勉強能收音、且逐字稿走 whisper（未設定→不出字）；「手機即時(WebRTC)」缺手機端頁用不了；藍牙缺 noble。庭晰要求做 A+B。

1. **A — 電腦系統／手機收音都能出 Gemini 逐字稿（不必裝 whisper）**
   - `src/services/audio/types.ts` 新增 `TranscriberLike` 契約（push/flush/reset/windowSec/enabled）。
   - **新檔** `src/services/audio/GeminiStreamingTranscriber.ts`：用既有 `GeminiLiveService` 包成相容轉寫器——router 餵的 16kHz Float32 PCM → Int16LE base64 → Gemini Live，背景累積 `inputTranscription` 文字，`flush()` 吐成 segment（時間軸用「已餵樣本/16kHz」推算）、收 CJK 字間空格；後端可注入（測試用假後端）。
   - `AudioIngestionRouter.ts`：transcriber 型別由 `StreamingTranscriber` 放寬到 `TranscriberLike`。
   - `server.ts`：whisper 沒設（WHISPER_BIN/MODEL_PATH）但有 `GEMINI_API_KEY` → router 改用 `GeminiStreamingTranscriber`；否則沿用 whisper。
   - **新測試** `__tests__/gemini-transcriber.test.ts`（7 項）。

2. **B — 手機收音改用「已測試的 WSS 橋接」（庭晰選的方向，非 WebRTC）**
   - 關鍵發現：`PhoneBridge extends CaptureSource` → 直接用既有 `CaptureSourceAdapter(phoneBridge,"webrtc")` 當 router 手機來源，**不必寫新 adapter**。
   - `server.ts`：router 的 webrtc 來源 `webrtcSource` → `phoneSource`（WSS 橋接）。`WebRtcSoftwareSource` + `/webrtc/*` 信令**保留**為未來真 WebRTC 備援。
   - `RouterPanel.tsx`：按鈕「📱 手機即時(WebRTC)」→「📱 手機收音」、狀態「WebRTC 即時串流」→「手機收音中」、點選後抓 `/audio/session` 顯示 **QR + 三步驟連線指引**（重用既有路由）。

3. **README 音訊段落更新**：雙軌引擎表後加「目前面板接線」說明、驗證狀態 84→**91**、補「未裝 whisper 時自動改用 Gemini Live」。

### 關鍵決定 / 事實
- B 的叉路（真 WebRTC vs 重用 WSS 橋接）由庭晰拍板：**重用已通過整合測試的 WSS PhoneBridge**（可靠、可驗證；真 WebRTC 在無手機 + werift 互通下這台機器測不了）。按鈕改「手機收音」誠實反映底層是 WSS。
- 電腦系統(local) 與手機收音(webrtc 槽) 都共用 router 的 `GeminiStreamingTranscriber` → 不裝 whisper 也出即時粗稿（雲端、需網路；非整檔精修）。
- 沒動加密/碰錢程式，故未跑 `/code-review`（CLAUDE.md 只要求碰錢/加密才跑）。

### 目前狀態
- 驗證全綠：typecheck ×2 exit 0、vitest **91/91**（84+7）、vite build OK。
- 後端 smoke：啟 sidecar → 打「手機收音」→ PhoneBridge 起自簽 HTTPS、`/audio/session` 回真 QR（`https://<LAN-IP>:8443/m?token=…`）→ deactivate 乾淨；sidecar 收掉、port 釋放。

### 待辦 / 下一步（未做）
- **真實裝置實測**（這台機器測不了）：①A 對麥克風講話 → 看 Gemini 是否即時出字；②B 真手機掃 QR 收音（傳輸層 WSS 已有整合測試）。
- 藍牙仍不可用（未裝 noble + PM01-9 GATT 私有），維持現狀。
- 續存：Phase 4 UI 美化、（選）上 GitHub。

---

## 2026-06-15 — Gemini 死 key 換新已驗證 + README 修正 + 建專案 CLAUDE.md

### 這段做了什麼
1. **建 `D:\Leo work\CLAUDE.md`**：精簡版專案指南（專案邊界／環境硬事實／架構一句話／雙 tsconfig／驗證流程／git 安全／程式碼偏好／「存對話」routine），在此專案工作時自動載入；深入細節指向 skill + 本日誌 + README，不重複。
2. **修 README 三處 LLM 不一致**：技術棧表、目錄結構、四階段對照原本只寫「Ollama 預設」、**漏了 Gemini**。改成「**Gemini 現用預設** / Ollama 程式內建 fallback / Claude 付費」，並標明轉錄・即時逐字稿・AI 助理對話固定走 Gemini。README 開頭「💰 預設零成本(Ollama)」**刻意不動**——程式零設定 fallback 確實仍是 Ollama。
3. **🔴 揪出並修好 Gemini 死 key**：`.env` 的 `GEMINI_API_KEY` 原來還是投資系統 2026-06-14 已撤銷的外洩舊 key（`AIzaSyBV…CiXQ`）→ 轉錄／即時稿／AI 助理三大功能其實都壞著（認證會失敗）。庭晰換成新版 key（`AQ.…` 53 碼新格式）。**已端到端實測**：列模型 HTTP 200（50 模型可用）、`gemini-2.5-flash` generateContent HTTP 200 有生成 → 認證恢復正常。

### 關鍵決定 / 事實
- Leo work `.env` 與投資系統共用同一把 Gemini key 來源；本次**只改 Leo work `.env`**，沒碰投資專案。
- LLM_PROVIDER 真相：程式碼 fallback＝`ollama`（`server.ts` `?? "ollama"`），但實際 `.env`＝`gemini`；且 STT／Live／chat 三項固定走 Gemini（與 LLM_PROVIDER 無關）。

### 目前狀態
- Gemini 三大功能認證恢復（已驗證新 key 有效＋有額度）。
- README / CLAUDE.md 已同步。本次**沒動程式碼**，typecheck/test 不受影響（仍維持上次 84/84 全綠）。

### 待辦 / 下一步（未做）
- Phase 4 UI 美化：等庭晰指定畫面要調哪裡。
- （選）上 GitHub：建私有 repo「Leo-work」+ 放行 token → 加乾淨 remote + push。

---

## 2026-06-14 — 混合式即時逐字稿 + 轉錄語言 + 備份/日誌機制

### 這段做了什麼
1. **AI 助理面板改可收合**（`08cf8eb`）：底部「🦉 AI 助理」預設收起成一條細條，點開才問，問完按「▾ 收起」，讓逐字稿有完整高度。
2. **混合式即時逐字稿**（`6832e89`）：
   - 錄音中把麥克風 16kHz PCM 經新的 `/live` WebSocket 串流給 sidecar → `GeminiLiveService.ts` 轉接 Gemini Live API（`inputAudioTranscription`）→ 邊講邊出「即時粗稿」。
   - 按停止後沿用 `/transcribe` 對整檔精修，用乾淨版（繁體/時間戳/發言人）覆蓋粗稿。
   - 為何不用「每分鐘切塊」：切塊會切爛斷句、發言人跨塊錯亂、時間戳誤差累積。
3. **轉錄語言可選**（`1f55f52`）：逐字稿面板右上下拉＝自動／一律繁中／一律英文。控制「停止後精修版」輸出語言。
4. **README + skill + 日誌**：
   - README 補會議工作流與 Gemini 環境變數（`7938334`）。
   - 維護 skill 大改：兩個專案 → 單一 Leo work（D:\），測試數 84，補 Gemini 服務/會議工作流/已知雷 #9。正本在 `~/.claude/skills/proactor-recorder/SKILL.md`，**D 槽備份鏡像** `docs/maintenance-skill.md`（`a5f5a54`）。
5. **修 auto 模式中譯漏掉**（`0f1d476`）：原提示太軟，多行英文時 Gemini 整批省略中譯。實測後改成硬性規定，端到端確認每行英文都附全形括號繁中譯。

### 關鍵決定 / 事實
- **AI 全走 Gemini**（`.env` `LLM_PROVIDER=gemini`，免費額度、不吃 GPU、中文強）；錄音轉錄/即時逐字稿/AI 助理對話需 `GEMINI_API_KEY`，與 LLM_PROVIDER 無關。
- 即時逐字稿模型 `gemini-3.1-flash-live-preview`（bidi 只支援 AUDIO 輸出，逐字稿靠 `inputAudioTranscription`）。
- 即時粗稿是 STT 原始輸出（可能簡體/字間空格/雜音亂猜），**以停止後精修版為準**；粗稿只是預覽。
- **未上 GitHub**：D:\Leo work 是獨立 git repo（branch main、**無 remote**），目前 11 個 commit 全在本機。現有 fine-grained PAT 只授權 hsinchun-capital-2026 + angela1024 兩 repo，要上傳需庭晰先在 GitHub 建私有 repo「Leo-work」+ 放行 token（決定先維持純本機）。

### 目前狀態
- 雙 typecheck + vite build 通過；vitest 84 項全綠。
- App 跑在 http://localhost:1420（`npm run dev` 或 `start-leo-work.bat`）。

### 待辦 / 下一步（未做）
- Phase 4 UI 美化：等庭晰指畫面具體要調哪裡。
- 之後若要上 GitHub：建私有 repo「Leo-work」+ 放行 token → 加乾淨 remote + push（步驟見上）。
- 「存對話」流程：庭晰說「存對話」→ 我 append 此檔一筆 → 庭晰 `/clear`。
