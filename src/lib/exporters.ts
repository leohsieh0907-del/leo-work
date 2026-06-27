// ── 會議記錄匯出：Word(.docx) / Excel(.xlsx) / PPT(.pptx) ──
// 全部在瀏覽器端用離線套件直接產檔下載，零 API、不上傳（符合本專案「全本地」原則）。
// 中介模型：ComposedDoc（heading/paragraph/bullets/table 區塊）。
//   - 無 AI 指示：analysisToComposedDoc 在本機把分析結果排成預設範本。
//   - 有 AI 指示：由 sidecar /export/compose 交 Gemini 依指示重組後回傳 ComposedDoc。
// docx → Word；exceljs → Excel；pptxgenjs → PPT。

import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import ExcelJS from "exceljs";
import pptxgen from "pptxgenjs";
import type { ActionItem, ComposedDoc, DocBlock, ExportFormat, ProactiveAnalysis } from "../shared/types";

export interface ExportData {
  title: string; // 會議名稱（也用來組檔名）
  date: string; // YYYY-MM-DD
  analysis: ProactiveAnalysis;
  actionItems: ActionItem[];
  transcript?: string; // 逐字稿（預設範本只進 Word）
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** 檔名：會議名稱-日期，去掉檔案系統不允許的字元。 */
function baseName(d: ExportData): string {
  const safe = (d.title || "會議記錄").replace(/[\\/:*?"<>|]/g, "_").trim();
  const date = d.date || new Date().toISOString().slice(0, 10);
  return `${safe}-${date}`;
}

/** 預設範本（無 AI 指示）：把分析結果排成通用區塊。 */
export function analysisToComposedDoc(d: ExportData): ComposedDoc {
  const a = d.analysis;
  const blocks: DocBlock[] = [];
  if (d.date) blocks.push({ type: "paragraph", text: `日期：${d.date}` });

  blocks.push({ type: "heading", text: "會議主題" });
  blocks.push({ type: "paragraph", text: a.theme || "（無）" });

  blocks.push({ type: "heading", text: "關鍵討論摘要" });
  if (a.key_summary.length) blocks.push({ type: "bullets", items: a.key_summary });
  else blocks.push({ type: "paragraph", text: "（無）" });

  blocks.push({ type: "heading", text: "歷史衝突點" });
  if (a.historical_conflicts.length)
    blocks.push({ type: "bullets", items: a.historical_conflicts.map((c) => `⚠️ ${c}`) });
  else blocks.push({ type: "paragraph", text: "（未發現衝突）" });

  blocks.push({ type: "heading", text: "行動方針" });
  if (d.actionItems.length)
    blocks.push({
      type: "table",
      columns: ["任務", "負責人", "截止日"],
      rows: d.actionItems.map((it) => [it.task, it.assignee, it.deadline]),
    });
  else blocks.push({ type: "paragraph", text: "（無）" });

  if (d.transcript?.trim()) {
    blocks.push({ type: "heading", text: "逐字稿" });
    blocks.push({ type: "paragraph", text: d.transcript });
  }
  return { title: d.title || "會議記錄", blocks };
}

// ── Word ──
function docxCell(text: string, bold = false) {
  return new TableCell({ children: [new Paragraph({ children: [new TextRun({ text, bold })] })] });
}

function docxTable(columns: string[], rows: string[][]): Table {
  const trows: TableRow[] = [];
  if (columns.length) trows.push(new TableRow({ children: columns.map((c) => docxCell(c, true)) }));
  rows.forEach((r) => trows.push(new TableRow({ children: r.map((c) => docxCell(c)) })));
  if (!trows.length) trows.push(new TableRow({ children: [docxCell("")] })); // docx 不接受空表
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: trows });
}

/**
 * 數值表自動轉圖表規格（PPT 用）：第一欄當分類，其餘欄「整欄都是數字」才成立。
 * 讓 Gemini 只要產出表格（它很穩），PPT 就能自動畫圖，不必依賴它主動選 chart 區塊。
 */
function tableToChart(
  columns: string[],
  rows: string[][],
): { chartType: "bar" | "pie"; categories: string[]; series: { name: string; values: number[] }[] } | null {
  if (columns.length < 2 || rows.length < 2) return null;
  const parse = (c: string) => {
    const cleaned = String(c ?? "").replace(/[^0-9.\-]/g, ""); // 去「萬/%/$/,」等單位
    return cleaned === "" ? NaN : Number(cleaned);
  };
  const valueCols = columns.slice(1);
  const series = valueCols.map((name, ci) => ({ name, values: rows.map((r) => parse(r[ci + 1])) }));
  const allNumeric = series.every((s) => s.values.every((v) => Number.isFinite(v)));
  if (!allNumeric) return null;
  return {
    chartType: valueCols.length === 1 ? "pie" : "bar",
    categories: rows.map((r) => String(r[0] ?? "")),
    series,
  };
}

/** chart 區塊在非 PPT 格式退化成資料表（不丟資料）。 */
function chartToTable(b: DocBlock): { columns: string[]; rows: string[][] } {
  const cats = b.categories ?? [];
  const series = b.series ?? [];
  return {
    columns: ["項目", ...series.map((s) => s.name)],
    rows: cats.map((c, i) => [c, ...series.map((s) => String(s.values[i] ?? ""))]),
  };
}

async function renderDocx(doc: ComposedDoc, fileBase: string): Promise<void> {
  const body: (Paragraph | Table)[] = [new Paragraph({ text: doc.title, heading: HeadingLevel.TITLE })];
  for (const b of doc.blocks) {
    if (b.type === "heading") {
      body.push(new Paragraph({ text: b.text ?? "", heading: HeadingLevel.HEADING_1 }));
    } else if (b.type === "paragraph") {
      (b.text ?? "").split(/\r?\n/).forEach((line) => body.push(new Paragraph(line)));
    } else if (b.type === "bullets") {
      (b.items ?? []).forEach((it) => body.push(new Paragraph({ text: it, bullet: { level: 0 } })));
    } else if (b.type === "table") {
      body.push(docxTable(b.columns ?? [], b.rows ?? []));
    } else if (b.type === "chart") {
      if (b.text) body.push(new Paragraph({ text: b.text, heading: HeadingLevel.HEADING_2 }));
      const t = chartToTable(b);
      body.push(docxTable(t.columns, t.rows));
    }
  }
  const docx = new Document({ sections: [{ children: body }] });
  downloadBlob(await Packer.toBlob(docx), `${fileBase}.docx`);
}

// ── Excel ──
function autoWidth(ws: ExcelJS.Worksheet): void {
  ws.columns.forEach((col) => {
    let max = 10;
    col.eachCell?.({ includeEmpty: false }, (cell) => {
      const len = String(cell.value ?? "").length;
      if (len > max) max = len;
    });
    col.width = Math.min(64, max + 2);
  });
}

async function renderXlsx(doc: ComposedDoc, fileBase: string): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const used = new Set<string>();
  const uniqName = (raw: string) => {
    const base = (raw || "資料").replace(/[\\/?*[\]:]/g, " ").trim().slice(0, 28) || "資料";
    let name = base;
    let i = 2;
    while (used.has(name)) name = `${base.slice(0, 25)} ${i++}`;
    used.add(name);
    return name;
  };

