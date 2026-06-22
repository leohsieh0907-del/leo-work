// ── 記憶聊天（整頁）──
// 空狀態：歡迎 hero（標題 + 大輸入框 + 建議卡）；有對話：訊息串 + 輸入列。
// 走 /chat，transcript 傳空字串 → 純靠跨會議記憶回答（「您的記憶在內」）。

import { useState, type KeyboardEvent } from "react";
import { chat } from "../lib/api";
import type { ChatTurn } from "../shared/types";

// 建議卡：點一下就把 prompt 當問題送出。
const SUGGESTIONS: { icon: string; label: string; prompt: string }[] = [
  { icon: "📄", label: "每週報告", prompt: "根據本週會議記錄草擬每週報告要點。" },
  { icon: "📞", label: "客戶評審", prompt: "列出上週電話中客戶的三大需求。" },
  { icon: "📊", label: "練習測驗", prompt: "根據今天的課程建立個人化測驗。" },
  { icon: "📝", label: "常見問題生成", prompt: "根據最近的客服來電生成 10 條常見問題（FAQ）。" },
  { icon: "📃", label: "合約起草", prompt: "根據最新會議決議和討論要點生成一份新的 NDA。" },
  { icon: "🎯", label: "目標追蹤", prompt: "根據過去三個月的 OKR 審查建立進度報告。" },
  { icon: "💡", label: "創意挖掘", prompt: "列出團隊討論中尚未實施的前 5 個創意。" },
  { icon: "🎙️", label: "語調調整", prompt: "將昨晚的採訪改寫成 300 字的品牌故事，採用詼諧的語調。" },
  { icon: "🕵️", label: "風險篩查", prompt: "掃描所有過往會議總結，以識別並分類風險。" },
  { icon: "🌐", label: "翻譯", prompt: "將上週的市場分析筆記翻譯成英文，保留關鍵術語。" },
  { icon: "🎓", label: "考試複習", prompt: "從本學期的討論中提取 20 個關鍵主題用於考試複習。" },
];

export default function MemoryChat() {
  const [messages, setMessages] = useState<ChatTurn[]>([]);
  const [suggestions, setSuggestions] = useState<string[]>([]); // 上一則回答後的「接下來可做」建議
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  async function send(text?: string) {
    const q = (text ?? input).trim();
    if (!q || loading) return;
    const history = messages;
    setMessages((m) => [...m, { role: "user", text: q }]);
    setInput("");
    setSuggestions([]); // 送新問題就先收掉舊建議
    setLoading(true);
    try {
      // 記憶聊天沒有「當前逐字稿」，純靠跨會議記憶
      const r = await chat({ question: q, transcript: "", history });
      setMessages((m) => [...m, { role: "assistant", text: r.answer }]);
      setSuggestions(r.suggestions ?? []);
    } catch (e) {
      setMessages((m) => [
        ...m,
        { role: "assistant", text: "⚠️ " + (e instanceof Error ? e.message : "出錯了") },
      ]);
    } finally {
      setLoading(false);
    }
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  const started = messages.length > 0;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {started ? (
        // ── 對話進行中：訊息串 + 底部輸入 ──
        <>
          <div className="flex items-center gap-2 border-b border-white/10 px-6 py-3">
            <span className="text-lg">🦉</span>
            <h2 className="text-sm font-semibold text-slate-200">記憶聊天</h2>
            <span className="text-xs text-slate-500">跨會議記憶</span>
            <button
              onClick={() => {
                setMessages([]);
                setSuggestions([]);
              }}
              className="ml-auto text-xs text-slate-500 hover:text-slate-300"
            >
              ＋ 新對話
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-6 py-4">
            <div className="mx-auto flex max-w-3xl flex-col gap-3">
              {messages.map((m, i) => (
                <div key={i} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
                  <div
                    className={`max-w-[85%] whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-sm leading-relaxed ${
                      m.role === "user" ? "bg-brand text-white" : "bg-brand-panel text-slate-100"
                    }`}
                  >
                    {m.text}
                  </div>
                </div>
              ))}
              {loading && (
                <div className="flex justify-start">
                  <div className="rounded-lg bg-brand-panel px-3 py-2 text-sm text-slate-400">思考中…</div>
                </div>
              )}
              {!loading && suggestions.length > 0 && (
                <div className="flex flex-col gap-1.5 pt-1">
                  <span className="text-[11px] text-slate-500">💡 接下來可以…</span>
                  <div className="flex flex-wrap gap-2">
                    {suggestions.map((s) => (
                      <button
                        key={s}
                        onClick={() => void send(s)}
                        className="rounded-full border border-brand/40 bg-brand/10 px-3 py-1 text-xs text-slate-200 transition hover:bg-brand/20"
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="border-t border-white/10 px-6 py-4">
            <div className="mx-auto max-w-3xl">
              <InputBar
                input={input}
                loading={loading}
                onChange={setInput}
                onKey={onKey}
                onSend={() => void send()}
              />
            </div>
          </div>
        </>
      ) : (
        // ── 空狀態：歡迎 hero + 建議卡 ──
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-3xl px-6 py-12">
            <div className="mb-2 flex items-center justify-center gap-3">
              <span className="text-4xl">🦉</span>
              <h1 className="text-3xl font-bold text-slate-100">語音轉文字 可以幫您做些什麼？</h1>
            </div>
            <p className="mb-8 text-center text-lg font-medium text-slate-400">您的記憶在內</p>

            <InputBar
              input={input}
              loading={loading}
              onChange={setInput}
              onKey={onKey}
              onSend={() => void send()}
              big
            />

            <p className="mb-3 mt-10 text-sm text-slate-400">
              看看語音轉文字的記憶聊天能為您做些什麼：
            </p>
            <div className="divide-y divide-white/5 overflow-hidden rounded-xl border border-white/10 bg-brand-panel/40">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s.label}
                  onClick={() => void send(s.prompt)}
                  disabled={loading}
                  className="flex w-full items-center gap-4 px-5 py-3.5 text-left transition hover:bg-white/5 disabled:opacity-50"
                >
                  <span className="w-6 shrink-0 text-center text-xl">{s.icon}</span>
                  <span className="w-28 shrink-0 font-medium text-slate-200">{s.label}</span>
                  <span className="text-sm text-slate-400">{s.prompt}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// 圓角輸入列：右側送出箭頭。big 時用於 hero（較大內距）。
function InputBar({
  input,
  loading,
  onChange,
  onKey,
  onSend,
  big,
}: {
  input: string;
  loading: boolean;
  onChange: (v: string) => void;
  onKey: (e: KeyboardEvent<HTMLInputElement>) => void;
  onSend: () => void;
  big?: boolean;
}) {
  return (
    <div className="relative">
      <input
        value={input}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKey}
        placeholder="請輸入文字…"
        className={`w-full rounded-full border border-white/10 bg-brand-dark/60 pl-5 pr-14 text-slate-100 outline-none placeholder:text-slate-600 focus:border-brand ${
          big ? "py-4 text-base" : "py-3 text-sm"
        }`}
      />
      <button
        onClick={onSend}
        disabled={loading || !input.trim()}
        title="送出"
        className="absolute right-2 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-brand text-white transition hover:bg-brand/80 disabled:opacity-40"
      >
        ↑
      </button>
    </div>
  );
}
