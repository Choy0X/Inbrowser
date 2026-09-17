import type { CustomProxy, ProviderConnection, ProviderPluginModel } from "../../types";
import type {
  AdapterChatArgs,
  AdapterCompleteArgs,
  AdapterTestResult,
  ChatAdapter,
  ChatContentPart,
  ChatMessageInput,
  ToolCallWire,
  ToolDef,
} from "../types";
import { GatewayError } from "../types";
import { iterateSSEEvents, parseSSEBlock, providerFetch } from "../providerFetch";
import { extractError, parseErrorMessage, stripLeakedSpecialTokens } from "../util";

const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 4096;

function endpoint(connection: ProviderConnection, path: string): string {
  return `${connection.baseUrl.trim().replace(/\/+$/, "")}${path}`;
}

function authHeaders(connection: ProviderConnection): HeadersInit {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "anthropic-version": ANTHROPIC_VERSION,
  };
  if (connection.apiKey) headers["x-api-key"] = connection.apiKey;
  return headers;
}

function imagePartToBlock(url: string): Record<string, unknown> {
  const dataMatch = /^data:([^;]+);base64,(.+)$/.exec(url);
  if (dataMatch) {
    return { type: "image", source: { type: "base64", media_type: dataMatch[1], data: dataMatch[2] } };
  }
  return { type: "image", source: { type: "url", url } };
}

function contentToBlocks(content: string | ChatContentPart[]): Record<string, unknown>[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  return content.map((part) =>
    part.type === "image_url" ? imagePartToBlock(part.image_url.url) : { type: "text", text: part.text }
  );
}

/** Translate the internal OpenAI-shaped message list into Anthropic's request shape. */
function toAnthropicRequest(messages: ChatMessageInput[]): {
  system?: string;
  messages: Record<string, unknown>[];
} {
  const systemParts: string[] = [];
  const out: Record<string, unknown>[] = [];
  for (const msg of messages) {
    if (msg.role === "system") {
      if (typeof msg.content === "string" && msg.content) systemParts.push(msg.content);
      continue;
    }
    if (msg.role === "tool") {
      out.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: msg.tool_call_id,
            content: typeof msg.content === "string" ? msg.content : contentToBlocks(msg.content),
          },
        ],
      });
      continue;
    }
    if (msg.role === "assistant") {
      const blocks = contentToBlocks(msg.content);
      for (const tc of msg.tool_calls ?? []) {
        let input: unknown = {};
        try {
          input = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
        } catch {
          input = {};
        }
        blocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
      }
      out.push({ role: "assistant", content: blocks });
      continue;
    }
    out.push({ role: "user", content: contentToBlocks(msg.content) });
  }
  return { system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined, messages: out };
}

function toAnthropicTools(tools?: ToolDef[]): Record<string, unknown>[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));
}

function toAnthropicToolChoice(toolChoice?: string): Record<string, unknown> | undefined {
  if (!toolChoice || toolChoice === "auto") return { type: "auto" };
  if (toolChoice === "required") return { type: "any" };
  if (toolChoice === "none") return undefined;
  return { type: "tool", name: toolChoice };
}

function buildBody(args: {
  modelId: string;
  messages: ChatMessageInput[];
  tools?: ToolDef[];
  toolChoice?: string;
  maxTokens?: number;
  stream: boolean;
}): Record<string, unknown> {
  const { system, messages } = toAnthropicRequest(args.messages);
  const body: Record<string, unknown> = {
    model: args.modelId,
    messages,
    max_tokens: args.maxTokens ?? DEFAULT_MAX_TOKENS,
    stream: args.stream,
  };
  if (system) body.system = system;
  const tools = toAnthropicTools(args.tools);
  if (tools) {
    body.tools = tools;
    const choice = toAnthropicToolChoice(args.toolChoice);
    if (choice) body.tool_choice = choice;
  }
  return body;
}