  // 非表格區塊集中放「概要」工作表；每個 table 開一張獨立工作表（表名取最近的 heading）。
  const overview = wb.addWorksheet(uniqName(doc.title || "會議概要"));
  let lastHeading = "";
  for (const b of doc.blocks) {
    if (b.type === "heading") {
      lastHeading = b.text ?? "";
      overview.addRow([]);
      overview.addRow([lastHeading]).font = { bold: true };
    } else if (b.type === "paragraph") {
      (b.text ?? "").split(/\r?\n/).forEach((line) => overview.addRow(["", line]));
    } else if (b.type === "bullets") {
      (b.items ?? []).forEach((it) => overview.addRow(["", it]));
    } else if (b.type === "table") {
      const ws = wb.addWorksheet(uniqName(lastHeading || "資料表"));
      if (b.columns?.length) ws.addRow(b.columns).font = { bold: true };
      (b.rows ?? []).forEach((r) => ws.addRow(r));
      autoWidth(ws);
    } else if (b.type === "chart") {
      const t = chartToTable(b);
      const ws = wb.addWorksheet(uniqName(b.text || lastHeading || "圖表資料"));
      ws.addRow(t.columns).font = { bold: true };
      t.rows.forEach((r) => ws.addRow(r));
      autoWidth(ws);
    }
  }
  overview.getColumn(1).width = 18;
  overview.getColumn(2).width = 64;

  const buf = await wb.xlsx.writeBuffer();
  downloadBlob(
    new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
    `${fileBase}.xlsx`,
  );
}

