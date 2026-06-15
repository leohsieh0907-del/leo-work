# Leo work — 專案指南（給 Claude Code 自動載入）

> 桌面錄音 / AI 會議助理。Tauri 外殼 + React webview + Node sidecar（全 TS）。
> 深入細節看：skill `proactor-recorder`、`docs/worklog.md`（進度）、`README.md`（架構）。

## ⚠️ 專案邊界
- 只處理 **`D:\Leo work`** 這個錄音 App。
- **絕不碰** 投資系統（昕圳／investment_company）、readle-app、璟松旅遊——別被它們的觸發詞拉走。

## 語言
- 一律**繁體中文**溝通；技術術語可留英文。回應簡潔、直接給結論，不要多餘客套或結尾總結。

## ⚠️ 環境硬事實（決定一切）
- 本機有 **Node 24 + npm**，**沒有 Rust / cargo / MSVC / cmake**。
- 所以 **Tauri 外殼（Rust）無法在本機編譯驗證**——只能驗 TS/Node。當初選「全 TS + Node sidecar」就是為了能在本機完整驗證。

## 架構（一句話）
Tauri 視窗 → React webview（前端 `src/`）──HTTP/WS──► Node sidecar（`src/server.ts` + `src/services/`，只綁 `127.0.0.1`）。
- 前端是 webview，跑不了 Node 原生套件（LanceDB、ONNX、`crypto`、`ws`…），所以重服務全放 sidecar。
- **AI 全走 Gemini**（`.env` `LLM_PROVIDER=gemini`）；轉錄／即時逐字稿／AI 助理對話需 `GEMINI_API_KEY`。

## 雙 tsconfig（務必理解）
- `tsconfig.json` = 前端（DOM lib，exclude `src/services`、`src/server.ts`）。
- `tsconfig.sidecar.json` = sidecar（Node types，含 `src/services` + `src/server.ts` + `src/shared`）。
- **前後端共用型別一律放 `src/shared/types.ts`**（兩邊都 include）。

## 驗證流程（改完一定跑，全綠才算數）
```powershell
cd "D:\Leo work"
npm run typecheck     # 前端 + sidecar 兩套 tsconfig，必須兩個都 exit 0
npm test              # vitest（目前 84 項：加密/切片/WAV/AGC/VU/同步/引擎/雙軌/續傳/手機橋接）
npx vite build        # 前端打包確認
```
- **碰加密 / 碰錢的程式**（`SecurityManager` 等）改完，commit 前先跑 `/code-review`（medium），回報「🔴 主要問題」，沒問題或修完才 commit。
- 靠真音訊的功能（Gemini Live / 即時逐字稿）可用 Gemini TTS 合成語音灌進 `/live`、`/transcribe` 做端到端實測（測完刪暫存腳本）。

## git / 安全
- 獨立 repo（branch `main`，**無 remote**）。**不主動 push**；要上 GitHub 需庭晰先建私有 repo + 放行 token。
- `.env`、`/data`、`*.enc` 已 gitignore——**金鑰、加密檔絕不進 git**。commit 前確認。
- 改 `ENCRYPTION_SALT` 會讓舊加密檔失效，別亂動。

## 程式碼偏好
- 繁中註解、簡潔、不過度抽象、不加多餘錯誤處理（除非規格明示防呆）。
- 優先改現有檔，不輕易新增檔。
- **改完程式同步更新對應文件**（README / skill），避免「程式對但文件舊」。
- 動手前先看 skill 的「已知雷」段落，避免重犯踩過的坑（尤其 TS 5.7 Float32Array 泛型、WSS close 卡死、Gemini Live bidi 只支援 AUDIO 等）。

## 除錯
- 遇到「慢／壞掉」先實測找根因（看 log、實際回傳格式、量化延遲），不要連續臆測硬改。

## 「存對話」routine
庭晰說「存對話」→ 在 `docs/worklog.md` 最上面 append 一筆有日期的紀錄（做了什麼／關鍵決定／目前狀態／待辦）→ 提醒他可 `/clear` 開新對話，下次讀 worklog + 此檔 + skill + README 即可接續。

---
*最後更新：2026-06-15*
