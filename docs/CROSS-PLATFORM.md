# Leo work — 跨平台安裝檔 + 自動更新（GitHub 流程）

讓 Leo work 在 **Windows / macOS / Linux** 都能下載安裝、當 App 開，並在你發新版後**各裝置自動更新**。
換電腦 / 換作業系統時不被綁死：CI 會替每個 OS 各 build 一份安裝檔。

> ⚠️ **本機沒有 Rust/MSVC，無法 build 安裝檔**。安裝檔一律由 **GitHub Actions** 在雲端三個 OS 的 runner 上產出。

---

## 目前進度

| # | 里程碑 | 狀態 |
|---|--------|------|
| 0 | 自動更新簽章金鑰 | ✅ 已產生（`~/.tauri/leo-work-updater.key`，公鑰已寫進 `tauri.conf.json`） |
| 1 | CI（三 OS build）+ updater 設定 | ✅ 已寫好（`.github/workflows/release.yml`） |
| 2 | sidecar 打包 + 開機 spawn | 🟡 打包腳本已驗證可產出（Windows 實測）；Tauri build/spawn 待 CI 驗證 |
| 3 | 正式版執行期設定（salt 自動產生 + 設定畫面輸入 `GEMINI_API_KEY`） | ✅ 完成（3a `5facba7`、3b `a35ce4d`） |
| 4 | 前端「有新版→更新」提示 | ✅ 已接（`src/lib/updater.ts` + `App.tsx` 橫幅） |
| 5 | 跨平台圖示（macOS `.icns`） | ✅ CI 內 `npx tauri icon` 自動產 |
| 6 | macOS/Linux 系統收音（`dshow` 是 Windows 限定） | ⏳ 後續；先降級只錄麥克風 |

**白話**：建置/發佈管線 + 執行期設定都已就緒——正式版會**自動產生加密 salt**（首次啟動、永不重生）、用 **⚙️ 設定畫面**輸入 Gemini 金鑰（存 `config.json`，重啟生效）。剩下就靠 CI 實際 build 一次，驗證 sidecar 打包/spawn 真的能起來。

---

## 你要做的事（一次性設定）

### 1) 建一個**私有** GitHub repo
名稱建議 `leo-work`。若**帳號/repo 名不是** `leohsieh0907-del/leo-work`，請改 `src-tauri/tauri.conf.json` 的
`plugins.updater.endpoints`（把 `leohsieh0907-del/leo-work` 換成你的 `<帳號>/<repo>`）。

### 2) 設定 1 個 Secret（給 CI 簽章用）
repo → **Settings → Secrets and variables → Actions → New repository secret**：
- 名稱：`TAURI_SIGNING_PRIVATE_KEY`
- 值：把檔案 **`C:\Users\user\.tauri\leo-work-updater.key`** 的**全部內容**貼進去
  （⚠️ 這是私鑰，只在 GitHub Secret 欄位貼，**別貼到任何對話/聊天**）
- 金鑰沒設密碼，所以 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 這個 secret **可以不建**（視為空）。

> 🔑 私鑰請另外備份（換電腦要用同一把才能繼續發更新；遺失＝舊安裝無法再收到你的更新）。

### 3) 推上去
```powershell
cd "D:\Leo work"
git remote add origin https://github.com/<帳號>/leo-work.git
git push -u origin main
```

### 4) 發一版（觸發 CI build）
```powershell
git tag v0.1.0
git push origin v0.1.0
```
→ Actions 會在三個 OS 各 build 一份，發到 **Releases（草稿）**。
進 Releases 把草稿 **Publish** → 安裝檔可下載，且已安裝的 App 下次啟動會收到更新。

---

## 各平台安裝
- **Windows**：下載 `.exe`（NSIS）安裝 → 開始功能表開啟、可釘工作列。
- **macOS**：下載 `.dmg` → 拖進「應用程式」。（未簽 Apple 開發者憑證 → 首次開要「右鍵 → 打開」繞過 Gatekeeper。）
- **Linux**：下載 `.AppImage` → `chmod +x` 後執行；或 `.deb`。

## 在有 Rust 的機器本機 build（選配，驗證用）
```powershell
npm ci
npm run build:release   # = typecheck + vite build + assemble:sidecar
npm run tauri:build     # 需 Rust + MSVC（macOS 需 Xcode CLT）
```

---

## 已知問題 / 後續優化
- **sidecar 約 437 MB**（`onnxruntime-node` + `sharp` 為本地嵌入用）→ 若主要用 Gemini，可改 `EMBEDDING_PROVIDER` 不裝本地 ONNX 大幅瘦身。
- ~~里程碑 3（執行期密鑰）~~ ✅ 已完成：salt 首次啟動產生存 app 資料夾、Gemini 金鑰用 ⚙️ 設定畫面輸入（存 `config.json`，重啟生效）。
- **sidecar 結束清理**：`lib.rs` spawn 後尚未在 App 關閉時 kill sidecar（避免 127.0.0.1:8765 殘留）。
- **macOS Intel**：目前 `macos-latest` 是 arm64；要 Intel 版再加 `macos-13` 到 CI matrix。
- **CI `npm ci` 需 `package-lock.json`**：確認它有被 commit。