// ── PowerPoint ──
async function renderPptx(doc: ComposedDoc, fileBase: string): Promise<void> {
  const pptx = new pptxgen();
  pptx.layout = "LAYOUT_WIDE";

  const cover = pptx.addSlide();
  cover.background = { color: "1E293B" };
  cover.addText(doc.title || "會議記錄", {
    x: 0.5, y: 2.6, w: "90%", fontSize: 36, bold: true, color: "FFFFFF", align: "center",
  });

  // heading 開新投影片；其餘區塊堆到當前頁，用 y 粗略往下排版。
  let slide: pptxgen.Slide | null = null;
  let y = 0.3;
  const newSlide = (title?: string): pptxgen.Slide => {
    const sl = pptx.addSlide();
    y = 0.3;
    if (title) {
      sl.addText(title, { x: 0.5, y, w: "90%", fontSize: 24, bold: true });
      y = 1.1;
    }
    slide = sl;
    return sl;
  };

  for (const b of doc.blocks) {
    if (b.type === "heading") {
      newSlide(b.text);
      continue;
    }
    const s = slide ?? newSlide();
    if (b.type === "paragraph") {
      s.addText(b.text ?? "", { x: 0.5, y, w: "90%", h: 1, fontSize: 14, valign: "top" });
      y += 1;
    } else if (b.type === "bullets") {
      const items = b.items ?? [];
      s.addText(
        items.map((t) => ({ text: t, options: { bullet: true } })),
        { x: 0.5, y, w: "90%", h: 4.5, fontSize: 14, valign: "top" },
      );
      y += Math.min(4.5, items.length * 0.4 + 0.5);
    } else if (b.type === "table") {
      const rows: pptxgen.TableRow[] = [];
      if (b.columns?.length)
        rows.push(b.columns.map((c) => ({ text: c, options: { bold: true, fill: { color: "E2E8F0" } } })));
      (b.rows ?? []).forEach((r) => rows.push(r.map((c) => ({ text: c }))));
      if (rows.length) {
        s.addTable(rows, { x: 0.5, y, w: 12, fontSize: 12, border: { type: "solid", color: "CBD5E1", pt: 1 } });
        y += Math.min(4.5, rows.length * 0.4 + 0.3);
      }
      // 數值表 → 自動補一張圖表投影片（不依賴 Gemini 主動選 chart）
      const auto = tableToChart(b.columns ?? [], b.rows ?? []);
      if (auto) {
        const cs = pptx.addSlide();
        cs.addText(`${b.columns?.[0] ?? "資料"} 圖表`, { x: 0.5, y: 0.3, w: "90%", fontSize: 22, bold: true });
        const data = auto.series.map((se) => ({ name: se.name, labels: auto.categories, values: se.values }));
        cs.addChart(auto.chartType, data, {
          x: 0.5, y: 1.1, w: 11, h: 4.8, showLegend: true, legendPos: "b", showTitle: false,
        });
      }
    } else if (b.type === "chart") {
      const series = b.series ?? [];
      const cats = b.categories ?? [];
      if (series.length && cats.length) {
        if (b.text) {
          s.addText(b.text, { x: 0.5, y, w: "90%", fontSize: 16, bold: true });
          y += 0.5;
        }
        const data = series.map((se) => ({ name: se.name, labels: cats, values: se.values }));
        const h = Math.max(2.5, Math.min(4.5, 7 - y));
        s.addChart(b.chartType ?? "bar", data, {
          x: 0.5, y, w: 11, h, showLegend: true, legendPos: "b", showTitle: false,
        });
        y += h + 0.2;
      }
    }
  }
  await pptx.writeFile({ fileName: `${fileBase}.pptx` });
}

// ── CSV ──
/** CSV 欄位跳脫：含逗號/引號/換行就用雙引號包起來、內部引號加倍。 */
function csvCell(v: string): string {
  const s = String(v ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 把 ComposedDoc 攤平成 CSV 文字（heading/段落/條列為兩欄；table 原樣輸出）。 */
function composedToCsv(doc: ComposedDoc): string {
  const rows: string[][] = [[doc.title || "會議記錄"]];
  for (const b of doc.blocks) {
    if (b.type === "heading") {
      rows.push([]);
      rows.push([b.text ?? ""]);
    } else if (b.type === "paragraph") {
      (b.text ?? "").split(/\r?\n/).forEach((line) => rows.push(["", line]));
    } else if (b.type === "bullets") {
      (b.items ?? []).forEach((it) => rows.push(["", it]));
    } else if (b.type === "table") {
      if (b.columns?.length) rows.push(b.columns);
      (b.rows ?? []).forEach((r) => rows.push(r));
    } else if (b.type === "chart") {
      const t = chartToTable(b);
      rows.push(t.columns);
      t.rows.forEach((r) => rows.push(r));
    }
  }
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
}

/** 預設範本匯出 CSV（本機、零 API）。BOM 讓 Excel 開中文不亂碼。 */
export async function exportCsv(d: ExportData): Promise<void> {
  const csv = composedToCsv(analysisToComposedDoc(d));
  // 開頭加 UTF-8 BOM（﻿），Excel 才會以 UTF-8 開啟、中文不亂碼。
  downloadBlob(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }), `${baseName(d)}.csv`);
}

// ── 對外 API ──

/** 渲染一份 ComposedDoc 成指定格式（AI 客製匯出用：doc 來自 sidecar）。 */
export async function exportComposed(doc: ComposedDoc, format: ExportFormat, d: ExportData): Promise<void> {
  const fileBase = baseName(d);
  if (format === "docx") await renderDocx(doc, fileBase);
  else if (format === "xlsx") await renderXlsx(doc, fileBase);
  else await renderPptx(doc, fileBase);
}

/** 預設範本匯出（無 AI 指示）。 */
export async function exportDocx(d: ExportData): Promise<void> {
  await renderDocx(analysisToComposedDoc(d), baseName(d));
}
export async function exportXlsx(d: ExportData): Promise<void> {
  await renderXlsx(analysisToComposedDoc(d), baseName(d));
}
export async function exportPptx(d: ExportData): Promise<void> {
  await renderPptx(analysisToComposedDoc(d), baseName(d));
}
