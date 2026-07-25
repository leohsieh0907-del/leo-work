// 依 [mm:ss] 時間戳把逐字稿裁出指定「分鐘」區間（前端按分析前用；純函式、兩端 tsconfig 共用、可單元測試）。
// 逐字稿每行為 `[分:秒] 發言人: 內容`，分可 >59（總分鐘，例如 143）。
// 沒有時間戳的換行續句沿用上一行的時間；含兩端整分。
// 支援多段：例如 `1-3, 5-7, 10-12`（合併分析取聯集，各段獨立分析則逐段各裁一次）。

/** 解析行首 `[分:秒]` → 該行所屬「分鐘」（總分鐘）；無時間戳回 null。 */
export function lineMinute(line: string): number | null {
  const m = /^\s*\[(\d+):[0-5]?\d\]/.exec(line);
  return m ? parseInt(m[1], 10) : null;
}

/** 逐字稿最後一個時間戳的分鐘（整份無時間戳回 0）。給「最後 N 分」快捷用。 */
export function lastMinuteOf(transcript: string): number {
  let last = 0;
  for (const line of transcript.split("\n")) {
    const min = lineMinute(line);
    if (min !== null) last = min;
  }
  return last;
}

/**
 * 解析多段字串 → 區間陣列。接受 `5-15`、`1-3, 5-7, 10-12`、單一分鐘 `8`。
 * 分隔：逗號/頓號/分號/空白；區間符號：- ~ ～。起迄顛倒自動正規化；不合法 token 忽略。
 */
export function parseRanges(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const tok of text.split(/[,，、;；\s]+/)) {
    const t = tok.trim();
    if (!t) continue;
    const m = /^(\d+)\s*[-~～]\s*(\d+)$/.exec(t);
    if (m) {
      const a = parseInt(m[1], 10);
      const b = parseInt(m[2], 10);
      out.push([Math.min(a, b), Math.max(a, b)]);
    } else if (/^\d+$/.test(t)) {
      const a = parseInt(t, 10);
      out.push([a, a]);
    }
    // 其餘（如 "abc"）忽略
  }
  return out;
}

/** 把區間陣列排成可讀字串，例如 `1–3, 5–7, 10–12 分`（單一分鐘顯示為 `8`）。 */
export function formatRanges(ranges: Array<[number, number]>): string {
  if (ranges.length === 0) return "";
  return ranges.map(([lo, hi]) => (lo === hi ? `${lo}` : `${lo}–${hi}`)).join(", ") + " 分";
}

/** 裁出「落在任一區間」的逐字稿（含兩端整分）；續句沿用上一行時間，空則回空字串。 */
export function filterTranscriptByRanges(transcript: string, ranges: Array<[number, number]>): string {
  if (ranges.length === 0) return "";
  const hasZeroStart = ranges.some(([lo]) => lo <= 0); // 首個時間戳前的行只有從第 0 分起才保留
  const out: string[] = [];
  let cur: number | null = null;
  for (const line of transcript.split("\n")) {
    const min = lineMinute(line);
    if (min !== null) cur = min;
    const effective = cur === null ? (hasZeroStart ? 0 : -1) : cur;
    if (ranges.some(([lo, hi]) => effective >= lo && effective <= hi)) out.push(line);
  }
  return out.join("\n");
}

/** 單段裁切（保留給既有呼叫；委派給多段版）。 */
export function filterTranscriptByRange(transcript: string, startMin: number, endMin: number): string {
  return filterTranscriptByRanges(transcript, [[Math.min(startMin, endMin), Math.max(startMin, endMin)]]);
}
