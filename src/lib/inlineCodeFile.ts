import { classify } from "./fencedCodeArtifacts";

/**
 * Identity, naming and eligibility for the interactive code blocks rendered
 * inside chat prose (components/InlineCodeFile.tsx).
 *
 * A fenced block under fencedCodeArtifacts.ts's PROMOTE_THRESHOLD never becomes
 * an artifact, so it used to render as static highlighted text with nothing but
 * a Copy button. These helpers let the markdown renderer treat one as a small
 * file instead - runnable, editable, downloadable - without duplicating the
 * naming rules the artifact path already owns.
 */

/** Fences that already have their own renderer and must never become a file. */
const NON_FILE_LANGS = new Set(["mermaid", "latex", "tex", "math"]);

/**
 * Whether a fenced block should render as an interactive file.
 *
 * Both the `code` and the `pre` renderer in Markdown.tsx have to agree on this:
 * `pre` decides whether to wrap the result in `<pre data-ui="code-block">`, and
 * InlineCodeFile draws its own container. Two copies of the rule would mean a
 * file card nested inside a code block the moment they drifted, so there is
 * exactly one predicate and both call it.
 */
export function codeFileEligible(lang: string | undefined, code: string): boolean {
  if (!code.trim()) return false;
  if (!lang) return true;
  return !NON_FILE_LANGS.has(lang.toLowerCase());
}

/**
 * FNV-1a, 32-bit. Not a security hash - it only needs to change when the code
 * changes, cheaply enough to run on every block of every rendered message.
 */
function fnv1a(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/**
 * Stable key for a block's stored edit (ChatMessage.codeEdits).
 *
 * Position alone would silently re-target an edit onto a different block if the
 * message content ever changed; the content hash means a stale edit is dropped
 * instead of misapplied. Position is still part of the key so two identical
 * blocks in one message stay independently editable.
 */
export function inlineCodeKey(code: string, occurrence: number): string {
  return `${occurrence}:${fnv1a(code)}`;
}

/**
 * Display name and download filename, e.g. "snippet-1.py".
 *
 * Delegates the extension to fencedCodeArtifacts.ts's own `classify` rather
 * than repeating its alias table, so an inline block and the artifact the same
 * fence would have become above the threshold never disagree about the type.
 */
export function inlineCodeFilename(lang: string | undefined, code: string, index: number): string {
  const { ext } = classify(lang ?? "", code);
  return `snippet-${index}.${ext}`;
}

/** Monaco language id for a fence tag, falling back to plaintext. */
export function inlineCodeLanguage(lang: string | undefined): string {
  return lang?.toLowerCase() || "plaintext";
}
