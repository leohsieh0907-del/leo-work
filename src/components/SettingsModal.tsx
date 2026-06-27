import { useEffect, useState } from "react";
import type { ConfigStatus } from "../shared/types";
import { getConfig, saveConfig } from "../lib/api";
import { relaunchApp } from "../lib/updater";

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
