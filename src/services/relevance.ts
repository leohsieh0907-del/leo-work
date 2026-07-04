// 為「AI 助理聊天」挑出逐字稿中與問題最相關的片段（輕量關鍵詞比對，無需 embedding）。
// 目的：長逐字稿不要每次整份塞給 LLM（① 省額度、不「這麼快」燒光 ② 片段夠小、Groq 後援也吃得下 TPM）。
// 短逐字稿原樣回傳（行為不變）。挑選以「行」為單位、保留原順序與 [mm:ss] 時間戳。

/** 從問題抽出比對用詞：ASCII 詞（≥2）＋ CJK 的 2/3-gram。 */
export function queryTerms(q: string): string[] {
  const terms = new Set<string>();
  for (const w of (q.toLowerCase().match(/[a-z0-9]{2,}/g) ?? [])) terms.add(w);
  const cjk = q.replace(/[^一-鿿]/g, "");
  for (let n = 2; n <= 3; n++) {
    for (let i = 0; i + n <= cjk.length; i++) terms.add(cjk.slice(i, i + n));
  }
  return [...terms];
}

/** 均勻取樣：問題無關鍵詞命中時，取全程代表性片段（讓 AI 仍看到整場輪廓）。 */
function evenSample(lines: string[], maxChars: number): string[] {
  const budgetLines = Math.max(1, Math.floor(maxChars / 80)); // 粗估每行 ~80 字
  const step = Math.max(1, Math.floor(lines.length / budgetLines));
  const out: string[] = [];
  let len = 0;
  for (let i = 0; i < lines.length; i += step) {
    if (len + lines[i].length + 1 > maxChars) break;
    out.push(lines[i]);
    len += lines[i].length + 1;
  }
  return out.length ? out : [lines[0].slice(0, maxChars)];
}

/**
 * 挑出與 query 最相關的逐字稿行（保留原順序），總長 ≤ maxChars。
 * 逐字稿 ≤ maxChars 時原樣回傳。有關鍵詞命中→取高分行；全無命中→均勻取樣。
 */
export function selectRelevantContext(transcript: string, query: string, maxChars: number): string {
  const text = (transcript ?? "").trim();
  if (text.length <= maxChars) return text;

  const lines = text.split("\n");
  const terms = queryTerms(query);
  const scored = lines.map((line, i) => {
    const ll = line.toLowerCase();
    let score = 0;
    for (const t of terms) if (ll.includes(t)) score += 1;
    return { i, line, score };
  });

  if (!scored.some((s) => s.score > 0)) {
    return evenSample(lines, maxChars).join("\n");
  }

  // 依分數高→低塞到 maxChars，再依原順序排回（時間軸不亂）。
  const picked: { i: number; line: string }[] = [];
  let len = 0;
  for (const s of [...scored].sort((a, b) => b.score - a.score || a.i - b.i)) {
    if (s.score === 0) break;
    if (len + s.line.length + 1 > maxChars) continue;
    picked.push(s);
    len += s.line.length + 1;
  }
  if (!picked.length) return evenSample(lines, maxChars).join("\n");
  return picked.sort((a, b) => a.i - b.i).map((p) => p.line).join("\n");
}
