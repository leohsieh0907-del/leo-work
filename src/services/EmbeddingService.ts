// ════════════════════════════════════════════════════════════════════
//  EmbeddingService — 文字 → 向量（多來源可切換）
//
//  三種來源：
//  • local（預設）：@xenova/transformers 的 all-MiniLM-L6-v2，完全離線，
//    維度 384。pipeline 採 lazy 載入並快取（首次呼叫才下載/載入模型）。
//  • openai：text-embedding-3-small，維度 1536，需 OPENAI_API_KEY。
//  • ollama：本機 Ollama /api/embeddings，一次一筆需迴圈；維度動態取自
//    第一筆回傳長度。
//
//  失敗一律包成 AppError(EMBED_FAILED)，設定缺漏則為 CONFIG_MISSING。
// ════════════════════════════════════════════════════════════════════

import OpenAI from "openai";

import { AppError, ErrorCode, type EmbeddingProvider } from "../shared/types";

export interface EmbeddingOptions {
  provider: EmbeddingProvider; // "local" | "openai" | "ollama"
  openaiApiKey?: string;
  ollamaBaseUrl?: string;
  ollamaModel?: string;
}

/** all-MiniLM-L6-v2 的固定輸出維度。 */
const LOCAL_DIMENSION = 384;
/** text-embedding-3-small 的固定輸出維度。 */
const OPENAI_DIMENSION = 1536;

const LOCAL_MODEL = "Xenova/all-MiniLM-L6-v2";
const OPENAI_MODEL = "text-embedding-3-small";
const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";
const DEFAULT_OLLAMA_MODEL = "nomic-embed-text";

/**
 * @xenova/transformers 的 feature-extraction pipeline 介面（只用到我們需要的形狀）。
 * 回傳物件帶 .tolist() 可轉成 number[][]。
 */
