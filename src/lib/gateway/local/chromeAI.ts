import type { ProviderPluginModel } from "../../types";
import type { AdapterChatArgs, AdapterCompleteArgs, ChatMessageInput } from "../types";
import { GatewayError } from "../types";
import type { LocalRuntime } from "./runtime";

/**
 * Chrome's built-in Prompt API (Gemini Nano).
 *
 * The cheapest local model there is: the weights ship with the browser, so
 * there is nothing to download from us, no key, and no quota. Small and
 * text-only, but instant, which makes it a good default fallback when the
 * hosted keyless providers are rate-limiting.
 */

/** Minimal shape of the global the Prompt API exposes; it is not in lib.dom yet. */
interface LanguageModelSession {
  promptStreaming(input: string): ReadableStream<string>;
  prompt(input: string): Promise<string>;
  destroy(): void;
}

interface LanguageModelStatic {
  availability(): Promise<"unavailable" | "downloadable" | "downloading" | "available">;
  create(options?: {
    initialPrompts?: { role: "system" | "user" | "assistant"; content: string }[];
    monitor?: (m: { addEventListener(type: "downloadprogress", cb: (e: { loaded: number }) => void): void }) => void;
  }): Promise<LanguageModelSession>;
}

function api(): LanguageModelStatic | null {
  const g = globalThis as unknown as { LanguageModel?: LanguageModelStatic };
  return g.LanguageModel ?? null;
}

const MODEL_ID = "gemini-nano";

/**
 * The Prompt API takes a single prompt string plus system context, not a
 * message array, so the transcript is flattened.
 */
function split(messages: ChatMessageInput[]): { system: string; prompt: string } {
  const text = (m: ChatMessageInput) =>
    typeof m.content === "string"
      ? m.content
      : m.content.map((p) => (p.type === "text" ? p.text : "")).join("\n");

  const system = messages.filter((m) => m.role === "system").map(text).join("\n\n");
  const rest = messages.filter((m) => m.role === "user" || m.role === "assistant");

  // Keep the turn structure legible to the model when there is more than one turn.
  const prompt =
    rest.length <= 1
      ? text(rest[0] ?? { role: "user", content: "" })
      : rest.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${text(m)}`).join("\n\n") +
        "\n\nAssistant:";

  return { system, prompt };
}

async function session(messages: ChatMessageInput[]): Promise<{ s: LanguageModelSession; prompt: string }> {
  const LanguageModel = api();
  if (!LanguageModel) {
    throw new GatewayError(
      0,
      "This browser has no built-in AI. Chrome 138+ with the built-in model enabled is required."
    );
  }
  const state = await LanguageModel.availability();
  if (state === "unavailable") {
    throw new GatewayError(0, "Chrome's built-in model is unavailable on this device.");
  }

  const { system, prompt } = split(messages);
  const s = await LanguageModel.create(
    system ? { initialPrompts: [{ role: "system", content: system }] } : undefined
  );
  return { s, prompt };
}

export const chromeAIRuntime: LocalRuntime = {
  id: "chrome-ai",
  label: "Chrome built-in AI",

  available() {
    return api() !== null;
  },

  unavailableReason() {
    return "Needs Chrome 138+ with the built-in Gemini Nano model available.";
  },

  async listModels(): Promise<ProviderPluginModel[]> {
    const LanguageModel = api();
    if (!LanguageModel) return [];
    const state = await LanguageModel.availability();
    if (state === "unavailable") return [];
    return [
      {
        id: MODEL_ID,
        name: "Gemini Nano (built into Chrome)",
        contextLength: 6144,
        freeAccess: true,
        toolCalling: false,
        supportsVision: false,
      },
    ];
  },

  async streamChat(args: AdapterChatArgs): Promise<void> {
    const { s, prompt } = await session(args.messages);
    try {
      const reader = s.promptStreaming(prompt).getReader();
      for (;;) {
        if (args.signal?.aborted) break;
        const { done, value } = await reader.read();
        if (done) break;
        if (value) args.onDelta(value);
      }
    } finally {
      s.destroy();
    }
  },

  async completeChat(args: AdapterCompleteArgs): Promise<string> {
    const { s, prompt } = await session(args.messages);
    try {
      return await s.prompt(prompt);
    } finally {
      s.destroy();
    }
  },

  async unload(): Promise<void> {
    /* sessions are per-call and destroyed in their own finally blocks */
  },
};
