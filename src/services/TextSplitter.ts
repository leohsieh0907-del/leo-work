// ════════════════════════════════════════════════════════════════════
//  TextSplitter — 逐字稿滑動視窗切片
//
//  作用：把多個帶時間戳記的 TranscriptSegment 串接成一條長字串，
//  再以固定字元寬度的「滑動視窗」切成多個 Chunk（相鄰塊重疊 overlap
//  字元，提升跨塊語意連續性，避免語句被硬切在邊界導致檢索漏接）。
//
//  時間回填：串接時記錄每段在長字串中的字元範圍 [charStart, charEnd)
//  及其對應的 segment.start / segment.end；切片時用 chunk 的字元範圍
//  反查，得到該塊涵蓋的起訖時間，讓檢索結果能還原「第幾分幾秒講的」。
// ════════════════════════════════════════════════════════════════════

import { AppError, ErrorCode, type Chunk, type MeetingMeta, type TranscriptSegment } from "../shared/types";

export interface TextSplitterOptions {
  /** 每塊字元數，預設 300 */
  chunkSize?: number;
  /** 相鄰塊重疊字元數，預設 50 */
  overlap?: number;
}

/** 串接後，記錄某段文字落在長字串中的位置與其原始時間。 */
interface CharSpan {
  /** 在長字串中的起始字元索引（含） */
  charStart: number;
  /** 在長字串中的結束字元索引（不含） */
  charEnd: number;
  /** 該段原始起始秒數 */
  start: number;
  /** 該段原始結束秒數 */
  end: number;
}

const DEFAULT_CHUNK_SIZE = 300;
const DEFAULT_OVERLAP = 50;

export class TextSplitter {
  private readonly chunkSize: number;
  private readonly overlap: number;

  constructor(opts?: TextSplitterOptions) {
    const chunkSize = opts?.chunkSize ?? DEFAULT_CHUNK_SIZE;
    const overlap = opts?.overlap ?? DEFAULT_OVERLAP;

    // ─── 防呆：尺寸必須為正整數 ───
    if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
      throw new AppError(ErrorCode.INVALID_INPUT, `chunkSize 必須為正整數，收到：${chunkSize}`);
    }
    if (!Number.isInteger(overlap) || overlap < 0) {
      throw new AppError(ErrorCode.INVALID_INPUT, `overlap 必須為非負整數，收到：${overlap}`);
    }
    // overlap >= chunkSize 會讓步進 <= 0 造成無限迴圈／重複切片，視為設定錯誤直接拒絕。
    if (overlap >= chunkSize) {
      throw new AppError(
        ErrorCode.INVALID_INPUT,
        `overlap（${overlap}）必須小於 chunkSize（${chunkSize}），否則視窗無法前進`,
      );
    }

    this.chunkSize = chunkSize;
    this.overlap = overlap;
  }

  /**
   * 將逐字稿切成多個 Chunk。
   * 空 segments → 回空陣列。
   */
  splitTranscript(segments: TranscriptSegment[], meeting: MeetingMeta): Chunk[] {
    if (!Array.isArray(segments) || segments.length === 0) {
      return [];
    }
    if (!meeting || typeof meeting.meetingId !== "string" || meeting.meetingId.length === 0) {
      throw new AppError(ErrorCode.INVALID_INPUT, "meeting.meetingId 為必填");
    }

    // ─── 1. 串接所有 segment 文字，同時記錄每段的字元範圍與時間 ───
    // 段與段之間插入一個空白，避免相鄰兩句的字黏成一個無意義的詞。
    const SEPARATOR = " ";
    const spans: CharSpan[] = [];
    let fullText = "";

    for (const seg of segments) {
      const text = typeof seg.text === "string" ? seg.text : "";
      if (text.length === 0) {
        continue; // 跳過空段，但其時間不影響鄰段
      }
      // 非首段且前面已有內容時，先補分隔字元（分隔字元不歸屬任何 span，
      // 落在分隔字元上的邊界會由 charToTime 就近對應到鄰段）。
      if (fullText.length > 0) {
        fullText += SEPARATOR;
      }
      const charStart = fullText.length;
      fullText += text;
      const charEnd = fullText.length;

      spans.push({
        charStart,
        charEnd,
        start: Number.isFinite(seg.start) ? seg.start : 0,
        end: Number.isFinite(seg.end) ? seg.end : 0,
      });
    }

    // 全部都是空段 → 沒有可切的內容
    if (fullText.length === 0 || spans.length === 0) {
      return [];
    }

    // ─── 2. 滑動視窗切片 ───
    const step = this.chunkSize - this.overlap; // 建構子已保證 > 0
    const chunks: Chunk[] = [];
    const total = fullText.length;

    let index = 0;
    for (let begin = 0; begin < total; begin += step) {
      const end = Math.min(begin + this.chunkSize, total); // 不含
      const text = fullText.slice(begin, end);

      chunks.push({
        id: `${meeting.meetingId}::${index}`,
        text,
        // 用塊的首字元 / 末字元反查所屬 segment 的時間
        timestampStart: this.charToTime(begin, spans, "start"),
        timestampEnd: this.charToTime(end - 1, spans, "end"),
        meetingId: meeting.meetingId,
        meetingDate: meeting.meetingDate,
        // vector 先不填，待 VectorStore.addChunks 計算後寫入 DB
      });
      index += 1;

      // 已抵達結尾（end 觸頂）就停，避免多切出尾端重複塊
      if (end >= total) {
        break;
      }
    }

    return chunks;
  }

  /**
   * 把長字串中的某個字元索引，對應回它所屬 segment 的時間。
   * which="start" 取該段 start；which="end" 取該段 end。
   * 邊界（落在分隔字元、或索引超出最後一段）以二分搜尋就近對應到最接近的段。
   */
  private charToTime(charIndex: number, spans: CharSpan[], which: "start" | "end"): number {
    // 夾在有效範圍內
    const idx = Math.max(0, Math.min(charIndex, spans[spans.length - 1].charEnd - 1));

    // 二分搜尋：找出 charStart <= idx < charEnd 的 span；
    // 若 idx 落在兩段之間的分隔字元上，取其左側（前一段）。
    let lo = 0;
    let hi = spans.length - 1;
    let candidate = 0; // 預設第 0 段
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const span = spans[mid];
      if (idx < span.charStart) {
        hi = mid - 1;
      } else if (idx >= span.charEnd) {
        candidate = mid; // idx 在此段之後，先記著此段（可能落在其後的分隔字元）
        lo = mid + 1;
      } else {
        candidate = mid; // 命中
        break;
      }
    }
    const span = spans[candidate];
    return which === "start" ? span.start : span.end;
  }
}
