import { BorderStyle, Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from "docx";
import type { DocBlock, InlineRun } from "./docModel";

const HEADING_MAP = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
  4: HeadingLevel.HEADING_4,
  5: HeadingLevel.HEADING_5,
  6: HeadingLevel.HEADING_6,
} as const;

function runsToTextRuns(runs: InlineRun[], prefix?: string): TextRun[] {
  const out: TextRun[] = [];
  if (prefix) out.push(new TextRun({ text: prefix }));
  if (runs.length === 0) {
    if (out.length === 0) out.push(new TextRun(""));
    return out;
  }
  for (const r of runs) {
    out.push(new TextRun({ text: r.text, bold: r.bold, italics: r.italic, font: r.code ? "Consolas" : undefined }));
  }
  return out;
}

function tableCell(runs: InlineRun[], columns: number): TableCell {
  return new TableCell({
    children: [new Paragraph({ children: runsToTextRuns(runs) })],
    width: { size: Math.round(100 / Math.max(columns, 1)), type: WidthType.PERCENTAGE },
  });
}

function blockToDocxElements(block: DocBlock): (Paragraph | Table)[] {
  switch (block.type) {
    case "heading":
      return [new Paragraph({ heading: HEADING_MAP[block.level], children: runsToTextRuns(block.runs) })];
    case "paragraph":
      return [new Paragraph({ children: runsToTextRuns(block.runs) })];
    case "blockquote":
      return [
        new Paragraph({
          children: runsToTextRuns(block.runs),
          indent: { left: 480 },
          border: { left: { style: BorderStyle.SINGLE, size: 12, color: "CCCCCC", space: 8 } },
        }),
      ];
    case "list":
      return block.items.map(
        (item, i) =>
          new Paragraph(
            block.ordered
              ? { children: runsToTextRuns(item, `${i + 1}. `) }
              : { children: runsToTextRuns(item), bullet: { level: 0 } }
          )
      );
    case "code":
      return block.text.split("\n").map(
        (line) =>
          new Paragraph({
            children: [new TextRun({ text: line || " ", font: "Consolas", size: 20 })],
            shading: { fill: "F5F5F5" },
          })
      );
    case "hr":
      return [new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "CCCCCC", space: 4 } } })];
    case "table": {
      const columns = Math.max(block.header.length, ...block.rows.map((r) => r.length), 1);
      const rows = [
        new TableRow({ children: block.header.map((c) => tableCell(c, columns)) }),
        ...block.rows.map((r) => new TableRow({ children: r.map((c) => tableCell(c, columns)) })),
      ];
      return [new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } })];
    }
  }
}

/** Converts parsed markdown blocks (see docModel.ts) into a real .docx file. */
export async function exportDocx(blocks: DocBlock[]): Promise<Blob> {
  const children = blocks.flatMap(blockToDocxElements);
  const doc = new Document({
    sections: [{ children: children.length > 0 ? children : [new Paragraph("")] }],
  });
  return Packer.toBlob(doc);
}
