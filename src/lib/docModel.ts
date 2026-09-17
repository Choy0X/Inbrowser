import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";

/**
 * Shared intermediate representation for exporting an artifact's markdown
 * source to real binary documents (see exportDocx.ts / exportPdf.ts).
 * Deliberately scoped to the markdown subset ARTIFACT_SYSTEM_PROMPT asks the
 * model to use — headings, paragraphs, lists, tables, bold/italic,
 * blockquotes, code, horizontal rules — not full CommonMark.
 */

export interface InlineRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}

export type DocBlock =
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; runs: InlineRun[] }
  | { type: "paragraph"; runs: InlineRun[] }
  | { type: "list"; ordered: boolean; items: InlineRun[][] }
  | { type: "table"; header: InlineRun[][]; rows: InlineRun[][][] }
  | { type: "blockquote"; runs: InlineRun[] }
  | { type: "code"; text: string; lang?: string }
  | { type: "hr" };

/** Loose shape covering the mdast node fields this module actually reads. */
interface MdNode {
  type: string;
  children?: MdNode[];
  value?: string;
  depth?: number;
  ordered?: boolean | null;
  lang?: string | null;
}

function inlineRuns(node: MdNode, active: { bold?: boolean; italic?: boolean; code?: boolean } = {}): InlineRun[] {
  if (node.type === "text") return node.value ? [{ text: node.value, ...active }] : [];
  if (node.type === "inlineCode") return node.value ? [{ text: node.value, ...active, code: true }] : [];
  if (node.type === "break") return [{ text: "\n", ...active }];
  if (node.type === "strong") return (node.children ?? []).flatMap((c) => inlineRuns(c, { ...active, bold: true }));
  if (node.type === "emphasis") return (node.children ?? []).flatMap((c) => inlineRuns(c, { ...active, italic: true }));
  if (node.children) return node.children.flatMap((c) => inlineRuns(c, active));
  return node.value ? [{ text: node.value, ...active }] : [];
}

function blockFromNode(node: MdNode): DocBlock | null {
  switch (node.type) {
    case "heading": {
      const level = Math.min(6, Math.max(1, node.depth ?? 1)) as 1 | 2 | 3 | 4 | 5 | 6;
      return { type: "heading", level, runs: inlineRuns(node) };
    }
    case "paragraph":
      return { type: "paragraph", runs: inlineRuns(node) };
    case "blockquote":
      return { type: "blockquote", runs: (node.children ?? []).flatMap((c) => inlineRuns(c)) };
    case "list": {
      const items = (node.children ?? []).map((li) => (li.children ?? []).flatMap((c) => inlineRuns(c)));
      return { type: "list", ordered: !!node.ordered, items };
    }
    case "code":
      return { type: "code", text: node.value ?? "", lang: node.lang ?? undefined };
    case "thematicBreak":
      return { type: "hr" };
    case "table": {
      const rows = (node.children ?? []).map((row) => (row.children ?? []).map((cell) => inlineRuns(cell)));
      const [header, ...body] = rows;
      return { type: "table", header: header ?? [], rows: body };
    }
    default:
      // Unsupported node types (raw html, footnotes, etc.) are skipped rather
      // than failing the whole export — the model is instructed to stick to
      // this subset, so this is a defensive fallback, not the common path.
      return null;
  }
}

export function parseMarkdownToBlocks(markdown: string): DocBlock[] {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown) as unknown as MdNode;
  const blocks: DocBlock[] = [];
  for (const node of tree.children ?? []) {
    const block = blockFromNode(node);
    if (block) blocks.push(block);
  }
  return blocks;
}
