import type { MouseEvent, ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { default as RemarkMath } from "remark-math";
import type { default as RehypeKatex } from "rehype-katex";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import type { SearchResult } from "../lib/types";
import { normalizeCitationMarkers } from "../lib/citations";
import { normalizeMathDelimiters } from "../lib/mathDelimiters";
import { CitationPopover } from "./CitationPopover";
import { CodeBlockHeader } from "./CodeBlockHeader";
import { MermaidDiagram } from "./MermaidDiagram";
import { LatexBlock } from "./LatexBlock";

/* ---------------------------------------------------------------------------
 * rehypeCitations — inline citation engine.
 *
 * The entire document is parsed ONCE (single unified pass), so markdown block
 * and inline structure (bold, italic, code, lists, tables, math …) survives
 * intact. A rehype plugin then walks the rendered hast tree and replaces every
 * `[n]` citation marker found in prose text nodes with a `<cite-badge>`
 * element. Fragmenting the raw string and re-parsing each chunk — the old
 * approach — split paragraphs and broke inline formatting across citations.
 *
 * Citations inside code/pre subtrees are left literal on purpose.
 * ------------------------------------------------------------------------- */

const CITE_RE = /\[([0-9]{1,3})\]/g;

interface CitePart {
  text?: string;
  index?: string;
}

function splitCitations(value: string): CitePart[] {
  const parts: CitePart[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = CITE_RE.exec(value)) !== null) {
    if (m.index > last) parts.push({ text: value.slice(last, m.index) });
    parts.push({ index: m[1] });
    last = m.index + m[0].length;
  }
  CITE_RE.lastIndex = 0;
  if (last < value.length) parts.push({ text: value.slice(last) });
  return parts;
}

interface HastNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/** Whether a hast element's `className` (string or array form) contains `needle`. */
function hasClassName(properties: Record<string, unknown> | undefined, needle: string): boolean {
  const className = properties?.className;
  if (typeof className === "string") return className.includes(needle);
  if (Array.isArray(className)) return className.some((c) => String(c).includes(needle));
  return false;
}

function rehypeCitations() {
  return (tree: HastNode) => {
    const walk = (parent: HastNode, index: number) => {
      const node = parent.children?.[index];
      if (!node) return;

      // Never touch code / pre / script / style subtrees — keep citations literal.
      // Also skip rendered KaTeX math: its markup nests plain-text spans (and a
      // raw-source <annotation>) that a "[n]" match could otherwise corrupt.
      if (
        node.type === "element" &&
        (node.tagName === "code" ||
          node.tagName === "pre" ||
          node.tagName === "script" ||
          node.tagName === "style" ||
          hasClassName(node.properties, "katex"))
      ) {
        return;
      }

      if (node.type === "text" && typeof node.value === "string") {
        const parts = splitCitations(node.value);
        if (parts.length > 1) {
          parent.children!.splice(
            index,
            1,
            ...parts.map((part): HastNode =>
              part.index !== undefined
                ? {
                    type: "element",
                    tagName: "cite-badge",
                    properties: {},
                    children: [{ type: "text", value: part.index }],
                  }
                : { type: "text", value: part.text ?? "" },
            ),
          );
          return;
        }
      }

      if (node.children && node.children.length > 0) {
        for (let i = 0; i < node.children.length; i++) walk(node, i);
      }
    };

    const root = tree as HastNode;
    if (root.children) {
      for (let i = 0; i < root.children.length; i++) walk(root, i);
    }
  };
}

/* ---------------------------------------------------------------------------
 * Shared markdown renderers
 * ------------------------------------------------------------------------- */

function flattenText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(flattenText).join("");
  return "";
}

const SAFE_URL_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

/**
 * True if href is safe to place in a real, clickable <a href>. Rejects
 * javascript:/data:/vbscript:/etc — a markdown link with one of those hrefs
 * renders a real anchor that executes on click, which matters more once this
 * renderer displays arbitrary third-party content (fetched web pages), not
 * just model-authored chat text.
 */
function isSafeHref(href: string | undefined): boolean {
  if (!href) return false;
  try {
    return SAFE_URL_PROTOCOLS.has(new URL(href, document.baseURI).protocol);
  } catch {
    return false;
  }
}

