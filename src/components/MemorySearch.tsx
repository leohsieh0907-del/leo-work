// ── 跨會議記憶檢索 ──
// 搜尋框 → queryMemory，回傳組裝好的歷史背景文字以 whitespace-pre-wrap 顯示。
// 模擬「上週與 A 客戶開會提到的預算上限？」這類跨會議提問。

import { useState, type KeyboardEvent } from "react";
import { queryMemory } from "../lib/api";

export default function MemorySearch() {
  const [query, setQuery] = useState("");
  const [context, setContext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSearch() {
    if (!query.trim()) {
      setError("請輸入問題");
      return;
    }
    setLoading(true);
    setError(null);
    setContext(null);
    try {
      const r = await queryMemory({ query, limit: 3 });
      setContext(r.context);
    } catch (e) {
      setError(e instanceof Error ? e.message : "檢索失敗");
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") handleSearch();
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-200">跨會議記憶檢索</h2>
        <span className="text-xs text-slate-500">問過去會議的問題</span>
      </div>

      <div className="flex items-center gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="例：上週與 A 客戶開會提到的預算上限是多少？"
          className="flex-1 rounded-md border border-white/10 bg-brand-dark/60 px-3 py-2 text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-brand"
        />
        <button
          onClick={handleSearch}
          disabled={loading}
          className="rounded-md bg-brand px-3 py-2 text-sm font-medium text-white transition hover:bg-brand/80 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? "檢索中…" : "搜尋"}
        </button>
      </div>

      {error && <p className="text-xs text-brand-danger">{error}</p>}

      {context !== null && (
        <div className="rounded-lg border border-white/10 bg-brand-panel p-3">
          <div className="mb-2 text-xs font-semibold text-brand-accent">檢索到的歷史背景</div>
          {context.trim() ? (
            <pre className="whitespace-pre-wrap break-words font-mono text-sm leading-relaxed text-slate-100">
              {context}
            </pre>
          ) : (
            <p className="text-sm text-slate-500">沒有找到相關的歷史會議內容。</p>
          )}
        </div>
      )}
    </section>
  );
}
