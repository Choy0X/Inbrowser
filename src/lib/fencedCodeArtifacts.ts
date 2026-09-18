import type { ArtifactType, GeneratedArtifact } from "./types";
import { reduceArtifactEvent, type ArtifactStreamEvent } from "./artifacts";

/**
 * Fallback for models that ignore the <fachoy-artifact> tag contract
 * (artifacts.ts) and just dump a file in an ordinary ``` fenced code block
 * instead — common on weaker/free models. Left as inline prose, that never
 * shows up as a viewable/downloadable file card.
 *
 * This runs as a second stage on the plain prose text the tag-based parser
 * already produced (artifacts.ts's `prose` output), operating line-by-line
 * since fences are inherently line-delimited. Every fenced block promotes:
 * as soon as a fence's first line of real content arrives, it's "promoted" —
 * synthesized start/chunk/end events (same shape as artifacts.ts's, so they
 * feed the same reduceArtifactEvent/ArtifactBlock/ArtifactPanel UI), and the
 * raw text stops being appended to the visible message content at all.
 *
 * Two exceptions stay as literal prose instead of promoting: a truly empty
 * fence (closed before any content line, nothing to promote), and a fence
 * tagged with a language in NON_FILE_LANGS (mermaid, latex, tex, math,
 * chart) — those already have a dedicated live renderer in Markdown.tsx
 * (MermaidDiagram/LatexBlock/ChartBlock), and ArtifactPanel.tsx has no
 * preview for them, so promoting would strand them as raw/syntax-
 * highlighted text with no way back. See inlineCodeFile.ts's
 * InlineCodeFile, which used to render every fenced block below a size
 * threshold as a small in-bubble card; now it's a safety net for stored
 * history and edge cases only, never the live path for a fresh message.
 */

const FENCE_OPEN_RE = /^```(\S*)[ \t]*$/;
const FENCE_CLOSE_RE = /^```[ \t]*$/;
/** The marker both regexes above are anchored on. */
const FENCE = "```";

const LANG_TO_TYPE: Record<string, { type: ArtifactType; ext: string }> = {
  html: { type: "html", ext: "html" },
  htm: { type: "html", ext: "html" },
  svg: { type: "svg", ext: "svg" },
  markdown: { type: "markdown", ext: "md" },
  md: { type: "markdown", ext: "md" },
};

/** Fence languages that already have a dedicated live renderer in
 *  Markdown.tsx (MermaidDiagram/LatexBlock/ChartBlock) and must never be
 *  promoted into a generic file artifact — see inlineCodeFile.ts's
 *  codeFileEligible(), which uses this same set for the post-fallback
 *  "should this render as a small file card" decision. */
export const NON_FILE_LANGS = new Set(["mermaid", "latex", "tex", "math", "chart"]);

const EXT_ALIASES: Record<string, string> = {
  javascript: "js",
  typescript: "ts",
  jsx: "jsx",
  tsx: "tsx",
  python: "py",
  py: "py",
  bash: "sh",
  shell: "sh",
  sh: "sh",
  yaml: "yml",
  yml: "yml",
  csharp: "cs",
  "c++": "cpp",
  cpp: "cpp",
  rust: "rs",
  golang: "go",
  go: "go",
};

/** Also the single source of the extension an inline code block downloads as -
 *  see inlineCodeFile.ts, which calls this rather than repeating EXT_ALIASES. */
export function classify(lang: string, body: string): { type: ArtifactType; language?: string; ext: string } {
  const key = lang.toLowerCase();
  const known = LANG_TO_TYPE[key];
  if (known) return known;
  if (!key) {
    // Search rather than requiring an exact prefix — a leading blank line or
    // an HTML comment before <!DOCTYPE> would otherwise fall through to a
    // generic "code" artifact with no live preview (see ArtifactPanel.tsx's
    // renderableMarkupKind, which only widens the net for a *declared*
    // language, not a fence with none at all).
    const sniffed = body.slice(0, 300);
    if (/<!doctype\s+html/i.test(sniffed) || /<html[\s>]/i.test(sniffed)) {
      return { type: "html", ext: "html" };
    }
    return { type: "code", language: "text", ext: "txt" };
  }
  const ext = EXT_ALIASES[key] ?? key.replace(/[^a-z0-9]/g, "") ?? "txt";
  return { type: "code", language: key, ext: ext || "txt" };
}

type Mode = "prose" | "fenceBuffering" | "fencePromoted" | "fenceLiteral";

/** A model that fences its whole <fachoy-artifact> tag despite the contract
 *  saying not to (artifactRecovery.ts's recoverFencedArtifactMessage handles
 *  this after the stream ends, using the tag's own type/title attributes,
 *  which generic promotion can't see) - never promote that fence generically,
 *  or the message ends up with a mis-typed "code" file and recovery bails
 *  out because `files` is already non-empty. */
const ARTIFACT_TAG_RE = /^<fachoy-artifact\s/i;

interface PushResult {
  prose: string;
  events: ArtifactStreamEvent[];
}