async function streamChat(args: AdapterChatArgs): Promise<{ toolCalls: ToolCallWire[] }> {
  const res = await providerFetch(endpoint(args.connection, "/messages"), {
    method: "POST",
    headers: authHeaders(args.connection),
    body: JSON.stringify(
      buildBody({
        modelId: args.modelId,
        messages: args.messages,
        tools: args.tools,
        toolChoice: args.toolChoice,
        maxTokens: args.maxTokens,
        stream: true,
      })
    ),
    signal: args.signal,
  }, args.proxy);

  const contentType = res.headers.get("content-type") || "";
  if (!res.ok || !contentType.includes("text/event-stream")) {
    const raw = await res.text().catch(() => "");
    const { message, malformed } = parseErrorMessage(raw, res.status);
    throw new GatewayError(res.status, message, malformed);
  }

  let sawContent = false;
  let sawError = false;
  let sawDone = false;
  // Anthropic streams tool_use blocks as: content_block_start (id, name) then
  // content_block_delta input_json_delta chunks (partial JSON, string form).
  const blockKinds = new Map<number, "text" | "thinking" | "tool_use">();
  const accumulatingToolCalls = new Map<number, { id: string; name: string; arguments: string }>();

  const handleEvent = (eventType: string | undefined, payload: string) => {
    if (!payload) return;
    let json: unknown;
    try {
      json = JSON.parse(payload);
    } catch {
      return;
    }
    const obj = json as Record<string, unknown>;
    const type = eventType || (obj.type as string | undefined);
    if (type === "error") {
      sawError = true;
      args.onError?.(extractError(obj) || "Provider returned an error");
      return;
    }
    if (type === "content_block_start") {
      const index = obj.index as number;
      const block = obj.content_block as Record<string, unknown> | undefined;
      const kind = (block?.type as string | undefined) ?? "text";
      blockKinds.set(index, kind === "tool_use" ? "tool_use" : kind === "thinking" ? "thinking" : "text");
      if (kind === "tool_use") {
        accumulatingToolCalls.set(index, {
          id: (block?.id as string) ?? "",
          name: (block?.name as string) ?? "",
          arguments: "",
        });
      }
      return;
    }
    if (type === "content_block_delta") {
      const index = obj.index as number;
      const delta = obj.delta as Record<string, unknown> | undefined;
      const kind = blockKinds.get(index) ?? "text";
      if (kind === "thinking" && typeof delta?.thinking === "string") {
        sawContent = true;
        args.onReasoning?.(delta.thinking);
      } else if (kind === "tool_use" && typeof delta?.partial_json === "string") {
        const acc = accumulatingToolCalls.get(index);
        if (acc) acc.arguments += delta.partial_json;
        sawContent = true;
      } else if (typeof delta?.text === "string" && delta.text) {
        sawContent = true;
        args.onDelta(delta.text);
      }
      return;
    }
    if (type === "message_stop") {
      sawDone = true;
      args.onDone?.();
    }
  };

  try {
    for await (const raw of iterateSSEEvents(res)) {
      const { event, data } = parseSSEBlock(raw);
      handleEvent(event, data);
    }
  } catch (err) {
    if (!args.signal?.aborted) {
      sawError = true;
      args.onError?.(err instanceof Error ? err.message : String(err));
    }
  }
  if (!sawContent && !sawError && !sawDone) {
    args.onError?.("Provider returned an empty response");
  }
  if (!sawDone) args.onDone?.();

  const sorted = [...accumulatingToolCalls.entries()].sort((a, b) => a[0] - b[0]);
  const toolCalls: ToolCallWire[] = [];
  for (const [, acc] of sorted) {
    if (!acc.id || !acc.name) continue;
    toolCalls.push({ id: acc.id, type: "function", function: { name: acc.name, arguments: acc.arguments } });
  }
  if (toolCalls.length > 0) args.onToolCalls?.(toolCalls);
  return { toolCalls };
}

async function completeChat(args: AdapterCompleteArgs): Promise<string> {
  const res = await providerFetch(endpoint(args.connection, "/messages"), {
    method: "POST",
    headers: authHeaders(args.connection),
    body: JSON.stringify(
      buildBody({ modelId: args.modelId, messages: args.messages, maxTokens: args.maxTokens, stream: false })
    ),
    signal: args.signal,
  }, args.proxy);
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const content = data.content as Array<Record<string, unknown>> | undefined;
  const text = content?.find((b) => b.type === "text")?.text;
  if (typeof text !== "string") {
    throw new GatewayError(res.status, extractError(data) || "Unexpected response from provider");
  }
  return stripLeakedSpecialTokens(text).trim();
}

async function testConnection(
  connection: ProviderConnection,
  proxy?: CustomProxy,
  preferredModelId?: string
): Promise<AdapterTestResult> {
  const started = performance.now();
  const modelId = preferredModelId ?? connection.models[0]?.id ?? "claude-3-5-haiku-latest";
  const reply = await completeChat({
    connection,
    modelId,
    messages: [{ role: "user", content: "Say OK." }],
    maxTokens: 64,
    proxy,
  });
  return { reply, latencyMs: Math.round(performance.now() - started) };
}

/** Real auto-discovery: fetches Anthropic's own current model list (GET /models). */
async function listModels(connection: ProviderConnection, proxy?: CustomProxy): Promise<ProviderPluginModel[]> {
  const res = await providerFetch(endpoint(connection, "/models"), { headers: authHeaders(connection) }, proxy);
  const data = (await res.json().catch(() => ({}))) as { data?: { id: string }[] };
  if (!res.ok || !Array.isArray(data.data)) {
    throw new GatewayError(res.status, extractError(data) || `HTTP ${res.status}`);
  }
  return data.data.map((m) => ({ id: m.id }));
}

export const anthropicAdapter: ChatAdapter = { streamChat, completeChat, testConnection, listModels };
