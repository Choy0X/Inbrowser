/**
 * Handling for open-weight models that narrate chain-of-thought as plain
 * prose directly in `content` — no `reasoning_content` field (openaiChunks.ts)
 * and no `<think>` tag (thinkTags.ts). Observed live on Uncloseai's
 * Lorbus/Qwen3.6-27B-int4-AutoRound: the stream opens with "Here's a
 * thinking process:" followed by a numbered walkthrough, then a double
 * blank line, then the real answer — all as ordinary content text.
 *
 * Splitting narrative CoT from a real answer has no fully reliable
 * structural signal (thinkTags.ts's own comment calls this out) — a
 * legitimate multi-paragraph answer can look similar. This only acts when
 * BOTH signals line up: the response opens with one of a small set of
 * known reasoning lead-in phrases, AND a double-blank-line gap shows up
 * later to mark the handoff to the real answer. That conjunction is rare
 * enough in genuine answers to keep false positives low. If the lead-in
 * doesn't match, or the gap never arrives, everything is treated as normal
 * content — same as before this existed.
 */

const LEADIN_PATTERNS: RegExp[] = [
  /^okay,?\s+(so,?\s+)?(the user|let'?s)/i,
  /^so,?\s+the user/i,
  /^the user (said|is asking|wants|just said|is saying|says)/i,
  /^here'?s?\s+(a|my|the)\s+(thinking|reasoning)(\s+process)?\s*[:.]/i,
  /^let'?s\s+(think|break|analyze|work through)/i,
  /^let me\s+(think|analyze|work through|break|figure)/i,
  /^first,?\s+i need to/i,
  /^i need to\s+(figure out|determine|think|understand|analyze|consider)/i,
  /^my\s+(thinking|reasoning)\s*[:.]/i,
  /^(thinking|reasoning)\s*[:.]/i,
];

/** Probe buffer size before giving up on matching a lead-in phrase. */
const MAX_LEADIN_PROBE = 96;

/** Two or more blank lines — the handoff point from narrated reasoning to the real answer. */
const BLANK_GAP_RE = /\n[ \t]*\n[ \t]*\n[ \t\n]*/;

function looksLikeReasoningLeadIn(buffer: string): boolean {
  const trimmed = buffer.trimStart();
  return LEADIN_PATTERNS.some((p) => p.test(trimmed));
}

/** Non-streaming case: split off a narrated-reasoning prefix from a full string, if present. */
export function stripNarrativeReasoning(text: string): string {
  if (!looksLikeReasoningLeadIn(text)) return text;
  const m = BLANK_GAP_RE.exec(text);
  if (!m) return text;
  const rest = text.slice(m.index + m[0].length).trim();
  return rest || text;
}

export interface NarrativeReasoningSplitter {
  /** Feed the next content chunk (post think-tag resolution). Routes to onContent/onReasoning. */
  push(chunk: string): void;
  /** Call once at stream end — flushes whatever's left buffered. */
  flush(): void;
}

/** Streaming case: a stateful incremental splitter. Fresh state per call — create one per request/stream. */
export function createNarrativeReasoningSplitter(callbacks: {
  onContent: (text: string) => void;
  onReasoning: (text: string) => void;
}): NarrativeReasoningSplitter {
  let mode: "probing" | "reasoning" | "passthrough" = "probing";
  let buffer = "";

  function safeReasoningPrefixLength(s: string): number {
    // Hold back a trailing run of blank-line whitespace — it might still grow
    // into the split gap with the next chunk.
    const m = /[\n \t]*$/.exec(s);
    return s.length - (m ? m[0].length : 0);
  }

  function drainReasoning(): void {
    for (;;) {
      const m = BLANK_GAP_RE.exec(buffer);
      if (m) {
        const end = m.index + m[0].length;
        if (end >= buffer.length) return; // gap not confirmed complete yet — wait for more
        if (m.index > 0) callbacks.onReasoning(buffer.slice(0, m.index));
        const rest = buffer.slice(end);
        mode = "passthrough";
        buffer = "";
        if (rest) callbacks.onContent(rest);
        return;
      }
      const safeLen = safeReasoningPrefixLength(buffer);
      if (safeLen > 0) {
        callbacks.onReasoning(buffer.slice(0, safeLen));
        buffer = buffer.slice(safeLen);
      }
      return;
    }
  }

  return {
    push(chunk: string) {
      if (!chunk) return;
      if (mode === "passthrough") {
        callbacks.onContent(chunk);
        return;
      }
      buffer += chunk;
      if (mode === "probing") {
        if (looksLikeReasoningLeadIn(buffer)) {
          mode = "reasoning";
        } else if (buffer.length >= MAX_LEADIN_PROBE || buffer.includes("\n")) {
          mode = "passthrough";
          callbacks.onContent(buffer);
          buffer = "";
          return;
        } else {
          return; // need more data to decide
        }
      }
      if (mode === "reasoning") drainReasoning();
    },
    flush() {
      if (!buffer) return;
      // Never found the split gap (or never confirmed a lead-in) — surface
      // whatever's left as normal content rather than hiding it as
      // "reasoning" with no visible answer.
      callbacks.onContent(buffer);
      buffer = "";
    },
  };
}
