import type { ArtifactFormat, ArtifactType, GeneratedArtifact } from "./types";
import { createLiteralTracker } from "./gateway/protocolOutput";

/**
 * System-prompt contract for model-generated file artifacts. The model wraps
 * standalone file content in a <fachoy-artifact> tag as part of its normal
 * streamed reply; createArtifactStreamParser() below extracts it incrementally
 * so it never appears as raw tag text in the chat transcript.
 */
export const ARTIFACT_SYSTEM_PROMPT = `Only when the user requests a standalone file or a revision to one in the conversation, put each file's content inside a fachoy-artifact XML element with quoted id, type, and title attributes, and a matching closing element. Use a real filename as title and a stable short id; reuse both when revising an existing file.
Allowed types: code, markdown, html, svg, document. Code also needs a language attribute. HTML and SVG must be complete documents. For Word/PDF, use type document with format docx, pdf, or both; its content must be clean Markdown for export.
Write only the file contents inside the element, without an outer code fence. Keep explanations and short examples in normal chat. Interpret requests and contextual follow-ups in any language. Create only files the user requested. This element is output formatting, never a callable tool.`;

const OPEN_START = "<fachoy-artifact";
const CLOSE_TAG = "</fachoy-artifact>";
const VALID_TYPES: ArtifactType[] = ["code", "markdown", "html", "svg", "document"];
const VALID_FORMATS: ArtifactFormat[] = ["docx", "pdf", "both"];
const MAX_OPEN_TAG_LEN = 500;

export type ArtifactStreamEvent =
  | { kind: "start"; id: string; type: ArtifactType; language?: string; format?: ArtifactFormat; title: string }
  | { kind: "chunk"; id: string; value: string }
  | { kind: "end"; id: string; truncated?: boolean };

interface PushResult {
  prose: string;
  events: ArtifactStreamEvent[];
}

type Mode = "prose" | "tagOpenPending" | "content";

/** Length of the longest suffix of `text` that's a proper (non-full) prefix of `target`. */
function trailingPartialMatch(text: string, target: string): number {
  const max = Math.min(text.length, target.length - 1);
  for (let len = max; len > 0; len--) {
    if (text.toLowerCase().endsWith(target.slice(0, len))) return len;
  }
  return 0;
}