export function createFencedCodeArtifactParser() {
  let mode: Mode = "prose";
  let pending = "";
  let fenceLang = "";
  let promotedId = "";
  let counter = 0;
  /**
   * True when part of the current line has already been emitted as prose.
   *
   * Once that has happened the rest of that line cannot be a fence marker, so
   * it must not be re-tested as one - otherwise "Hello" followed by a delta of
   * three backticks would be read as an opening fence when the real line is
   * "Hello" followed by them mid-sentence.
   */
  let midLine = false;

  /** Splits complete (newline-terminated) lines off the front of `pending`; the rest stays buffered. */
  function takeLines(finalFlush: boolean): string[] {
    const lines: string[] = [];
    for (;;) {
      const idx = pending.indexOf("\n");
      if (idx === -1) {
        if (finalFlush && pending) {
          lines.push(pending);
          pending = "";
        }
        return lines;
      }
      lines.push(pending.slice(0, idx + 1));
      pending = pending.slice(idx + 1);
    }
  }

  function run(finalFlush: boolean): PushResult {
    let prose = "";
    const events: ArtifactStreamEvent[] = [];
    const lines = takeLines(finalFlush);

    for (const line of lines) {
      const bare = line.endsWith("\n") ? line.slice(0, -1) : line;
      // The tail of a line whose start already went out as prose. It cannot be
      // a marker, whatever it looks like.
      const continuation = midLine;
      if (line.endsWith("\n") || finalFlush) midLine = false;

      if (mode === "prose") {
        const m = continuation ? null : FENCE_OPEN_RE.exec(bare);
        if (m) {
          mode = "fenceBuffering";
          fenceLang = m[1] ?? "";
        } else {
          prose += line;
        }
        continue;
      }

      if (mode === "fenceBuffering") {
        if (FENCE_CLOSE_RE.test(bare)) {
          // Empty fence — nothing to promote; replay it exactly as written.
          prose += "```" + fenceLang + "\n```\n";
          mode = "prose";
          continue;
        }
        if (ARTIFACT_TAG_RE.test(bare)) {
          // Leave the whole thing as literal prose for recoverFencedArtifactMessage.
          prose += "```" + fenceLang + "\n" + line;
          mode = "fenceLiteral";
          continue;
        }
        if (NON_FILE_LANGS.has(fenceLang.toLowerCase())) {
          // Already has a dedicated live renderer in Markdown.tsx — never
          // promote into a generic file artifact; replay as literal prose
          // so it reaches Markdown.tsx unchanged.
          prose += "```" + fenceLang + "\n" + line;
          mode = "fenceLiteral";
          continue;
        }
        // First line of real content — promote immediately rather than
        // buffering further: every non-empty fence becomes a file artifact,
        // except the NON_FILE_LANGS carve-out above.
        counter += 1;
        const { type, language, ext } = classify(fenceLang, line);
        promotedId = `fallback-${counter}`;
        const title = `generated-${counter}.${ext}`;
        events.push({ kind: "start", id: promotedId, type, language, title });
        events.push({ kind: "chunk", id: promotedId, value: line });
        mode = "fencePromoted";
        continue;
      }

      if (mode === "fenceLiteral") {
        prose += line;
        if (!continuation && FENCE_CLOSE_RE.test(bare)) mode = "prose";
        continue;
      }

      // mode === "fencePromoted"
      if (FENCE_CLOSE_RE.test(bare)) {
        events.push({ kind: "end", id: promotedId });
        mode = "prose";
        promotedId = "";
        continue;
      }
      events.push({ kind: "chunk", id: promotedId, value: line });
    }

    // Release the trailing partial line when it cannot still become a marker.
    //
    // Without this, nothing reaches the chat until a newline arrives - and a
    // model answering in prose emits none until the paragraph ends, so a
    // one-paragraph answer appeared all at once when the turn finished rather
    // than streaming token by token. Both fence regexes are anchored at a line
    // start with no leading whitespace, so a partial line can only grow into a
    // marker if it begins a line AND is either a prefix of the fence or
    // already starts with it. Anything else is ordinary prose and can go now.
    //
    // Only in the two modes whose output IS chat text. fenceBuffering and
    // fencePromoted emit artifact events keyed on whole lines, and holding a
    // partial line back there is correct.
    if (!finalFlush && pending && (mode === "prose" || mode === "fenceLiteral")) {
      if (midLine || !couldStartMarker(pending)) {
        prose += pending;
        pending = "";
        midLine = true;
      }
    }

    return { prose, events };
  }

  /** Whether a partial line at a line start could still become a fence marker. */
  function couldStartMarker(partial: string): boolean {
    return FENCE.startsWith(partial) || partial.startsWith(FENCE);
  }

  return {
    push(delta: string): PushResult {
      pending += delta;
      return run(false);
    },
    /** Call once after the stream ends — flushes any incomplete trailing fence. */
    flush(): PushResult {
      const { prose: linedProse, events } = run(true);
      let prose = linedProse;
      if (mode === "fencePromoted") {
        events.push({ kind: "end", id: promotedId, truncated: true });
      } else if (mode === "fenceBuffering") {
        // The stream ended right after the fence opened, with no content line
        // yet — nothing was promoted; show the bare opening as-is.
        prose += "```" + fenceLang + "\n";
      }
      mode = "prose";
      promotedId = "";
      midLine = false;
      return { prose, events };
    },
  };
}

/**
 * Non-streaming counterpart to createFencedCodeArtifactParser(), for
 * one-shot migration of already-stored message content (see
 * messageMigrations.ts) — drives the exact same push/flush state machine in
 * one shot, so promotion and classify() never diverge between the
 * live-streaming path and the migration path.
 */
export function extractFencedArtifactsFromText(
  text: string
): { prose: string; artifacts: GeneratedArtifact[] } {
  const parser = createFencedCodeArtifactParser();
  const pushed = parser.push(text);
  const flushed = parser.flush();
  const events = [...pushed.events, ...flushed.events];
  const files = events.reduce(reduceArtifactEvent, [] as GeneratedArtifact[]);
  // Namespace ids so a migration pass can never collide with a real
  // <fachoy-artifact>-tag id already on the message.
  const artifacts = files.map((f, i) => ({ ...f, id: `migrated-fence-${i + 1}-${f.id}` }));
  return { prose: pushed.prose + flushed.prose, artifacts };
}
