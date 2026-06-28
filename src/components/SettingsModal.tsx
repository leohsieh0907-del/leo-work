import { useEffect, useState } from "react";
import type { Update } from "@tauri-apps/plugin-updater";
import type { ConfigStatus } from "../shared/types";
import { getConfig, saveConfig, shutdownSidecar } from "../lib/api";
import { relaunchApp, checkForUpdate, installUpdateAndRelaunch, isDesktopApp, killSidecars } from "../lib/updater";

// 正式版設定畫面：輸入 Gemini 金鑰、選 LLM 來源 → 存進 app 資料夾 config.json（重啟生效）。
export default function SettingsModal({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<ConfigStatus | null>(null);
  const [geminiKey, setGeminiKey] = useState("");
  const [groqKey, setGroqKey] = useState("");
  const [provider, setProvider] = useState("ollama");
  const [model, setModel] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedNeedRestart, setSavedNeedRestart] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 版本與更新
  const [checking, setChecking] = useState(false);
  const [update, setUpdate] = useState<Update | null>(null);
  const [updating, setUpdating] = useState(false);
  const [updateMsg, setUpdateMsg] = useState<string | null>(null);

  useEffect(() => {
    getConfig()
      .then((s) => {
        setStatus(s);
        setProvider(s.llmProvider);
        setModel(s.geminiModel ?? "");
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const update: {
        geminiApiKey?: string;
        groqApiKey?: string;
        llmProvider?: string;
        geminiModel?: string;
      } = {
        llmProvider: provider,
        geminiModel: model,
      };
      if (geminiKey.trim()) update.geminiApiKey = geminiKey.trim(); // 留空＝不變更既有金鑰
      if (groqKey.trim()) update.groqApiKey = groqKey.trim();
      const r = await saveConfig(update);
      setSavedNeedRestart(r.restartRequired);
      setGeminiKey("");
      setGroqKey("");
      setStatus(await getConfig());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  // 主動檢查更新：有新版存起來顯示「立即更新」；沒有就顯示「已是最新」；網頁版提示用桌面版。
  async function handleCheckUpdate() {
    setChecking(true);
    setUpdate(null);
    setUpdateMsg(null);
    try {
      const u = await checkForUpdate();
      if (u) setUpdate(u);
      else
        setUpdateMsg(
          isDesktopApp()
            ? `✅ 已是最新版 v${__APP_VERSION__}`
            : "網頁版不支援自動更新，請改用桌面版 App",
        );
    } catch (e) {
      setUpdateMsg(e instanceof Error ? e.message : "檢查更新失敗");
    } finally {
      setChecking(false);
    }
  }

  // 下載安裝新版並重啟（同 App.tsx 橫幅：先關 sidecar 釋放檔鎖再裝，見 server.ts /shutdown）。
  async function handleApplyUpdate() {
    if (!update) return;
    setUpdating(true);
    setUpdateMsg(null);
    try {
      await shutdownSidecar();
      await new Promise((r) => setTimeout(r, 600));
      await killSidecars(); // 強殺殘留/孤兒 leo-node，釋放檔鎖
      await new Promise((r) => setTimeout(r, 300));
      await installUpdateAndRelaunch(update);
    } catch (e) {
      setUpdateMsg(e instanceof Error ? e.message : "更新失敗，請稍後再試");
      setUpdating(false);
    }
  }

  const inputCls =
    "w-full rounded-md border border-line bg-inset px-3 py-2 text-sm outline-none focus:border-brand";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl border border-line bg-brand-panel p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center">
          <h2 className="text-base font-semibold">⚙️ 設定</h2>
          <button onClick={onClose} className="ml-auto text-fg-subtle hover:text-fg">
            ✕
          </button>
        </div>

        {error && (
          <div className="mb-3 rounded-md border border-red-400/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
            {error}
          </div>
        )}

        {/* 版本與更新：主動「檢查更新」→ 有新版可一鍵下載重啟 */}
        <div className="mb-4 rounded-md border border-line bg-inset px-3 py-2.5">
          <div className="flex items-center gap-3">
            <div className="text-sm">
              <span className="text-fg-muted">目前版本 </span>
              <span className="font-mono text-fg">v{__APP_VERSION__}</span>
            </div>
            <button
              onClick={() => void handleCheckUpdate()}
              disabled={checking || updating}
              className="ml-auto rounded-md border border-line bg-hover-weak px-3 py-1.5 text-sm text-fg transition hover:bg-hover disabled:opacity-50"
            >
              {checking ? "檢查中…" : "檢查更新"}
            </button>
          </div>
          {update && (
            <div className="mt-2 flex items-center gap-3 rounded-md border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-sm">
              <span>✨ 有新版 v{update.version}</span>
              <button
                onClick={() => void handleApplyUpdate()}
                disabled={updating}
                className="ml-auto rounded-md bg-brand px-3 py-1 text-white transition hover:opacity-90 disabled:opacity-50"
              >
                {updating ? "更新中…" : "立即更新並重啟"}
              </button>
            </div>
          )}
          {updateMsg && <p className="mt-2 text-xs text-fg-faint">{updateMsg}</p>}
        </div>

        <label className="mb-1 block text-sm text-fg-muted">
          Gemini API 金鑰
          {status?.hasGeminiKey && (
            <span className="ml-2 text-xs text-emerald-400">✅ 已設定（留空＝不變更）</span>
          )}
        </label>
        <input
          type="password"
          value={geminiKey}
          onChange={(e) => setGeminiKey(e.target.value)}
          placeholder={status?.hasGeminiKey ? "••••••（已設定）" : "貼上 AIza... 金鑰"}
          className={`mb-1 ${inputCls}`}
        />
        <p className="mb-4 text-xs text-fg-faint">
          錄音轉錄 / AI 助理 / 即時逐字稿需要；到 Google AI Studio 免費申請。
        </p>

        <label className="mb-1 block text-sm text-fg-muted">
          Groq API 金鑰（後援）
          {status?.hasGroqKey && (
            <span className="ml-2 text-xs text-emerald-400">✅ 已設定（留空＝不變更）</span>
          )}
        </label>
        <input
          type="password"
          value={groqKey}
          onChange={(e) => setGroqKey(e.target.value)}
          placeholder={status?.hasGroqKey ? "••••••（已設定）" : "貼上 gsk_... 金鑰"}
          className={`mb-1 ${inputCls}`}
        />
        <p className="mb-4 text-xs text-fg-faint">
          Gemini 過載/限流時，分析・翻譯・聊天自動改用 Groq 接手；到 console.groq.com 免費申請。
        </p>

        <label className="mb-1 block text-sm text-fg-muted">LLM 來源（分析 / 翻譯）</label>
        <select
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
          className={`mb-4 ${inputCls}`}
        >
          <option value="ollama">Ollama（本地免費，需自行安裝）</option>
          <option value="gemini">Gemini（雲端免費額度，需金鑰）</option>
          <option value="claude">Claude（付費，需 ANTHROPIC_API_KEY）</option>
        </select>

        <label className="mb-1 block text-sm text-fg-muted">Gemini 模型（選填）</label>
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="gemini-2.5-flash"
          className={`mb-4 ${inputCls}`}
        />

        {savedNeedRestart ? (
          <div className="flex items-center gap-3 rounded-md border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-sm">
            <span>已儲存 ✓ 重啟後生效</span>
            <button
              onClick={() => void relaunchApp()}
              className="ml-auto rounded-md bg-brand px-3 py-1 text-white hover:opacity-90"
            >
              立即重啟
            </button>
          </div>
        ) : (
          <div className="flex justify-end gap-2">
            <button
              onClick={onClose}
              className="rounded-md px-3 py-1.5 text-sm text-fg-muted hover:text-fg"
            >
              取消
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="rounded-md bg-brand px-4 py-1.5 text-sm text-white hover:opacity-90 disabled:opacity-50"
            >
              {saving ? "儲存中…" : "儲存"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
