// ════════════════════════════════════════════════════════════════════
//  VectorStore — LanceDB 向量庫（跨會議記憶）
//
//  職責：
//  • init()：連線到本地 LanceDB（dbPath 不存在會自動建立資料夾）。
//  • addChunks()：把切片文字嵌入成向量後寫入 "meeting_memory" 表
//    （採 lazy 建表：第一次有資料時若表不存在則 createTable，否則 add）。
//  • queryHistoricalContext()：以餘弦相似度檢索最相關的歷史片段，
//    格式化成可餵給 Claude 的背景文字。
//
//  錯誤策略：連線／查詢等真正的故障包成 AppError(VECTOR_DB_ERROR)；
//  但「表尚未建立 / 沒有資料」屬正常狀態，查詢一律回空字串（不 throw）。
// ════════════════════════════════════════════════════════════════════

import * as lancedb from "@lancedb/lancedb";
import type { Connection, Table } from "@lancedb/lancedb";

import { AppError, ErrorCode, type Chunk } from "../shared/types";
import type { EmbeddingService } from "./EmbeddingService";

export interface VectorStoreOptions {
  dbPath: string;
  embedding: EmbeddingService;
}

/** 固定表名。 */
const TABLE_NAME = "meeting_memory";

/** 存進 DB 的列形狀（欄位用 snake_case）。
 *  索引簽名讓它符合 LanceDB `Data`（Record<string, unknown>[]）的要求。 */
interface MemoryRow {
  id: string;
  text: string;
  vector: number[];
  timestamp_start: number;
  timestamp_end: number;
  meeting_id: string;
  meeting_date: string;
  [key: string]: unknown;
}

/** 查詢回來的列（LanceDB 會額外帶 _distance 等欄位，這裡只取我們存的）。 */
interface MemoryHit {
  text?: string;
  timestamp_start?: number;
  timestamp_end?: number;
  meeting_date?: string;
}

export class VectorStore {
  private readonly dbPath: string;
  private readonly embedding: EmbeddingService;

  private db: Connection | null = null;

  constructor(opts: VectorStoreOptions) {
    if (!opts || typeof opts.dbPath !== "string" || opts.dbPath.length === 0) {
      throw new AppError(ErrorCode.INVALID_INPUT, "VectorStore 需要非空的 dbPath");
    }
    if (!opts.embedding) {
      throw new AppError(ErrorCode.INVALID_INPUT, "VectorStore 需要 EmbeddingService");
    }
    this.dbPath = opts.dbPath;
    this.embedding = opts.embedding;
  }

  /** 連線到本地 LanceDB（自動建立資料夾）。表採 lazy 建立，此處不建表。 */
  async init(): Promise<void> {
    try {
      this.db = await lancedb.connect(this.dbPath);
    } catch (err) {
      throw new AppError(
        ErrorCode.VECTOR_DB_ERROR,
        `LanceDB 連線失敗：${this.dbPath}`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  /**
   * 將切片嵌入後寫入向量庫。空輸入直接 return。
   * 第一次有資料且表不存在時建立表，否則開表後 append。
   */
  async addChunks(chunks: Chunk[]): Promise<void> {
    if (!Array.isArray(chunks) || chunks.length === 0) {
      return;
    }
    const db = this.requireDb();

    // ─── 嵌入 ───
    const vectors = await this.embedding.embed(chunks.map((c) => c.text));
    if (vectors.length !== chunks.length) {
      throw new AppError(
        ErrorCode.VECTOR_DB_ERROR,
        `嵌入數量（${vectors.length}）與切片數量（${chunks.length}）不一致`,
      );
    }

    // ─── 組列 ───
    const rows: MemoryRow[] = chunks.map((c, i) => ({
      id: c.id,
      text: c.text,
      vector: vectors[i],
      timestamp_start: c.timestampStart,
      timestamp_end: c.timestampEnd,
      meeting_id: c.meetingId,
      meeting_date: c.meetingDate,
    }));

    // ─── lazy 建表 / append ───
    try {
      const names = await db.tableNames();
      if (names.includes(TABLE_NAME)) {
        const table = await db.openTable(TABLE_NAME);
        await table.add(rows);
      } else {
        await db.createTable(TABLE_NAME, rows);
      }
    } catch (err) {
      throw new AppError(
        ErrorCode.VECTOR_DB_ERROR,
        "寫入向量庫失敗",
        err instanceof Error ? err.message : err,
      );
    }
  }

  /**
   * 以餘弦相似度檢索與 userQuery 最相關的歷史片段，回傳格式化背景文字。
   * 表不存在 / 沒有資料 / 查無結果 → 回空字串（不 throw）。
   * @param userQuery 要檢索的查詢文字
   * @param limit 取回筆數，預設 3
   */
  async queryHistoricalContext(userQuery: string, limit = 3): Promise<string> {
    if (typeof userQuery !== "string" || userQuery.trim().length === 0) {
      return "";
    }
    const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : 3;
    const db = this.requireDb();

    // 表尚未建立 → 還沒有任何歷史，正常回空字串
    let table: Table;
    try {
      const names = await db.tableNames();
      if (!names.includes(TABLE_NAME)) {
        return "";
      }
      table = await db.openTable(TABLE_NAME);
    } catch (err) {
      throw new AppError(
        ErrorCode.VECTOR_DB_ERROR,
        "開啟向量庫表失敗",
        err instanceof Error ? err.message : err,
      );
    }

    // ─── 查詢向量 ───
    let queryVector: number[];
    try {
      const vecs = await this.embedding.embed([userQuery]);
      if (vecs.length === 0) {
        return "";
      }
      queryVector = vecs[0];
    } catch (err) {
      // 嵌入失敗屬真正故障
      throw err instanceof AppError
        ? err
        : new AppError(ErrorCode.EMBED_FAILED, "查詢向量嵌入失敗", err instanceof Error ? err.message : err);
    }

    // ─── 餘弦相似度檢索 ───
    let hits: MemoryHit[];
    try {
      // search(vector) 回傳 VectorQuery（給定向量而非字串時），可鏈 distanceType。
      const query = table.search(queryVector) as lancedb.VectorQuery;
      hits = (await query.distanceType("cosine").limit(safeLimit).toArray()) as MemoryHit[];
    } catch (err) {
      throw new AppError(
        ErrorCode.VECTOR_DB_ERROR,
        "向量檢索失敗",
        err instanceof Error ? err.message : err,
      );
    }

    if (!Array.isArray(hits) || hits.length === 0) {
      return "";
    }

    // ─── 格式化背景文字 ───
    const blocks = hits
      .filter((h) => typeof h.text === "string" && h.text.length > 0)
      .map((h) => {
        const date = h.meeting_date ?? "未知日期";
        const startMmss = secondsToMmss(h.timestamp_start);
        const endMmss = secondsToMmss(h.timestamp_end);
        return `【${date} 會議片段｜${startMmss}-${endMmss}】\n${h.text}\n`;
      });

    if (blocks.length === 0) {
      return "";
    }

    return `以下是與你問題最相關的歷史會議內容：\n${blocks.join("\n")}`;
  }

  /** 取得已初始化的連線，否則拋錯（呼叫端應先 init()）。 */
  private requireDb(): Connection {
    if (!this.db) {
      throw new AppError(ErrorCode.VECTOR_DB_ERROR, "VectorStore 尚未 init()，無法操作");
    }
    return this.db;
  }
}

/** 秒數 → mm:ss（負值/非數值視為 0）。 */
function secondsToMmss(sec: number | undefined): string {
  const total = Number.isFinite(sec) && (sec as number) > 0 ? Math.floor(sec as number) : 0;
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}
