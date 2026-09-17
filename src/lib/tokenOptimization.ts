import type { ChatMessage, Conversation } from "./types";
import { runCompletion } from "./onniroute";

// ---------------------------------------------------------------- constants

/** Messages kept verbatim at the tail of every request, unchanged. */
export const RECENT_WINDOW = 10;
/** Older messages (beyond the recent window) eligible for relevance retrieval. */
export const MIDDLE_TIER_LIMIT = 30;
/** How many middle-tier turns get pulled back in on any given request. */
export const MIDDLE_TIER_RETRIEVE = 8;
/** Defensive ceiling on the rolling old-tier summary text itself. */
export const OLD_TIER_SUMMARY_MAX_CHARS = 6000;

/** Only trim an attached document's text once it exceeds this many characters. */
export const DOC_TEXT_BUDGET_CHARS = 8000;
/** Per-excerpt budget for web search context (matches the previous naive clip length). */
export const SEARCH_EXCERPT_BUDGET_CHARS = 1200;
/** Generous safety cap on completion length — a backstop, not a content limiter. */
export const OUTPUT_MAX_TOKENS = 2048;

export const CONCISE_DIRECTIVE =
  "Be concise: answer directly, avoid unnecessary preamble, filler, or repetition, " +
  "and don't restate the question. Still include all information needed for a complete, " +
  "accurate answer — don't omit relevant detail for the sake of brevity alone.";

export const RETRIEVED_CONTEXT_START =
  "[Earlier relevant context — some messages omitted for brevity]";
export const RETRIEVED_CONTEXT_END = "[...conversation continues below]";

// ------------------------------------------------------------ history tiers

/**
 * Groups messages so an assistant tool-call message and the tool response(s)
 * that answer it are always kept/dropped together. Splitting them apart
 * would break the wire format (a `tool` message's `tool_call_id` would
 * reference a call that's no longer in the payload).
 */
function groupIntoTurns(messages: ChatMessage[]): ChatMessage[][] {
  const turns: ChatMessage[][] = [];
  let awaitingToolResponses = 0;
  for (const m of messages) {
    if (m.role === "tool" && awaitingToolResponses > 0) {
      turns[turns.length - 1].push(m);
      awaitingToolResponses--;
      continue;
    }
    turns.push([m]);
    awaitingToolResponses = m.role === "assistant" ? m.toolCalls?.length ?? 0 : 0;
  }
  return turns;
}

export interface HistoryTiers {
  /** Last RECENT_WINDOW-ish messages (rounded up to whole turns), verbatim. */
  recent: ChatMessage[];
  /** Older, not-yet-summarized messages eligible for relevance retrieval. */
  middleCandidates: ChatMessage[];
}

/**
 * Splits a conversation's live messages into a verbatim recent tail and an
 * older "middle" pool eligible for relevance retrieval. Messages at/before
 * `oldTierSummarizedThrough` have already been folded into the rolling
 * summary and are excluded entirely (the summary stands in for them).
 */
export function partitionHistory(
  messages: ChatMessage[],
  oldTierSummarizedThrough: number | undefined
): HistoryTiers {
  const cutoff = oldTierSummarizedThrough ?? 0;
  const eligible = messages.slice(cutoff);
  const turns = groupIntoTurns(eligible);

  let count = 0;
  let splitIdx = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    splitIdx = i;
    count += turns[i].length;
    if (count >= RECENT_WINDOW) break;
  }

  return {
    recent: turns.slice(splitIdx).flat(),
    middleCandidates: turns.slice(0, splitIdx).flat(),
  };
}

/**
 * Cheap heuristic relevance ranking (no embeddings) over turn-grouped older
 * messages — same approach as `selectRelevantMemories`, adapted so a
 * tool-call/tool-response pair is always scored and selected as one unit.
 * Returns candidates unchanged if there aren't more than `limit` turns.
 * Result is re-sorted back into chronological order (unlike memories, these
 * are real conversation turns — out-of-order would imply false causality).
 */
