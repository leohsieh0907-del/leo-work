// ── LLM 服務統一介面 ──
// ClaudeService 與 OllamaLlmService 都實作此介面；server.ts 只認這個型別，
// 由 LLM_PROVIDER 決定實際用本地 Ollama（預設、$0）還是 Claude API（選配、付費）。

import type { ProactiveAnalysis, ActionItem } from "../../shared/types";

export interface LlmService {
  /** 主動式分析：當前逐字稿 + 歷史背景 → 結構化 JSON（含歷史衝突比對）。 */
  generateProactiveAnalysis(
    currentTranscript: string,
    historicalContext: string,
  ): Promise<ProactiveAnalysis>;

  /** 提取行動方針（任務/負責人/截止日，相對日期換算成具體日期）。 */
  extractActionItems(transcript: string): Promise<ActionItem[]>;

  /** 翻譯逐字稿並保留 `[mm:ss] 發言人:` 格式。 */
  translateWithTimestamps(transcript: string, targetLanguage: string): Promise<string>;
}
