import type { CustomProxy, ProviderConnection, ProviderPluginModel } from "../types";

export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/** A function/tool the model may call during a chat completion. */
export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** Wire format of a function call inside an assistant message. */
export interface ToolCallWire {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessageInput = {
  role: "user" | "assistant" | "system" | "tool";
  content: string | ChatContentPart[];
  tool_calls?: ToolCallWire[];
  tool_call_id?: string;
};

export class GatewayError extends Error {
  status: number;
  /** True when the upstream response wasn't valid JSON (an auth/redirect/maintenance
   *  HTML page, typically) — a stronger failure signal than a normal API error, used
   *  by the auto-router to exclude the candidate immediately instead of gradually. */
  malformed: boolean;
  /** Milliseconds until the upstream says it'll accept requests again, parsed from
   *  a standard `Retry-After` response header on a 429/503 — undefined when the
   *  provider didn't send one. Never guessed; rate-limit windows vary too much
   *  between providers (and can change on their end) for this app to invent one. */
  retryAfterMs?: number;
  /** Stable machine-readable reason, when the relay's own JSON body carried one
   *  (see `server/src/app.ts`'s response `code` field) - undefined for errors
   *  that didn't come from the relay's structured shape. */
  code?: string;
  constructor(status: number, message: string, malformed = false, retryAfterMs?: number, code?: string) {
    super(message);
    this.name = "GatewayError";
    this.status = status;
    this.malformed = malformed;
    this.retryAfterMs = retryAfterMs;
    this.code = code;
  }
}

/** A connection paired with the bare (unprefixed) model id to call on it. */
export interface ResolvedTarget {
  connection: ProviderConnection;
  modelId: string;
}

export interface AdapterChatArgs {
  connection: ProviderConnection;
  modelId: string;
  messages: ChatMessageInput[];
  tools?: ToolDef[];
  toolChoice?: string;
  maxTokens?: number;
  signal?: AbortSignal;
  /** When set, route this attempt through the user's own proxy instead of fetching direct. */
  proxy?: CustomProxy;
  onDelta: (text: string) => void;
  onReasoning?: (text: string) => void;
  onToolCalls?: (calls: ToolCallWire[]) => void;
  onError?: (message: string) => void;
  onDone?: () => void;
}

export interface AdapterCompleteArgs {
  connection: ProviderConnection;
  modelId: string;
  messages: ChatMessageInput[];
  maxTokens?: number;
  signal?: AbortSignal;
  /** When set, route this attempt through the user's own proxy instead of fetching direct. */
  proxy?: CustomProxy;
}

export interface AdapterTestResult {
  reply: string;
  latencyMs: number;
}

/** The interface every chat-format adapter (openai/anthropic/gemini) implements. */
export interface ChatAdapter {
  streamChat(args: AdapterChatArgs): Promise<{ toolCalls: ToolCallWire[] }>;
  completeChat(args: AdapterCompleteArgs): Promise<string>;
  /** `modelId`, when given, overrides the adapter's own default pick (normally
   *  `connection.models[0]?.id`) - used by testProviderConnection (onniroute.ts)
   *  to retry a different candidate when one is payment-gated. */
  testConnection(connection: ProviderConnection, proxy?: CustomProxy, modelId?: string): Promise<AdapterTestResult>;
  /** Fetches the provider's own current model catalog (real auto-discovery, not a bundled list). */
  listModels(connection: ProviderConnection, proxy?: CustomProxy): Promise<ProviderPluginModel[]>;
}
