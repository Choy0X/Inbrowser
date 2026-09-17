import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from "pdf-lib";
import type { DocBlock, InlineRun } from "./docModel";

/**
 * Hand-rolled page-flow PDF exporter: real, selectable text (not a
 * rasterized image), built from the same DocBlock IR as exportDocx.ts.
 * pdf-lib has no layout engine of its own — this implements word-wrap,
 * page breaks, and a simple table renderer on top of its coordinate-based
 * drawText/drawLine primitives.
 */

const PAGE_WIDTH = 612; // US Letter, points
const PAGE_HEIGHT = 792;
const MARGIN = 56;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
  italic: PDFFont;
  boldItalic: PDFFont;
  mono: PDFFont;
}

interface Word {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}

function splitRunsIntoWords(runs: InlineRun[]): Word[] {
  const words: Word[] = [];
  for (const run of runs) {
    const lines = run.text.split("\n");
    lines.forEach((line, li) => {
      for (const tok of line.split(/\s+/).filter(Boolean)) {
        words.push({ text: tok, bold: run.bold, italic: run.italic, code: run.code });
      }
      if (li < lines.length - 1) words.push({ text: "\n" });
    });
  }
  return words;
}

function fontFor(fonts: Fonts, w: Word): PDFFont {
  if (w.code) return fonts.mono;
  if (w.bold && w.italic) return fonts.boldItalic;
  if (w.bold) return fonts.bold;
  if (w.italic) return fonts.italic;
  return fonts.regular;
}

function truncateToWidth(text: string, font: PDFFont, size: number, maxWidth: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = `${text.slice(0, mid)}…`;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo < text.length ? `${text.slice(0, lo)}…` : text;
}

class Flow {
  doc: PDFDocument;
  fonts: Fonts;
  page: PDFPage;
  y: number;

  constructor(doc: PDFDocument, fonts: Fonts) {
    this.doc = doc;
    this.fonts = fonts;
    this.page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    this.y = PAGE_HEIGHT - MARGIN;
  }

  ensureSpace(height: number) {
    if (this.y - height < MARGIN) {
      this.page = this.doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      this.y = PAGE_HEIGHT - MARGIN;
    }
  }

  drawParagraph(
    runs: InlineRun[],
    opts: { size?: number; indent?: number; color?: [number, number, number] } = {}
  ) {
    const size = opts.size ?? 11;
    const lineHeight = size * 1.4;
    const indent = opts.indent ?? 0;
    const maxWidth = CONTENT_WIDTH - indent;
    const color = opts.color ? rgb(...opts.color) : rgb(0, 0, 0);
    const words = splitRunsIntoWords(runs);

    let line: Word[] = [];
    let lineWidth = 0;

    const flushLine = () => {
      if (line.length === 0) {
        this.y -= lineHeight;
        return;
      }
      this.ensureSpace(lineHeight);
      let x = MARGIN + indent;
      for (const w of line) {
        const font = fontFor(this.fonts, w);
        this.page.drawText(w.text, { x, y: this.y - size, size, font, color });
        x += font.widthOfTextAtSize(`${w.text} `, size);
      }
      this.y -= lineHeight;
      line = [];
      lineWidth = 0;
    };

    for (const w of words) {
      if (w.text === "\n") {
        flushLine();
        continue;
      }
      const font = fontFor(this.fonts, w);
      const wWidth = font.widthOfTextAtSize(`${w.text} `, size);
      if (lineWidth + wWidth > maxWidth && line.length > 0) flushLine();
      this.ensureSpace(lineHeight);
      line.push(w);
      lineWidth += wWidth;
    }
    flushLine();
  }
}

const HEADING_SIZES: Record<number, number> = { 1: 22, 2: 18, 3: 15, 4: 13, 5: 12, 6: 11 };

function drawTable(flow: Flow, block: Extract<DocBlock, { type: "table" }>) {
  const columns = Math.max(block.header.length, ...block.rows.map((r) => r.length), 1);
  const colWidth = CONTENT_WIDTH / columns;
  const size = 10;
  const rowPad = 6;
  const rowHeight = size * 1.4 + rowPad * 2;
  const allRows: { cells: InlineRun[][]; header: boolean }[] = [
    { cells: block.header, header: true },
    ...block.rows.map((cells) => ({ cells, header: false })),
  ];

  for (const row of allRows) {
    flow.ensureSpace(rowHeight);
    const rowTop = flow.y;
    for (let c = 0; c < columns; c++) {
      const cellRuns = row.cells[c] ?? [];
      const text = cellRuns.map((r) => r.text).join(" ");
      const font = row.header ? flow.fonts.bold : flow.fonts.regular;
      const x = MARGIN + c * colWidth + 4;
      flow.page.drawText(truncateToWidth(text, font, size, colWidth - 8), {
        x,
        y: rowTop - size - rowPad,
        size,
        font,
        color: rgb(0, 0, 0),
      });
    }
    flow.page.drawLine({
      start: { x: MARGIN, y: rowTop - rowHeight },
      end: { x: MARGIN + CONTENT_WIDTH, y: rowTop - rowHeight },
      thickness: 0.5,
      color: rgb(0.85, 0.85, 0.85),
    });
    flow.y = rowTop - rowHeight;
  }
  flow.y -= 8;
}

/** Converts parsed markdown blocks (see docModel.ts) into a real, text-selectable .pdf file. */
export async function exportPdf(blocks: DocBlock[]): Promise<Blob> {
  const doc = await PDFDocument.create();
  const fonts: Fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    italic: await doc.embedFont(StandardFonts.HelveticaOblique),
    boldItalic: await doc.embedFont(StandardFonts.HelveticaBoldOblique),
    mono: await doc.embedFont(StandardFonts.Courier),
  };
  const flow = new Flow(doc, fonts);

  for (const block of blocks) {
    switch (block.type) {
      case "heading":
        flow.y -= 6;
        flow.drawParagraph(block.runs, { size: HEADING_SIZES[block.level] ?? 12 });
        flow.y -= 4;
        break;
      case "paragraph":
        flow.drawParagraph(block.runs, { size: 11 });
        flow.y -= 6;
        break;
      case "blockquote":
        flow.drawParagraph(block.runs, { size: 11, indent: 20, color: [0.35, 0.35, 0.35] });
        flow.y -= 6;
        break;
      case "list":
        block.items.forEach((item, i) => {
          const marker = block.ordered ? `${i + 1}.` : "•";
          flow.drawParagraph([{ text: `${marker} ` }, ...item], { size: 11, indent: 18 });
        });
        flow.y -= 4;
        break;
      case "code": {
        for (const line of block.text.split("\n")) {
          flow.drawParagraph([{ text: line || " ", code: true }], { size: 9.5, indent: 10 });
        }
        flow.y -= 6;
        break;
      }
      case "hr":
        flow.ensureSpace(20);
        flow.page.drawLine({
          start: { x: MARGIN, y: flow.y },
          end: { x: PAGE_WIDTH - MARGIN, y: flow.y },
          thickness: 1,
          color: rgb(0.8, 0.8, 0.8),
        });
        flow.y -= 16;
        break;
      case "table":
        drawTable(flow, block);
        break;
    }
  }

  const bytes = await doc.save();
  return new Blob([new Uint8Array(bytes)], { type: "application/pdf" });
}
