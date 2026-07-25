// 依 [mm:ss] 時間戳把逐字稿裁出指定「分鐘」區間（前端按分析前用；純函式、兩端 tsconfig 共用、可單元測試）。
// 逐字稿每行為 `[分:秒] 發言人: 內容`，分可 >59（總分鐘，例如 143）。
// 沒有時間戳的換行續句沿用上一行的時間；起迄顛倒會自動正規化；含兩端整分。

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

/** 裁出第 startMin~endMin 分（含兩端整分）的逐字稿；續句沿用上一行時間，空範圍回空字串。 */
export function filterTranscriptByRange(transcript: string, startMin: number, endMin: number): string {
  const lo = Math.min(startMin, endMin);
  const hi = Math.max(startMin, endMin);
  const out: string[] = [];
  let cur: number | null = null;
  for (const line of transcript.split("\n")) {
    const min = lineMinute(line);
    if (min !== null) cur = min;
    // 首個時間戳之前的行（cur=null）：只有從第 0 分起才保留（例如開頭抬頭）。
    const effective = cur === null ? (lo <= 0 ? 0 : -1) : cur;
    if (effective >= lo && effective <= hi) out.push(line);
  }
  return out.join("\n");
}
