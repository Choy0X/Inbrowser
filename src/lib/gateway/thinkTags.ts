/**
 * Handling for the `<think>`/`<thinking>` inline chain-of-thought convention
 * many open-weight "reasoning" models use (DeepSeek-R1 distills, QwQ, ...)
 * when they have no separate `reasoning_content` channel — the model wraps
 * its chain-of-thought directly in the same content field as the real
 * answer instead. Two shapes are needed: a full string at once
 * (non-streaming) and an incremental token stream (streaming), where a tag
 * can arrive split across two chunks (e.g. "<th" then "ink>").
 *
 * Deliberately NOT handled: a model that narrates its reasoning as plain
 * prose with no tags at all. There's no reliable structural signal to tell
 * that apart from a real multi-step/numbered-list answer — any content
 * heuristic here would misfire on legitimate answers.
 */

const OPEN_TAGS = ["<think>", "<thinking>"];
const CLOSE_TAGS = ["</think>", "</thinking>"];

const STRIP_BLOCK_RE = /<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi;

/** Non-streaming case: remove every complete think block from a full string. */
export function stripThinkTags(text: string): string {
  return text.replace(STRIP_BLOCK_RE, "").trim();
}

/** Earliest case-insensitive occurrence of any of `tags` in `buffer`, or null. */
function findTagIndex(buffer: string, tags: string[]): { index: number; length: number } | null {
  const lower = buffer.toLowerCase();
  let best: { index: number; length: number } | null = null;
  for (const tag of tags) {
    const idx = lower.indexOf(tag);
    if (idx !== -1 && (best === null || idx < best.index)) best = { index: idx, length: tag.length };
  }
  return best;
}

/** Longest suffix of `buffer` that could still grow into one of `tags` with
 *  more incoming text — must be held back rather than flushed, since flushing
 *  it now would permanently split a tag across the emitted content/reasoning
 *  streams if the rest arrives in the next chunk. */
function partialTagSuffixLength(buffer: string, tags: string[]): number {
  const lower = buffer.toLowerCase();
  let maxLen = 0;
  for (const tag of tags) {
    const maxCheck = Math.min(lower.length, tag.length - 1);
    for (let len = maxCheck; len > 0; len--) {
      if (tag.startsWith(lower.slice(lower.length - len))) {
        if (len > maxLen) maxLen = len;
        break;
      }
    }
  }
  return maxLen;
}

export interface ThinkTagSplitter {
  /** Feed the next streamed content chunk. Routes to onContent/onReasoning as tags are resolved. */
  push(chunk: string): void;
  /** Call once at stream end — emits whatever's left buffered (an unterminated
   *  think block included) rather than silently dropping it. */
  flush(): void;
}

/** Streaming case: a stateful incremental splitter, since a tag can straddle
 *  two chunks. Fresh state per call — create one per request/stream. */
export function createThinkTagSplitter(callbacks: {
  onContent: (text: string) => void;
  onReasoning: (text: string) => void;
}): ThinkTagSplitter {
  let buffer = "";
  let inThink = false;

  function drain(): void {
    for (;;) {
      const tags = inThink ? CLOSE_TAGS : OPEN_TAGS;
      const emit = inThink ? callbacks.onReasoning : callbacks.onContent;
      const found = findTagIndex(buffer, tags);
      if (found) {
        if (found.index > 0) emit(buffer.slice(0, found.index));
        buffer = buffer.slice(found.index + found.length);
        inThink = !inThink;
        continue;
      }
      const holdBack = partialTagSuffixLength(buffer, tags);
      const safeLen = buffer.length - holdBack;
      if (safeLen > 0) {
        emit(buffer.slice(0, safeLen));
        buffer = buffer.slice(safeLen);
      }
      return;
    }
  }

  return {
    push(chunk: string) {
      if (!chunk) return;
      buffer += chunk;
      drain();
    },
    flush() {
      if (!buffer) return;
      (inThink ? callbacks.onReasoning : callbacks.onContent)(buffer);
      buffer = "";
    },
  };
}