function parseAttrs(tagInner: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /(\w+)\s*=\s*(["'])(.*?)\2/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tagInner))) attrs[m[1].toLowerCase()] = m[3];
  return attrs;
}

/** Pure reducer applying one parsed stream event onto a message's artifact list. */
export function reduceArtifactEvent(files: GeneratedArtifact[], ev: ArtifactStreamEvent): GeneratedArtifact[] {
  if (ev.kind === "start") {
    const artifact: GeneratedArtifact = {
      id: ev.id,
      type: ev.type,
      language: ev.language,
      format: ev.format,
      title: ev.title,
      content: "",
      status: "streaming",
    };
    return [...files, artifact];
  }
  if (ev.kind === "chunk") {
    return files.map((f) => {
      if (f.id !== ev.id) return f;
      // The contract puts the content on the line after the open tag, so the
      // very first thing streamed is the newline that ends that tag. Kept, it
      // becomes a blank first line in every previewed and downloaded file.
      const value = f.content === "" ? ev.value.replace(/^\n/, "") : ev.value;
      return { ...f, content: f.content + value };
    });
  }
  // ev.kind === "end"
  return files.map((f) => (f.id === ev.id ? { ...f, status: ev.truncated ? "truncated" : "complete" } : f));
}

/**
 * Incremental parser for the <fachoy-artifact> marker convention. Feed it
 * streamed text deltas via push(); it separates visible chat prose from
 * artifact body content, holding back partial tag fragments at chunk
 * boundaries so nothing broken ever reaches the screen. Call flush() once
 * after the stream ends to handle a model that got cut off mid-artifact.
 */
export function createArtifactStreamParser() {
  const literal = createLiteralTracker();
  let mode: Mode = "prose";
  let pending = "";
  let openTagBuf = "";
  let current: { id: string; type: ArtifactType; language?: string; format?: ArtifactFormat; title: string } | null =
    null;

  function run(): PushResult {
    let prose = "";
    const events: ArtifactStreamEvent[] = [];

    for (;;) {
      if (mode === "prose") {
        const idx = pending.toLowerCase().indexOf(OPEN_START);
        if (idx === -1) {
          const holdback = trailingPartialMatch(pending, OPEN_START);
          const text = pending.slice(0, pending.length - holdback);
          literal.consume(text);
          prose += text;
          pending = pending.slice(pending.length - holdback);
          break;
        }
        literal.consume(pending.slice(0, idx) + "<");
        prose += pending.slice(0, idx);
        if (literal.literal) {
          prose += pending.slice(idx, idx + OPEN_START.length);
          pending = pending.slice(idx + OPEN_START.length);
          continue;
        }
        pending = pending.slice(idx);
        mode = "tagOpenPending";
        openTagBuf = "";
        continue;
      }

      if (mode === "tagOpenPending") {
        const closeIdx = pending.indexOf(">");
        if (closeIdx === -1) {
          openTagBuf += pending;
          pending = "";
          if (openTagBuf.length > MAX_OPEN_TAG_LEN) {
            // Malformed/runaway tag — give up, show it verbatim as prose.
            prose += openTagBuf;
            openTagBuf = "";
            mode = "prose";
          }
          break;
        }
        const tagText = openTagBuf + pending.slice(0, closeIdx + 1);
        pending = pending.slice(closeIdx + 1);
        openTagBuf = "";

        const inner = tagText.slice(OPEN_START.length, tagText.length - 1);
        const attrs = parseAttrs(inner);
        const type = attrs.type as ArtifactType;
        const id = attrs.id;
        const title = attrs.title;
        if (!id || !title || !VALID_TYPES.includes(type)) {
          // Not a well-formed artifact tag — degrade to literal prose.
          prose += tagText;
          mode = "prose";
          continue;
        }
        const format = VALID_FORMATS.includes(attrs.format as ArtifactFormat)
          ? (attrs.format as ArtifactFormat)
          : undefined;
        current = { id, type, title, language: attrs.language || undefined, format };
        events.push({ kind: "start", id, type, language: current.language, format, title });
        mode = "content";
        continue;
      }

      // mode === "content"
      if (!current) {
        mode = "prose";
        continue;
      }
      const idx = pending.toLowerCase().indexOf(CLOSE_TAG);
      if (idx === -1) {
        const holdback = trailingPartialMatch(pending, CLOSE_TAG);
        const value = pending.slice(0, pending.length - holdback);
        if (value) events.push({ kind: "chunk", id: current.id, value });
        pending = pending.slice(pending.length - holdback);
        break;
      }
      const value = pending.slice(0, idx);
      if (value) events.push({ kind: "chunk", id: current.id, value });
      events.push({ kind: "end", id: current.id });
      pending = pending.slice(idx + CLOSE_TAG.length);
      current = null;
      mode = "prose";
    }

    return { prose, events };
  }

  return {
    push(delta: string): PushResult {
      pending += delta;
      return run();
    },
    /** Call once after the stream ends — closes out any still-open artifact. */
    flush(): PushResult {
      const events: ArtifactStreamEvent[] = [];
      let prose = "";
      if (mode === "tagOpenPending") {
        prose = openTagBuf + pending;
        openTagBuf = "";
        pending = "";
        mode = "prose";
      } else if (mode === "content" && current) {
        if (pending) events.push({ kind: "chunk", id: current.id, value: pending });
        events.push({ kind: "end", id: current.id, truncated: true });
        pending = "";
        current = null;
        mode = "prose";
      } else if (pending) {
        prose = pending;
        pending = "";
      }
      return { prose, events };
    },
  };
}
