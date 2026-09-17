import type { ChatMessageInput } from "../types";

/**
 * Reshaping a conversation for WebLLM's message rules.
 *
 * WebLLM validates the request before it reaches the model and enforces two
 * rules the hosted providers do not (`node_modules/@mlc-ai/web-llm`, in the
 * function that builds the conversation):
 *
 *   1. A `system` message is only allowed at index 0. Anything later throws
 *      SystemMessageOrderError.
 *   2. The last message must be `user` or `tool`, or it throws
 *      MessageOrderError.
 *
 * This app breaks the first rule on essentially every turn. `buildPayload` in
 * App.tsx pushes the default prompt, the artifact contract, custom
 * instructions, memories, the concise directive, search context, one block per
 * active skill and any conversation summary - each as its own system message -
 * and then brackets retrieved history with two more. So index 1 was already a
 * system message and every local request failed before generating a token.
 *
 * The reshaping is deliberately not "merge every system message":
 *
 *   - The *leading run* of system messages really is one system prompt split
 *     across several pushes, so it is joined into one.
 *   - A system message *inside* the history is positional - the retrieved
 *     context markers exist to delimit a region of the transcript. Hoisting
 *     those to the top would announce "retrieved context follows" above
 *     content that does not follow, so they stay where they are as user-role
 *     notes instead.
 *   - Tool results become user messages. WebLLM does accept a `tool` role, but
 *     only models whose chat template defines one render it usefully, and no
 *     local model here advertises tool calling. As a user message the result
 *     is visible to every template, and it also satisfies rule 2, which
 *     dropping the message outright would violate by leaving an assistant turn
 *     last.
 */

export interface PlainMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

function textOf(message: ChatMessageInput): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((part) => (part.type === "text" ? part.text : "[image omitted: this model is text-only]"))
    .join("\n");
}

export function toWebLLMMessages(messages: ChatMessageInput[]): PlainMessage[] {
  const plain = messages.map((m) => ({ role: m.role, content: textOf(m) }));

  // The leading run of system messages is the system prompt, however many
  // pushes assembled it.
  let lead = 0;
  while (lead < plain.length && plain[lead].role === "system") lead++;
  const systemText = plain
    .slice(0, lead)
    .map((m) => m.content.trim())
    .filter(Boolean)
    .join("\n\n");

  const out: PlainMessage[] = [];
  if (systemText) out.push({ role: "system", content: systemText });

  for (const message of plain.slice(lead)) {
    if (message.role === "assistant") {
      out.push({ role: "assistant", content: message.content });
    } else if (message.role === "tool") {
      // Kept, not dropped: it carries the result the next turn reasons about.
      out.push({ role: "user", content: `Tool result:\n${message.content}` });
    } else {
      // Both a real user turn and a mid-history system note land here, so the
      // note keeps its position instead of being hoisted out of context.
      out.push({ role: "user", content: message.content });
    }
  }

  // Rule 2. An assistant turn last means the caller wants a continuation,
  // which this runtime cannot express; asking for it directly is closer to the
  // intent than failing outright.
  const last = out[out.length - 1];
  if (!last || last.role !== "user") {
    out.push({ role: "user", content: "Continue." });
  }

  return out;
}

/**
 * The two rules, as a predicate.
 *
 * Exported so the checks assert what WebLLM actually enforces rather than
 * re-describing it, and so a future change to the reshaping cannot quietly
 * start producing a payload the runtime rejects.
 */
export function violatesWebLLMOrder(messages: PlainMessage[]): string | null {
  if (messages.length === 0) return "the payload is empty";
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "system" && i !== 0) return `system message at index ${i}`;
  }
  const last = messages[messages.length - 1];
  if (last.role !== "user") return `last message is ${last.role}`;
  return null;
}