type FeatureExtractor = (
  texts: string[],
  opts: { pooling: "mean"; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

export class EmbeddingService {
  private readonly provider: EmbeddingProvider;
  private readonly openaiApiKey?: string;
  private readonly ollamaBaseUrl: string;
  private readonly ollamaModel: string;

  /** local pipeline 的快取（lazy 載入後重用）。 */
  private localExtractor: FeatureExtractor | null = null;
  /** 同時多次呼叫 embed 時，共用同一個載入中的 Promise，避免重複下載模型。 */
  private localLoading: Promise<FeatureExtractor> | null = null;

  /** openai client 快取。 */
  private openaiClient: OpenAI | null = null;

  /** ollama 模式下動態量到的維度（首次 embed 後填入）。 */
  private ollamaDimension: number | null = null;

  constructor(opts: EmbeddingOptions) {
    if (!opts || (opts.provider !== "local" && opts.provider !== "openai" && opts.provider !== "ollama")) {
      throw new AppError(ErrorCode.INVALID_INPUT, `未知的 embedding provider：${opts?.provider}`);
    }
    this.provider = opts.provider;
    this.openaiApiKey = opts.openaiApiKey;
    this.ollamaBaseUrl = (opts.ollamaBaseUrl ?? DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, "");
    this.ollamaModel = opts.ollamaModel ?? DEFAULT_OLLAMA_MODEL;
  }

  /** 向量維度；local/openai 為固定值，ollama 為動態（未量測前回 0）。 */
  get dimension(): number {
    switch (this.provider) {
      case "local":
        return LOCAL_DIMENSION;
      case "openai":
        return OPENAI_DIMENSION;
      case "ollama":
        return this.ollamaDimension ?? 0;
    }
  }

  /**
   * 將多段文字轉成向量。空輸入直接回空陣列。
   */
  async embed(texts: string[]): Promise<number[][]> {
    if (!Array.isArray(texts)) {
      throw new AppError(ErrorCode.INVALID_INPUT, "texts 必須為字串陣列");
    }
    if (texts.length === 0) {
      return [];
    }

    switch (this.provider) {
      case "local":
        return this.embedLocal(texts);
      case "openai":
        return this.embedOpenAI(texts);
      case "ollama":
        return this.embedOllama(texts);
    }
  }

  // ─────────────── local（@xenova/transformers）───────────────

  private async embedLocal(texts: string[]): Promise<number[][]> {
    try {
      const extractor = await this.getLocalExtractor();
      const output = await extractor(texts, { pooling: "mean", normalize: true });
      return output.tolist();
    } catch (err) {
      throw new AppError(
        ErrorCode.EMBED_FAILED,
        "本地嵌入（all-MiniLM-L6-v2）失敗",
        err instanceof Error ? err.message : err,
      );
    }
  }

  /** lazy 載入並快取 feature-extraction pipeline。 */
  private async getLocalExtractor(): Promise<FeatureExtractor> {
    if (this.localExtractor) {
      return this.localExtractor;
    }
    if (!this.localLoading) {
      // 動態 import：transformers 體積大且僅 local 模式需要，避免拖慢其他來源啟動。
      this.localLoading = import("@xenova/transformers").then(async ({ pipeline }) => {
        const extractor = (await pipeline("feature-extraction", LOCAL_MODEL)) as unknown as FeatureExtractor;
        this.localExtractor = extractor;
        return extractor;
      });
    }
    try {
      return await this.localLoading;
    } catch (err) {
      // 載入失敗後清掉 Promise，下次呼叫可重試
      this.localLoading = null;
      throw err;
    }
  }

  // ─────────────── openai ───────────────

  private async embedOpenAI(texts: string[]): Promise<number[][]> {
    const client = this.getOpenAIClient();
    try {
      const res = await client.embeddings.create({ model: OPENAI_MODEL, input: texts });
      // 依 index 排序確保與輸入順序一致
      return res.data
        .slice()
        .sort((a, b) => a.index - b.index)
        .map((d) => d.embedding as number[]);
    } catch (err) {
      throw new AppError(
        ErrorCode.EMBED_FAILED,
        "OpenAI 嵌入失敗",
        err instanceof Error ? err.message : err,
      );
    }
  }

  private getOpenAIClient(): OpenAI {
    if (!this.openaiApiKey) {
      throw new AppError(ErrorCode.CONFIG_MISSING, "OpenAI 嵌入需要 OPENAI_API_KEY");
    }
    if (!this.openaiClient) {
      this.openaiClient = new OpenAI({ apiKey: this.openaiApiKey });
    }
    return this.openaiClient;
  }

  // ─────────────── ollama ───────────────

  private async embedOllama(texts: string[]): Promise<number[][]> {
    const url = `${this.ollamaBaseUrl}/api/embeddings`;
    const vectors: number[][] = [];

    // Ollama /api/embeddings 一次只吃一筆 prompt，逐筆送。
    for (const text of texts) {
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: this.ollamaModel, prompt: text }),
        });
      } catch (err) {
        throw new AppError(
          ErrorCode.EMBED_FAILED,
          `Ollama 連線失敗（${url}）`,
          err instanceof Error ? err.message : err,
        );
      }

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new AppError(ErrorCode.EMBED_FAILED, `Ollama 回應 ${res.status}`, body);
      }

      let json: { embedding?: number[] };
      try {
        json = (await res.json()) as { embedding?: number[] };
      } catch (err) {
        throw new AppError(
          ErrorCode.EMBED_FAILED,
          "Ollama 回傳非合法 JSON",
          err instanceof Error ? err.message : err,
        );
      }

      const embedding = json.embedding;
      if (!Array.isArray(embedding) || embedding.length === 0) {
        throw new AppError(ErrorCode.EMBED_FAILED, "Ollama 回傳缺少 embedding 欄位");
      }
      vectors.push(embedding);
    }

    // 以第一筆長度記錄維度（供 dimension getter 使用）
    if (this.ollamaDimension === null && vectors.length > 0) {
      this.ollamaDimension = vectors[0].length;
    }
    return vectors;
  }
}
