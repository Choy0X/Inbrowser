import initSqlJs from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";

/**
 * SQLite, via sql.js.
 *
 * The database is in-memory and recreated per run, so a snippet is always
 * reproducible and nothing a model writes can persist. Results are printed as
 * an aligned table rather than JSON, because the output goes to a console pane
 * that a person reads.
 *
 * The wasm binary is imported with `?url` so Vite fingerprints it and serves it
 * from our own origin - no CDN fetch, and it lands in the browser cache like
 * any other asset.
 */

type InMessage = { kind: "run"; runId: string; code: string };
type OutMessage =
  | { kind: "ready"; runId: string }
  | { kind: "stdout" | "stderr"; runId: string; line: string }
  | { kind: "done"; runId: string }
  | { kind: "error"; runId: string; message: string };

function post(msg: OutMessage): void {
  (self as unknown as Worker).postMessage(msg);
}

type SqlJs = Awaited<ReturnType<typeof initSqlJs>>;
let sqlPromise: Promise<SqlJs> | null = null;

function getSql(): Promise<SqlJs> {
  if (!sqlPromise) sqlPromise = initSqlJs({ locateFile: () => wasmUrl });
  return sqlPromise;
}

/** Render one result set as a padded text table. */
function renderTable(columns: string[], values: unknown[][]): string[] {
  const rows = values.map((row) => row.map((v) => (v === null ? "NULL" : String(v))));
  const widths = columns.map((c, i) =>
    Math.max(c.length, ...rows.map((r) => (r[i] ?? "").length), 3)
  );
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join("  ");
  return [line(columns), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(line)];
}

self.onmessage = async (event: MessageEvent<InMessage>) => {
  const { kind, runId, code } = event.data;
  if (kind !== "run") return;

  try {
    const SQL = await getSql();
    post({ kind: "ready", runId });

    const db = new SQL.Database();
    try {
      const results = db.exec(code);
      if (results.length === 0) {
        post({ kind: "stdout", runId, line: "OK (no rows returned)" });
      }
      for (const result of results) {
        for (const line of renderTable(result.columns, result.values as unknown[][])) {
          post({ kind: "stdout", runId, line });
        }
        post({ kind: "stdout", runId, line: `(${result.values.length} row${result.values.length === 1 ? "" : "s"})` });
      }
      post({ kind: "done", runId });
    } finally {
      db.close();
    }
  } catch (err) {
    post({ kind: "error", runId, message: err instanceof Error ? err.message : String(err) });
  }
};
