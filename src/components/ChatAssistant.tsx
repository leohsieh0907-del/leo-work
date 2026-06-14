// ── AI 助理聊天面板 ──
// 對話式問答；後端結合「當前會議逐字稿 + 跨會議記憶」用 Gemini 回答，記得對話脈絡。

import { useState, type KeyboardEvent } from "react";
import { chat } from "../lib/api";
import type { ChatTurn } from "../shared/types";

const SUGGESTIONS = [
  "幫我總結這場會議的三個重點",
  "有哪些待辦？誰負責、何時交？",
  "這場會議跟過去有沒有衝突？",
];

export default function ChatAssistant({
  transcript,
  onCollapse,
}: {
  transcript: string;
  onCollapse?: () => void;
}) {
  const [messages, setMessages] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  async function send(text?: string) {
    const q = (text ?? input).trim();
    if (!q || loading) return;
    const history = messages;
    setMessages((m) => [...m, { role: "user", text: q }]);
    setInput("");
    setLoading(true);
    try {
      const r = await chat({ question: q, transcript, history });
      setMessages((m) => [...m, { role: "assistant", text: r.answer }]);
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

  return (
    <section className="flex h-full flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-lg">🦉</span>
        <h2 className="text-sm font-semibold text-slate-200">AI 助理</h2>
        <span className="text-xs text-slate-500">問當前會議 ＋ 跨會議記憶</span>
        <div className="ml-auto flex items-center gap-3">
          {messages.length > 0 && (
            <button
              onClick={() => setMessages([])}
              className="text-xs text-slate-500 hover:text-slate-300"
            >
              清空
            </button>
          )}
          {onCollapse && (
            <button
              onClick={onCollapse}
              className="text-xs text-slate-500 hover:text-slate-300"
            >
              ▾ 收起
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto rounded-lg border border-white/10 bg-brand-dark/40 p-3">
        {messages.length === 0 ? (
          <div className="space-y-3">
            <p className="text-sm text-slate-400">
              需要什麼？直接問我——我看得到目前的逐字稿，也記得你存過的歷史會議。
            </p>
            <div className="flex flex-wrap gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => void send(s)}
                  className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-300 transition hover:bg-white/10"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m, i) => (
            <div key={i} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
              <div
                className={`max-w-[85%] whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-sm leading-relaxed ${
                  m.role === "user" ? "bg-brand text-white" : "bg-brand-panel text-slate-100"
                }`}
              >
                {m.text}
              </div>
            </div>
          ))
        )}
        {loading && (
          <div className="flex justify-start">
            <div className="rounded-lg bg-brand-panel px-3 py-2 text-sm text-slate-400">思考中…</div>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
          placeholder="請輸入問題…（Enter 送出）"
          className="flex-1 rounded-md border border-white/10 bg-brand-dark/60 px-3 py-2 text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-brand"
        />
        <button
          onClick={() => void send()}
          disabled={loading}
          className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-white transition hover:bg-brand/80 disabled:opacity-50"
        >
          送出
        </button>
      </div>
    </section>
  );
}
