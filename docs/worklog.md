# Leo work 工作日誌

> 用途：每次庭晰說「**存對話**」時，把該段對話的重點（做了什麼、關鍵決定、目前狀態、待辦）寫成一筆有日期的紀錄，append 在最上面（最新在上）。寫完庭晰可 `/clear` 清空對話，下次讀此檔 + CLAUDE.md + skill + README 即可快速接續。
>
> 這是「人看的進度紀錄」，不是完整對話備份；完整逐字對話另有 Claude Code 自動存的 session 檔（.jsonl）。

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
