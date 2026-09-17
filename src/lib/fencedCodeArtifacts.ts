import type { ArtifactType, GeneratedArtifact } from "./types";
import { reduceArtifactEvent, type ArtifactStreamEvent } from "./artifacts";

/**
 * Fallback for models that ignore the <fachoy-artifact> tag contract
 * (artifacts.ts) and just dump a big file in an ordinary ``` fenced code
 * block instead — common on weaker/free models. Two problems that causes:
 * it never shows up as a viewable/downloadable file card, and
 * react-syntax-highlighter re-highlighting a multi-KB block on every single
 * streamed token (Markdown.tsx) makes the whole page grind to a halt.
 *
 * This runs as a second stage on the plain prose text the tag-based parser
 * already produced (artifacts.ts's `prose` output), operating line-by-line
 * since fences are inherently line-delimited. A short fenced block (under
 * PROMOTE_THRESHOLD chars of body) is left completely alone — it streams
 * through as normal prose exactly like today, unaffected. Only once a
 * still-open fence's body crosses the threshold does it get "promoted":
 * synthesized start/chunk/end events (same shape as artifacts.ts's, so they
 * feed the same reduceArtifactEvent/ArtifactBlock/ArtifactPanel UI), and the
 * raw text stops being appended to the visible message content at all —
 * nothing that big ever reaches the markdown/syntax-highlighter pipeline.
 */

const FENCE_OPEN_RE = /^```(\S*)[ \t]*$/;
const FENCE_CLOSE_RE = /^```[ \t]*$/;
const PROMOTE_THRESHOLD = 600;

const LANG_TO_TYPE: Record<string, { type: ArtifactType; ext: string }> = {
  html: { type: "html", ext: "html" },
  htm: { type: "html", ext: "html" },
  svg: { type: "svg", ext: "svg" },
  markdown: { type: "markdown", ext: "md" },
  md: { type: "markdown", ext: "md" },
};

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

type Mode = "prose" | "fenceBuffering" | "fencePromoted";

interface PushResult {
  prose: string;
  events: ArtifactStreamEvent[];
}

export function createFencedCodeArtifactParser() {
  let mode: Mode = "prose";
  let pending = "";
  let fenceLang = "";
  let fenceBody = "";
  let promotedId = "";
  let counter = 0;

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

      if (mode === "prose") {
        const m = FENCE_OPEN_RE.exec(bare);
        if (m) {
          mode = "fenceBuffering";
          fenceLang = m[1] ?? "";
          fenceBody = "";
        } else {
          prose += line;
        }
        continue;
      }

      if (mode === "fenceBuffering") {
        if (FENCE_CLOSE_RE.test(bare)) {
          // Small fence — replay it exactly as written, unchanged, as normal prose.
          prose += "```" + fenceLang + "\n" + fenceBody + "```\n";
          mode = "prose";
          fenceBody = "";
          continue;
        }
        fenceBody += line;
        if (fenceBody.length > PROMOTE_THRESHOLD) {
          counter += 1;
          const { type, language, ext } = classify(fenceLang, fenceBody);
          promotedId = `fallback-${counter}`;
          const title = `generated-${counter}.${ext}`;
          events.push({ kind: "start", id: promotedId, type, language, title });
          events.push({ kind: "chunk", id: promotedId, value: fenceBody });
          mode = "fencePromoted";
          fenceBody = "";
        }
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

    return { prose, events };
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
        // Never closed and never crossed the threshold — show it as-is, same as today.
        prose += "```" + fenceLang + "\n" + fenceBody;
      }
      mode = "prose";
      fenceBody = "";
      promotedId = "";
      return { prose, events };
    },
  };
}

/**
 * Non-streaming counterpart to createFencedCodeArtifactParser(), for
 * one-shot migration of already-stored message content (see
 * messageMigrations.ts) — drives the exact same push/flush state machine in
 * one shot, so PROMOTE_THRESHOLD and classify() never diverge between the
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
