import type { CustomProxy, ProviderConnection, ProviderPluginModel } from "../../types";
import type { AdapterChatArgs, AdapterCompleteArgs, AdapterTestResult, ChatAdapter, ToolCallWire } from "../types";
import { GatewayError } from "../types";
import { providerFetch } from "../providerFetch";
import { assertSSEResponse, consumeOpenAIStream, extractCompletionText } from "../openaiChunks";
import { extractError } from "../util";
import { normalizeHordeSSE } from "../proxy/hordeSSE";
import { providerPresetForUrl } from "../providerPresets";

/** Connection base URL is expected to include the version segment, e.g. "https://api.openai.com/v1". */
function endpoint(connection: ProviderConnection, path: string): string {
  return `${connection.baseUrl.trim().replace(/\/+$/, "")}${path}`;
}

// AI Horde (oai.aihorde.net, see gateway/providerPresets.ts's "aihorde" entry)
// now requires an explicit Authorization header even for anonymous use — a
// fully header-less request 401s "Authorization header missing" (a change
// from when that preset was first verified; a bare missing header used to
// work). Their own docs define "0000000000" as the public, documented
// anonymous-key literal (same lowest-priority queue as no key at all) — send
// it whenever the user hasn't configured a real key of their own, so this
// preset's "works with zero setup" premise keeps holding without the user
// having to paste in a magic string themselves.
const AI_HORDE_HOST = "oai.aihorde.net";
const AI_HORDE_ANONYMOUS_KEY = "0000000000";

function needsHordeProxyCompatibility(connection: ProviderConnection, proxy?: CustomProxy): boolean {
  if (!proxy) return false;
  try {
    return new URL(connection.baseUrl).hostname === AI_HORDE_HOST;
  } catch {
    return false;
  }
}

function authHeaders(connection: ProviderConnection): HeadersInit {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  let key = connection.apiKey;
  if (!key) {
    try {
      if (new URL(connection.baseUrl).hostname === AI_HORDE_HOST) key = AI_HORDE_ANONYMOUS_KEY;
    } catch {
      /* malformed baseUrl — fall through with no key, same as before */
    }
  }
  if (key) headers.Authorization = `Bearer ${key}`;
  return headers;
}

/** Some OpenAI-compatible backends (e.g. Uncloseai) reject a system message
 *  that isn't the very first element ("System message must be at the
 *  beginning"), even though most tolerate it anywhere. A real message can
 *  end up after one today — a skill's system message gets appended to the
 *  end of the persisted conversation when its resources are read mid-chat,
 *  and token-optimization's retrieval-context marker is pushed after the
 *  retrieved turns it wraps. Anthropic/Gemini already relocate every system
 *  message into their own dedicated field regardless of position (see
 *  adapters/anthropic.ts's toAnthropicRequest); do the OpenAI-shape
 *  equivalent — merge them all into one, moved to the front. */
function normalizeSystemPosition(messages: AdapterChatArgs["messages"]): AdapterChatArgs["messages"] {
  const systemParts: string[] = [];
  const rest: AdapterChatArgs["messages"] = [];
  for (const msg of messages) {
    if (msg.role === "system") {
      if (typeof msg.content === "string" && msg.content) systemParts.push(msg.content);
      continue;
    }
    rest.push(msg);
  }
  if (systemParts.length === 0) return messages;
  return [{ role: "system", content: systemParts.join("\n\n") }, ...rest];
}

/** AI Horde rejects text-part arrays with HTTP 500. Apply this compatibility
 * conversion only on its proxied path; all direct request formats stay intact. */
function normalizeTextContent(messages: AdapterChatArgs["messages"]): AdapterChatArgs["messages"] {
  return messages.map((message) => {
    if (typeof message.content === "string" || !message.content.every((part) => part.type === "text")) {
      return message;
    }
    return { ...message, content: message.content.map((part) => part.text).join("\n\n") };
  });
}

function buildBody(args: {
  modelId: string;
  messages: AdapterChatArgs["messages"];
  tools?: AdapterChatArgs["tools"];
  toolChoice?: string;
  maxTokens?: number;
  stream: boolean;
  hordeProxyCompatibility?: boolean;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: args.modelId,
    messages: normalizeSystemPosition(args.hordeProxyCompatibility ? normalizeTextContent(args.messages) : args.messages),
    stream: args.stream,
  };
  if (args.tools && args.tools.length > 0) {
    body.tools = args.tools;
    if (args.toolChoice) body.tool_choice = args.toolChoice;
  }
  if (args.maxTokens) body.max_tokens = args.maxTokens;
  return body;
}

