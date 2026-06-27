// ── FallbackLlmService — 主力 + 後援 ──
// 文字任務先打主力（Gemini，顧繁中品質）；主力丟錯（過載 503 / 限流 429 / 空回應等）
// 就自動改打後援（Groq，快、額度大）。後援也失敗才把錯誤往上拋。
// 涵蓋：分析 / 行動方針 / 翻譯 / 合併分析 / 聊天。
// （整檔精修改由 server 層 transcribeWithFallback 走 Groq Whisper 後援；即時逐字稿 Live 仍 Gemini 專屬。）

import type {
  ProactiveAnalysis,
  ActionItem,
  ChatTurn,
  ComposeExportRequest,
  ComposedDoc,
} from "../shared/types";
import type { LlmService } from "./llm/types";

/** 主力/後援都需提供的文字能力（GeminiLlmService 與 GroqLlmService 皆滿足）。 */
export interface FallbackableLlm extends LlmService {
  analyzeAll(
    currentTranscript: string,
    historicalContext: string,
  ): Promise<{ analysis: ProactiveAnalysis; actionItems: ActionItem[] }>;
  chat(
    question: string,
    currentTranscript: string,
    memoryContext: string,
    history: ChatTurn[],
  ): Promise<{ answer: string; suggestions: string[] }>;
  composeExportDoc(req: ComposeExportRequest): Promise<ComposedDoc>;
}

export class FallbackLlmService implements LlmService {
  private readonly primary: FallbackableLlm;
  private readonly fallback: FallbackableLlm;
  private readonly label: string;

  constructor(primary: FallbackableLlm, fallback: FallbackableLlm, label = "Groq 後援") {
    this.primary = primary;
    this.fallback = fallback;
    this.label = label;
  }

  private async run<T>(name: string, fn: (s: FallbackableLlm) => Promise<T>): Promise<T> {
    try {
      return await fn(this.primary);
    } catch (e) {
      console.warn(
        `[fallback] ${name} 主力失敗，改用 ${this.label}：${e instanceof Error ? e.message : String(e)}`,
      );
      return await fn(this.fallback);
    }
  }

  generateProactiveAnalysis(currentTranscript: string, historicalContext: string): Promise<ProactiveAnalysis> {
    return this.run("analysis", (s) => s.generateProactiveAnalysis(currentTranscript, historicalContext));
  }

  extractActionItems(transcript: string): Promise<ActionItem[]> {
    return this.run("actionItems", (s) => s.extractActionItems(transcript));
  }

  translateWithTimestamps(transcript: string, targetLanguage: string): Promise<string> {
    return this.run("translate", (s) => s.translateWithTimestamps(transcript, targetLanguage));
  }

  analyzeAll(
    currentTranscript: string,
    historicalContext: string,
  ): Promise<{ analysis: ProactiveAnalysis; actionItems: ActionItem[] }> {
    return this.run("analyzeAll", (s) => s.analyzeAll(currentTranscript, historicalContext));
  }

  chat(
    question: string,
    currentTranscript: string,
    memoryContext: string,
    history: ChatTurn[],
  ): Promise<{ answer: string; suggestions: string[] }> {
    return this.run("chat", (s) => s.chat(question, currentTranscript, memoryContext, history));
  }

  composeExportDoc(req: ComposeExportRequest): Promise<ComposedDoc> {
    return this.run("composeExportDoc", (s) => s.composeExportDoc(req));
  }
}
