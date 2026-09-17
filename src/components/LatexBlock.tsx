import { useEffect, useState } from "react";

/**
 * Some models present a "LaTeX block" answer by wrapping the raw formula in
 * a fenced code block (```latex / ```tex / ```math) instead of `$$...$$`.
 * `rehype-katex` only recognizes a ```math fence, and even then only once
 * remark-math/rehype-katex are already active for that message (gated on
 * the message containing a literal `$` elsewhere - see Markdown.tsx) - a
 * `latex`/`tex`-tagged fence, or a lone `math` fence with no other `$` in
 * the message, would otherwise fall through to plain syntax highlighting
 * forever. This calls KaTeX directly on the fence's own content so all
 * three language tags render as math regardless of the rest of the message.
 */
let katexPromise: Promise<typeof import("katex")> | null = null;
function loadKatex() {
  if (!katexPromise) {
    katexPromise = Promise.all([import("katex"), import("katex/dist/katex.min.css")]).then(
      ([katexMod]) => katexMod
    );
  }
  return katexPromise;
}

/**
 * A model asked for "a LaTeX block" often includes the `$$...$$`/`\[...\]`
 * delimiters *inside* the fence too, as part of demonstrating the syntax -
 * `katex.renderToString` expects only the bare expression, and a literal
 * leading/trailing `$` in its input is itself a parse error. Strip one
 * matching pair off the ends, longest first so `$$` isn't mistaken for two
 * single `$`s.
 */
const DELIMITER_PAIRS: [string, string][] = [
  ["$$", "$$"],
  ["\\[", "\\]"],
  ["\\(", "\\)"],
  ["$", "$"],
];
function stripMathDelimiters(raw: string): string {
  const trimmed = raw.trim();
  for (const [open, close] of DELIMITER_PAIRS) {
    if (trimmed.length > open.length + close.length && trimmed.startsWith(open) && trimmed.endsWith(close)) {
      return trimmed.slice(open.length, trimmed.length - close.length).trim();
    }
  }
  return trimmed;
}

/** Renders a ```latex/```tex/```math fenced code block as display math,
 * showing the raw source (like a normal code block) while `streaming` is
 * true - same reasoning as MermaidDiagram: it can't render meaningfully
 * until the fence's content is actually complete. */
export function LatexBlock({ code, streaming }: { code: string; streaming?: boolean }) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    if (streaming) return;
    let cancelled = false;
    setHtml(null);
    void loadKatex().then(({ default: katex }) => {
      if (cancelled) return;
      try {
        // throwOnError: false + strict: "ignore" mirror rehype-katex's own
        // fallback behavior - render whatever KaTeX can, inline error spans
        // for the rest, rather than throwing on a malformed formula.
        setHtml(
          katex.renderToString(stripMathDelimiters(code), {
            displayMode: true,
            throwOnError: false,
            strict: "ignore",
          })
        );
      } catch {
        setHtml(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [code, streaming]);

  if (streaming || html === null) {
    return (
      <pre data-ui="code-block" className="code-block">
        <code>{code}</code>
      </pre>
    );
  }
  // No `trust` option is passed above, so KaTeX uses its default `trust:
  // false` - it refuses to emit commands that could produce unsafe output
  // (\href/\url/\includegraphics with untrusted targets, raw HTML embeds,
  // etc.), the same default rehype-katex relies on for every other formula
  // this app already renders via the normal $...$ path.
  return <div className="markdown-katex-block" dangerouslySetInnerHTML={{ __html: html }} />;
}