export function selectRelevantMessages(
  candidates: ChatMessage[],
  currentQueryText: string,
  limit = MIDDLE_TIER_RETRIEVE
): ChatMessage[] {
  if (candidates.length === 0) return [];
  const turns = groupIntoTurns(candidates);
  if (turns.length <= limit) return candidates;

  const tokenize = (s: string) =>
    new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
  const queryTokens = tokenize(currentQueryText);
  const scored = turns.map((turn, i) => {
    const text = turn.map((m) => m.content).join(" ");
    const overlap = [...tokenize(text)].filter((t) => queryTokens.has(t)).length;
    const recencyBoost = Math.max(0, 1 - (turns.length - 1 - i) / turns.length) * 0.5;
    return { turn, i, score: overlap + recencyBoost };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored
    .slice(0, limit)
    .sort((a, b) => a.i - b.i)
    .flatMap((s) => s.turn);
}

/** True once enough messages have piled up beyond the recent+middle tiers to warrant folding some into the summary. */
export function needsSummaryUpdate(convo: Conversation): boolean {
  const through = convo.oldTierSummarizedThrough ?? 0;
  return convo.messages.length - RECENT_WINDOW - through >= MIDDLE_TIER_LIMIT;
}

const SUMMARY_SYSTEM_PROMPT =
  "You maintain a compact rolling summary of an ongoing conversation's older history. " +
  "You will be given the CURRENT summary (may be empty) and a batch of NEW messages that " +
  "occurred after it. Produce an updated summary that preserves every distinctive fact, " +
  "decision, name, number, and commitment from both, in as few words as possible. Do not " +
  "lose specific details in favor of vague generalities. Output only the updated summary text.";

/**
 * Incrementally folds the batch of messages that just aged out of the middle
 * tier into the existing old-tier summary (never re-summarizes from
 * scratch). Fire-and-forget by the caller, same shape as `extractMemory`.
 */
export async function updateOldTierSummary(
  convo: Conversation
): Promise<{ summary: string; summarizedThrough: number }> {
  const through = convo.oldTierSummarizedThrough ?? 0;
  const newThrough = Math.max(through, convo.messages.length - RECENT_WINDOW - MIDDLE_TIER_LIMIT);
  const batch = convo.messages.slice(through, newThrough);
  if (batch.length === 0) {
    return { summary: convo.oldTierSummary ?? "", summarizedThrough: through };
  }
  const batchText = batch
    .map((m) => `${m.role === "user" ? "User" : m.role === "assistant" ? "Assistant" : m.role}: ${m.content.slice(0, 4000)}`)
    .join("\n");
  const text = await runCompletion({
    model: "auto",
    maxTokens: 384,
    messages: [
      { role: "system", content: SUMMARY_SYSTEM_PROMPT },
      {
        role: "user",
        content: `Current summary:\n${convo.oldTierSummary || "(none yet)"}\n\nNew messages:\n${batchText}`,
      },
    ],
  });
  return { summary: text.trim().slice(0, OLD_TIER_SUMMARY_MAX_CHARS), summarizedThrough: newThrough };
}

// ---------------------------------------------------- query-aware trimming

/** Split text into paragraphs (blank-line breaks); falls back to sentence
 *  splitting (Latin + CJK punctuation) only when there's no paragraph
 *  structure to work with, so the heuristic degrades gracefully for
 *  languages without either cue rather than garbling text mid-word. */
function chunkText(text: string): string[] {
  let chunks = text
    .split(/\n\s*\n/)
    .map((c) => c.trim())
    .filter(Boolean);
  if (chunks.length <= 1) {
    const sentences = text
      .split(/(?<=[.!?。！？])\s+/)
      .map((c) => c.trim())
      .filter(Boolean);
    if (sentences.length > 1) chunks = sentences;
  }
  return chunks.length > 0 ? chunks : [text];
}

/**
 * Query-aware trimming for large text blocks (attached documents, search
 * excerpts): no-ops under budget, otherwise scores paragraphs/sentences by
 * word overlap with the current query, always keeps the opening chunk for
 * title/intro context, and restores original document order before joining.
 */
export function selectRelevantExcerpt(
  fullText: string,
  queryText: string,
  budgetChars: number
): string {
  const trimmed = fullText.trim();
  if (trimmed.length <= budgetChars) return trimmed;

  const chunks = chunkText(trimmed);
  if (chunks.length <= 1) {
    return trimmed.slice(0, budgetChars).trimEnd() + "\n\n[...content trimmed for brevity...]";
  }

  const tokenize = (s: string) =>
    new Set(s.toLowerCase().split(/[^a-z0-9À-￿]+/).filter((w) => w.length > 2));
  const queryTokens = tokenize(queryText);
  const scored = chunks.map((c, i) => ({
    c,
    i,
    score: [...tokenize(c)].filter((t) => queryTokens.has(t)).length,
  }));
  scored[0].score += 1000; // always keep the opening chunk

  const ordered = [...scored].sort((a, b) => b.score - a.score);
  const kept: { c: string; i: number }[] = [];
  let used = 0;
  for (const s of ordered) {
    if (used + s.c.length > budgetChars && kept.length > 0) continue;
    kept.push(s);
    used += s.c.length;
    if (used >= budgetChars) break;
  }
  kept.sort((a, b) => a.i - b.i);
  const trimmedMarker = kept.length < chunks.length ? "\n\n[...content trimmed for brevity...]" : "";
  return kept.map((k) => k.c).join("\n\n") + trimmedMarker;
}
