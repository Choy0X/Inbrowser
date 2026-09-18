import { parseChartSpec } from "./chartSpec";

const FENCE_RE = /^```/;

/**
 * Some models - especially weak or free ones behind an opaque router - skip
 * the ```chart fence entirely and paste the chart's JSON body as an ordinary
 * paragraph instead. Nothing hooks into unfenced text, so it would otherwise
 * render as inert wrapped prose forever. This wraps a standalone paragraph
 * that's genuinely a valid chart spec in a synthetic ```chart fence before
 * handoff to ReactMarkdown, so it reaches ChartBlock exactly the way a
 * well-behaved model's own fence would.
 *
 * Deliberately conservative: a paragraph only qualifies if it fully parses as
 * JSON *and* fully validates via parseChartSpec (right type, usable data,
 * pie/series-count rules, no dual axis, ...) - ordinary prose that merely
 * mentions a chart, or JSON that isn't chart-shaped, is left untouched. Runs
 * on the raw markdown source, before remark/rehype ever tokenize it, so it
 * can't corrupt the JSON the way operating on already-parsed inline nodes
 * would (an underscore or asterisk inside a JSON string is markdown emphasis
 * syntax to remark). Text already inside a fence is never touched, so a
 * fenced JSON example pasted for some other reason is left alone.
 */
export function wrapBareChartParagraphs(text: string): string {
  // Cheap bail-out before doing any line-by-line work on ordinary prose.
  if (!text.includes("{") || !text.includes('"type"')) return text;

  const lines = text.split("\n");
  const out: string[] = [];
  let inFence = false;
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const candidate = paragraph.join("\n").trim();
    if (candidate.startsWith("{") && candidate.endsWith("}") && parseChartSpec(candidate).ok) {
      out.push("```chart", candidate, "```");
    } else {
      out.push(...paragraph);
    }
    paragraph = [];
  };

  for (const line of lines) {
    if (FENCE_RE.test(line.trim())) {
      flushParagraph();
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence || line.trim() === "") {
      flushParagraph();
      out.push(line);
      continue;
    }
    paragraph.push(line);
  }
  flushParagraph();

  return out.join("\n");
}
