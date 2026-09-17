import { useMemo, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Download } from "lucide-react";
import { downloadText } from "../lib/artifactDownload";
import { flattenNode } from "../lib/flattenNode";

/**
 * A GFM table in a chat message, made readable.
 *
 * The markdown renderer hands this the already-parsed `<thead>`/`<tbody>`
 * React tree rather than the source text, so remark-gfm stays the only thing
 * that parses markdown - this only re-presents what it produced.
 *
 * What it adds over a plain `<table>`: click-to-sort columns, numeric columns
 * right-aligned in tabular figures so digits line up, a sticky header once the
 * table is tall, and CSV export. A table of numbers where the numbers do not
 * align is the thing being fixed; every cell was hard-coded `text-left`.
 *
 * Chat only. `BrowserPanel`, `SkillInfoDialog` and `AgentRunPane` render the
 * plain table, since sorting someone else's fetched page is not meaningful.
 */

type SortDir = "asc" | "desc";

/** A column is numeric when every non-empty cell in it parses as a number. */
function isNumeric(values: string[]): boolean {
  const filled = values.filter((v) => v.trim() !== "");
  if (filled.length === 0) return false;
  return filled.every((v) => Number.isFinite(Number(v.replace(/[,\s$%]/g, ""))));
}

function toNumber(value: string): number {
  return Number(value.replace(/[,\s$%]/g, ""));
}

interface TableModel {
  headers: string[];
  rows: string[][];
  /** The original cell nodes, so links and formatting inside cells survive. */
  nodes: ReactNode[][];
  numeric: boolean[];
}

/** Walks the hast-derived React tree ReactMarkdown produced for one table. */
function readTable(children: ReactNode): TableModel | null {
  const headers: string[] = [];
  const rows: string[][] = [];
  const nodes: ReactNode[][] = [];

  const visitRow = (row: any, into: "head" | "body") => {
    const cells: ReactNode[] = [];
    const texts: string[] = [];
    const kids = row?.props?.children;
    const list = Array.isArray(kids) ? kids : [kids];
    for (const cell of list) {
      if (!cell || typeof cell !== "object") continue;
      cells.push(cell.props?.children ?? "");
      texts.push(flattenNode(cell.props?.children).trim());
    }
    if (texts.length === 0) return;
    if (into === "head") headers.push(...texts);
    else {
      rows.push(texts);
      nodes.push(cells);
    }
  };

  const walk = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const type = node.type;
    const kids = node.props?.children;
    if (type === "thead") {
      const list = Array.isArray(kids) ? kids : [kids];
      list.forEach((r: any) => visitRow(r, "head"));
      return;
    }
    if (type === "tbody") {
      const list = Array.isArray(kids) ? kids : [kids];
      list.forEach((r: any) => visitRow(r, "body"));
      return;
    }
    walk(kids);
  };

  walk(children);
  if (headers.length === 0 || rows.length === 0) return null;

  const numeric = headers.map((_, col) => isNumeric(rows.map((r) => r[col] ?? "")));
  return { headers, rows, nodes, numeric };
}

function toCsv(model: TableModel, order: number[]): string {
  const escape = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [model.headers.map(escape).join(",")];
  for (const i of order) lines.push((model.rows[i] ?? []).map(escape).join(","));
  return lines.join("\n");
}

/** Tables below this stay unsorted and unadorned - the controls would outweigh them. */
const MIN_ROWS_FOR_CONTROLS = 3;
/** Past this the header sticks while the body scrolls. */
const MAX_HEIGHT_ROWS = 12;

export function DataTable({ children }: { children?: ReactNode }) {
  const model = useMemo(() => readTable(children), [children]);
  const [sort, setSort] = useState<{ col: number; dir: SortDir } | null>(null);

  // Computed before the bail-out below: a hook may not sit behind an early
  // return, so the null-model case is handled inside the memo instead.
  const order = useMemo(() => {
    if (!model) return [];
    const indices = model.rows.map((_, i) => i);
    if (!sort) return indices;
    const { col, dir } = sort;
    const num = model.numeric[col];
    return indices.sort((a, b) => {
      const av = model.rows[a][col] ?? "";
      const bv = model.rows[b][col] ?? "";
      // Blanks sort last in both directions: an empty cell is missing data, not
      // a value smaller than everything else.
      if (av.trim() === "") return bv.trim() === "" ? 0 : 1;
      if (bv.trim() === "") return -1;
      const cmp = num ? toNumber(av) - toNumber(bv) : av.localeCompare(bv);
      return dir === "asc" ? cmp : -cmp;
    });
  }, [model, sort]);

  // Anything this failed to read renders exactly as before - a malformed or
  // unusual table should never disappear because the enhancement did not apply.
  if (!model) {
    return (
      <div className="markdown-table-wrap">
        <table>{children}</table>
      </div>
    );
  }

  const controls = model.rows.length >= MIN_ROWS_FOR_CONTROLS;
  const scrolls = model.rows.length > MAX_HEIGHT_ROWS;

  const toggle = (col: number) => {
    setSort((s) => (s?.col === col ? { col, dir: s.dir === "asc" ? "desc" : "asc" } : { col, dir: "asc" }));
  };

  return (
    <div className="my-2">
      <div className={`markdown-table-wrap ${scrolls ? "max-h-[26rem] overflow-y-auto" : ""}`}>
        <table>
          <thead>
            <tr>
              {model.headers.map((header, col) => (
                <th
                  key={col}
                  className={`${scrolls ? "sticky top-0 z-10" : ""} ${model.numeric[col] ? "!text-right" : ""}`}
                >
                  {controls ? (
                    <button
                      type="button"
                      onClick={() => toggle(col)}
                      aria-label={`Sort by ${header}`}
                      className={`inline-flex w-full items-center gap-1 transition-colors hover:text-fg ${
                        model.numeric[col] ? "justify-end" : ""
                      }`}
                    >
                      {header}
                      {sort?.col === col ? (
                        sort.dir === "asc" ? (
                          <ArrowUp size={11} className="shrink-0 text-accent" />
                        ) : (
                          <ArrowDown size={11} className="shrink-0 text-accent" />
                        )
                      ) : (
                        <ArrowUpDown size={11} className="shrink-0 opacity-30" />
                      )}
                    </button>
                  ) : (
                    header
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {order.map((row) => (
              <tr key={row}>
                {model.nodes[row]?.map((cell, col) => (
                  <td key={col} className={model.numeric[col] ? "!text-right tabular-nums" : ""}>
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {controls && (
        <div className="mt-1 flex justify-end">
          <button
            type="button"
            onClick={() => downloadText("table.csv", toCsv(model, order))}
            aria-label="Download this table as CSV"
            className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-fg-faint transition-colors hover:bg-bg-hover hover:text-fg"
          >
            <Download size={11} /> CSV
          </button>
        </div>
      )}
    </div>
  );
}