async function streamChat(args: AdapterChatArgs): Promise<{ toolCalls: ToolCallWire[] }> {
  const hordeProxyCompatibility = needsHordeProxyCompatibility(args.connection, args.proxy);
  const res = await providerFetch(endpoint(args.connection, "/chat/completions"), {
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
        hordeProxyCompatibility,
      })
    ),
    signal: args.signal,
  }, args.proxy);
  await assertSSEResponse(res);
  const toolCalls = await consumeOpenAIStream(hordeProxyCompatibility ? normalizeHordeSSE(res) : res, args);
  return { toolCalls };
}

async function completeChat(args: AdapterCompleteArgs): Promise<string> {
  const res = await providerFetch(endpoint(args.connection, "/chat/completions"), {
    method: "POST",
    headers: authHeaders(args.connection),
    body: JSON.stringify(
      buildBody({
        modelId: args.modelId,
        messages: args.messages,
        maxTokens: args.maxTokens,
        stream: false,
        hordeProxyCompatibility: needsHordeProxyCompatibility(args.connection, args.proxy),
      })
    ),
    signal: args.signal,
  }, args.proxy);
  return extractCompletionText(res);
}

async function testConnection(
  connection: ProviderConnection,
  proxy?: CustomProxy,
  preferredModelId?: string
): Promise<AdapterTestResult> {
  const started = performance.now();
  const modelId = preferredModelId ?? connection.models[0]?.id ?? "gpt-4o-mini";
  const reply = await completeChat({
    connection,
    modelId,
    messages: [{ role: "user", content: "Say OK." }],
    maxTokens: 64,
    proxy,
  });
  return { reply, latencyMs: Math.round(performance.now() - started) };
}

/** Real auto-discovery: fetches the provider's own current model list (GET /models). */
async function listModels(connection: ProviderConnection, proxy?: CustomProxy): Promise<ProviderPluginModel[]> {
  const res = await providerFetch(
    endpoint(connection, "/models"),
    { headers: authHeaders(connection) },
    proxy
  );
  const data = (await res.json().catch(() => ({}))) as { data?: {
    id: string; name?: string; isFree?: boolean; billing_mode?: string; tier?: string;
    available?: boolean; context_length?: number; context_window?: number;
    supported_parameters?: string[]; capabilities?: { tools?: boolean; vision?: boolean; reasoning?: boolean };
  }[] };
  if (!res.ok || !Array.isArray(data.data)) {
    throw new GatewayError(res.status, extractError(data) || `HTTP ${res.status}`);
  }
  const presetId = providerPresetForUrl(connection.baseUrl)?.id;
  const hasAnonymousCatalog = ["kilo-gateway", "blockrun", "kouzi"].includes(presetId ?? "");
  return data.data.filter(m => typeof m.id === "string" && m.available !== false).flatMap(m => {
    const freeAccess = presetId === "kilo-gateway" ? m.isFree === true
      : presetId === "blockrun" ? m.billing_mode === "free"
      : presetId === "kouzi" ? m.tier === "turbo" : undefined;
    if (hasAnonymousCatalog && !connection.apiKey && !freeAccess) return [];
    return [{
      id: m.id,
      ...(m.name ? { name: m.name } : {}),
      ...(freeAccess !== undefined ? { freeAccess } : {}),
      ...(typeof m.context_length === "number" ? { contextLength: m.context_length } :
        typeof m.context_window === "number" ? { contextLength: m.context_window } : {}),
      ...(m.supported_parameters ? { toolCalling: m.supported_parameters.includes("tools") } :
        m.capabilities?.tools !== undefined ? { toolCalling: m.capabilities.tools } : {}),
      ...(m.capabilities?.vision !== undefined ? { supportsVision: m.capabilities.vision } : {}),
      ...(m.capabilities?.reasoning !== undefined ? { supportsReasoning: m.capabilities.reasoning } : {}),
    }];
  });
}

export const openaiAdapter: ChatAdapter = { streamChat, completeChat, testConnection, listModels };