/** Fenced-code language tags some models use to present a standalone LaTeX
 * answer instead of `$$...$$` - rendered as display math, not syntax-
 * highlighted code (see LatexBlock.tsx for why this can't be left to
 * rehype-katex's own, narrower `language-math` support). */
const LATEX_FENCE_LANGS = new Set(["latex", "tex", "math"]);

const markdownComponents = {
  code({ node, className, children, streaming, ...props }: any) {
    const match = /language-(\w+)/.exec(className || "");
    const code = String(children).replace(/\n$/, "");
    if (match?.[1] === "mermaid") {
      return <MermaidDiagram code={code} streaming={streaming} />;
    }
    if (match && LATEX_FENCE_LANGS.has(match[1])) {
      return <LatexBlock code={code} streaming={streaming} />;
    }
    if (match) {
      return (
        <>
          <CodeBlockHeader language={match[1]} code={code} />
          <SyntaxHighlighter
            language={match[1]}
            style={oneDark}
            PreTag="div"
            customStyle={{ margin: 0, background: "transparent" }}
          >
            {code}
          </SyntaxHighlighter>
        </>
      );
    }
    return <code className="inline-code" {...props}>{children}</code>;
  },
  pre({ node, children }: any) {
    // A rendered mermaid diagram / KaTeX block (or its own error/streaming
    // fallback <pre>) shouldn't be nested inside another <pre data-ui="code-block">.
    const codeClassName = node?.children?.[0]?.properties?.className;
    const lang = Array.isArray(codeClassName)
      ? codeClassName.find((c: unknown) => typeof c === "string" && c.startsWith("language-"))?.slice(9)
      : undefined;
    if (lang === "mermaid" || LATEX_FENCE_LANGS.has(lang)) return <>{children}</>;
    return (
      <pre data-ui="code-block" className="code-block">
        {children}
      </pre>
    );
  },
  a({ href, children, onLinkClick }: any) {
    if (!isSafeHref(href)) {
      return <span className="markdown-unsafe-link">{children}</span>;
    }
    if (onLinkClick) {
      return (
        <a
          href={href}
          onClick={(e: MouseEvent) => {
            e.preventDefault();
            onLinkClick(href);
          }}
        >
          {children}
        </a>
      );
    }
    return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
  },
  table({ children }: any) {
    return (
      <div className="markdown-table-wrap">
        <table>{children}</table>
      </div>
    );
  },
};

/**
 * KaTeX (and its remark/rehype glue) is only fetched once a message actually
 * contains math - most chat turns never do, and katex alone is a ~260KB
 * chunk, so it follows the same lazy-on-demand pattern as Monaco/WebLLM/
 * Pyodide rather than shipping in every page load.
 */
let mathPluginsPromise: Promise<{ remarkMath: typeof RemarkMath; rehypeKatex: typeof RehypeKatex }> | null = null;
function loadMathPlugins() {
  if (!mathPluginsPromise) {
    mathPluginsPromise = Promise.all([
      import("remark-math"),
      import("rehype-katex"),
      import("katex/dist/katex.min.css"),
    ]).then(([remarkMathMod, rehypeKatexMod]) => ({
      remarkMath: remarkMathMod.default,
      rehypeKatex: rehypeKatexMod.default,
    }));
  }
  return mathPluginsPromise;
}

/** Cheap pre-check on already-`$`-normalized text (see normalizeMathDelimiters). */
const HAS_DOLLAR_MATH_RE = /\$/;

/**
 * Cheap pre-check on the RAW (pre-normalization) text, used only to decide
 * when to start *prefetching* the math plugin. `\( \)`/`\[ \]` delimiters
 * only turn into `$...$`/`$$...$$` once their closing half has streamed in
 * (see normalizeMathDelimiters), so checking the normalized text here would
 * miss an in-progress `\(` entirely - the prefetch wouldn't even start until
 * the formula was already "done," turning what should be an invisible,
 * ahead-of-time fetch into a visible lag right when the formula completes.
 * Checking the raw text for a bare opening delimiter starts the fetch as
 * early as the first character of the formula, same as `$` already does.
 */
