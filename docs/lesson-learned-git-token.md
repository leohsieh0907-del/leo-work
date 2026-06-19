# Lesson Learned：GitHub Token 不可內嵌在 remote URL

> 日期：2026-06-20 ｜ 類型：資安 / 開發習慣 ｜ 嚴重度：中高（已造成跨專案故障）
> 對事不對人，目的是把一次踩雷轉成可複用的團隊規範。

---

## 一、發生什麼事
leo-work 專案的 GitHub 認證 token（Personal Access Token, PAT）被**明碼寫死在 git 的 remote URL 裡**：

```
https://<帳號>:<token明碼>@github.com/leohsieh0907-del/leo-work.git
```

這串連同 token 一起存在 `.git/config`。

## 二、為什麼是問題
1. **token = 帳號密碼**：fine-grained PAT 能讀寫該 repo，等於把鑰匙明碼放在硬碟上。
2. **極容易外洩**：`git remote -v`、git 報錯訊息、螢幕分享、貼設定檔求助、雲端同步 / 備份硬碟……任何一個動作都會把它曝出來。（這次就是執行 `git remote -v` 當場現形。）

## 三、🔥 真正的教訓：它連鎖污染了「整台機器」的其他專案
這不只是「理論上有風險」，而是**實際造成了約一週的詭異 bug**：

- git 的 `credential.helper = store` 會把 URL 內嵌的認證**存進一個共用檔 `~/.git-credentials`，而且按 `github.com` 只存「一個槽」**。
- 於是 leo-work 的 token 把**同一台電腦上「另一個專案」的 token 蓋掉**。
- 結果：另一個專案每次 `git push` 都回 **403「Write access not granted」**，看起來像「權限突然被收回」「token 過期」，反覆 debug 卻查不到根因——因為**兇手在另一個專案**。

> **核心觀念**：一個 repo 的認證壞習慣，會透過共用的 credential store **污染整台機器上所有 GitHub repo**。這是「個人壞習慣 → 系統級故障」的典型案例。

## 四、怎麼修好的
1. remote 改回**乾淨 URL**（不含 token）：`https://github.com/leohsieh0907-del/leo-work.git`
2. token 交給 **credential helper** 管理（不寫進 URL）
3. 開 `git config --global credential.useHttpPath true` → 讓**每個 repo 的認證按完整路徑分開存、互不覆蓋**

## 五、✅ 正確做法（Checklist）
- [ ] **remote URL 一律乾淨**：`https://github.com/owner/repo.git`，**永不內嵌 `user:token@`**
- [ ] 認證交給 **credential helper**（Git Credential Manager 或 store），不手寫進 URL
- [ ] 多 repo 共用一台機器 → 開 **`credential.useHttpPath=true`**（認證分 repo 存）
- [ ] PAT 用 **fine-grained**：限定單一 repo、最小權限（Contents R/W）、**設到期日**
- [ ] token 集中放**一個 gitignore 的密鑰檔**，不散落、不貼對話 / 訊息
- [ ] **定期輪替**；一旦疑似曝光，立刻撤舊產新

## 六、⚠️ 立即善後（這次這把）
該 token 已視同外洩 → **到 GitHub 立刻撤銷 + 產一把新的**（fine-grained、限 leo-work、設到期日），換上乾淨流程。

---

### 附：自我檢查指令
```bash
# 看 remote 有沒有內嵌 token（正常應只有乾淨網址）
git remote -v

# 確認 useHttpPath 已開（多 repo 共機必開）
git config --global credential.useHttpPath

# 看 credential 共用檔有沒有殘留別把 token
#（檔案在 ~/.git-credentials；每行一個 URL，含密碼，勿外流）
```
