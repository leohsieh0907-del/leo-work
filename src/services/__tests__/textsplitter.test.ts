// ════════════════════════════════════════════════════════════════════
//  TextSplitter 單元測試（純邏輯，不依賴網路 / 模型）
// ════════════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";

import { TextSplitter } from "../TextSplitter";
import type { MeetingMeta, TranscriptSegment } from "../../shared/types";

const meeting: MeetingMeta = {
  meetingId: "m1",
  meetingDate: "2026-06-13T10:00:00+08:00",
  title: "測試會議",
};

/** 產生一段夠長的逐字稿（多個 segment），總長遠大於 chunkSize。 */
function longSegments(): TranscriptSegment[] {
  return [
    { start: 0, end: 10, text: "甲".repeat(120) },
    { start: 10, end: 20, text: "乙".repeat(120) },
    { start: 20, end: 30, text: "丙".repeat(120) },
  ];
}

describe("TextSplitter", () => {
  it("以滑動視窗切出多塊，且相鄰塊重疊 overlap 字元數正確（步進 = chunkSize - overlap）", () => {
    const chunkSize = 100;
    const overlap = 20;
    const splitter = new TextSplitter({ chunkSize, overlap });
    const chunks = splitter.splitTranscript(longSegments(), meeting);

    // 應切出多塊
    expect(chunks.length).toBeGreaterThan(1);

    // 除最後一塊外，每塊長度應等於 chunkSize
    for (let i = 0; i < chunks.length - 1; i++) {
      expect(chunks[i].text.length).toBe(chunkSize);
    }

    // 相鄰塊（前一塊尾端 overlap 字元）應等於（後一塊開頭 overlap 字元）
    for (let i = 0; i < chunks.length - 1; i++) {
      const prevTail = chunks[i].text.slice(chunkSize - overlap);
      const nextHead = chunks[i + 1].text.slice(0, overlap);
      expect(prevTail).toBe(nextHead);
    }
  });

  it("每塊 timestamp 在合理範圍（>=0、start<=end），且 id 格式為 meetingId::index", () => {
    const splitter = new TextSplitter({ chunkSize: 100, overlap: 20 });
    const chunks = splitter.splitTranscript(longSegments(), meeting);

    chunks.forEach((c, i) => {
      expect(c.id).toBe(`${meeting.meetingId}::${i}`);
      expect(c.meetingId).toBe(meeting.meetingId);
      expect(c.meetingDate).toBe(meeting.meetingDate);
      expect(c.timestampStart).toBeGreaterThanOrEqual(0);
      expect(c.timestampEnd).toBeGreaterThanOrEqual(0);
      expect(c.timestampStart).toBeLessThanOrEqual(c.timestampEnd);
      expect(c.vector).toBeUndefined();
    });

    // 第一塊起始時間應對應第一段（start=0）；最後一塊結束時間應落在最後一段（end=30）
    expect(chunks[0].timestampStart).toBe(0);
    expect(chunks[chunks.length - 1].timestampEnd).toBe(30);
  });

  it("短輸入（總長 < chunkSize）→ 剛好一塊，且內容完整", () => {
    const splitter = new TextSplitter({ chunkSize: 300, overlap: 50 });
    const segments: TranscriptSegment[] = [{ start: 0, end: 5, text: "很短的一句話" }];
    const chunks = splitter.splitTranscript(segments, meeting);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe("很短的一句話");
    expect(chunks[0].id).toBe("m1::0");
    expect(chunks[0].timestampStart).toBe(0);
    expect(chunks[0].timestampEnd).toBe(5);
  });

  it("空 segments → 回空陣列", () => {
    const splitter = new TextSplitter();
    expect(splitter.splitTranscript([], meeting)).toEqual([]);
  });

  it("全為空字串的 segments → 回空陣列", () => {
    const splitter = new TextSplitter();
    const segments: TranscriptSegment[] = [
      { start: 0, end: 1, text: "" },
      { start: 1, end: 2, text: "" },
    ];
    expect(splitter.splitTranscript(segments, meeting)).toEqual([]);
  });

  it("overlap >= chunkSize → 建構時拋 INVALID_INPUT", () => {
    expect(() => new TextSplitter({ chunkSize: 50, overlap: 50 })).toThrow();
    expect(() => new TextSplitter({ chunkSize: 50, overlap: 80 })).toThrow();
  });
});