const HAS_MATH_HINT_RE = /\$|\\\(|\\\[/;

/** ReactMarkdown tuned for the app (GFM + shared components). */
function BaseMarkdown({
  text,
  cited,
  citations,
  onLinkClick,
  streaming,
}: {
  text: string;
  cited?: boolean;
  citations?: SearchResult[];
  onLinkClick?: (href: string) => void;
  streaming?: boolean;
}) {
  const normalized = useMemo(() => normalizeMathDelimiters(text), [text]);
  const hasMath = HAS_DOLLAR_MATH_RE.test(normalized);
  const hasMathHint = HAS_MATH_HINT_RE.test(text);

  const [mathPlugins, setMathPlugins] = useState<{
    remarkMath: typeof RemarkMath;
    rehypeKatex: typeof RehypeKatex;
  } | null>(null);

  useEffect(() => {
    if (!hasMathHint || mathPlugins) return;
    let cancelled = false;
    void loadMathPlugins().then((plugins) => {
      if (!cancelled) setMathPlugins(plugins);
    });
    return () => {
      cancelled = true;
    };
  }, [hasMathHint, mathPlugins]);

  // An in-progress formula/diagram can't render meaningfully until it's
  // complete, so keep it as prefetched-but-inert while streaming: the plugin
  // is fetched ahead of time (no added latency once the message finishes),
  // but only *activated* once streaming ends - until then the raw `$...$`
  // text shows as-is instead of flashing a KaTeX parse-error mid-formula.
  const mathReady = hasMath && !!mathPlugins && !streaming;

  const remarkPlugins = mathReady ? [remarkGfm, mathPlugins.remarkMath] : [remarkGfm];
  const rehypePlugins = [
    ...(mathReady ? [mathPlugins.rehypeKatex] : []),
    ...(cited ? [rehypeCitations] : []),
  ];
  const components = {
    ...markdownComponents,
    code: (props: any) => markdownComponents.code({ ...props, streaming }),
    ...(onLinkClick ? { a: (props: any) => markdownComponents.a({ ...props, onLinkClick }) } : {}),
    ...(cited
      ? { "cite-badge": (props: any) => <CiteBadge {...props} citations={citations!} /> }
      : {}),
  };

  return (
    <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
      {normalized}
    </ReactMarkdown>
  );
}

/** Plain markdown renderer (block wrapper). Pass `onLinkClick` to intercept
 * link clicks (e.g. to navigate a panel in place) instead of the default
 * open-in-a-new-tab behaviour. Pass `streaming` while the text is still
 * arriving so math/mermaid show their raw source instead of a flickering
 * partial render until the message is complete. */
export function Markdown({
  text,
  onLinkClick,
  streaming,
}: {
  text: string;
  onLinkClick?: (href: string) => void;
  streaming?: boolean;
}) {
  return (
    <div className="markdown">
      <BaseMarkdown text={text} onLinkClick={onLinkClick} streaming={streaming} />
    </div>
  );
}

/** Markdown with inline citation badges ([n] → hover/click popover). */
export function CitedMarkdown({
  text,
  citations,
  streaming,
}: {
  text: string;
  citations: SearchResult[];
  streaming?: boolean;
}) {
  // Normalize the RAW string before any parsing: the model sometimes emits
  // citation groups on their own lines / blank-line-separated, which the
  // parser would otherwise turn into separate block elements. This turns e.g.
  //   "...time zone (+01)\n[2] [3]\n\n. The exact time…"
  // into one inline paragraph so badges stay glued to the text they support.
  const normalized = useMemo(() => normalizeCitationMarkers(text), [text]);
  return (
    <div className="markdown">
      <BaseMarkdown text={normalized} cited citations={citations} streaming={streaming} />
    </div>
  );
}

interface CiteBadgeProps {
  children?: ReactNode;
  citations: SearchResult[];
}

function CiteBadge({ children, citations }: CiteBadgeProps) {
  const index = parseInt(flattenText(children).trim(), 10);
  const result = citations[index - 1];

  if (!result) {
    // Unknown citation — render plainly so the number isn't lost.
    return <sup className="cite-unknown">[{index}]</sup>;
  }

  return (
    <CitationPopover
      result={result}
      index={index}
      onOpen={() => window.open(result.url, "_blank", "noopener,noreferrer")}
    />
  );
}