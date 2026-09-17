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

function endpoint(connection: ProviderConnection, path: string): string {
  return `${connection.baseUrl.trim().replace(/\/+$/, "")}${path}`;
}

function authHeaders(connection: ProviderConnection): HeadersInit {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (connection.apiKey) headers["x-goog-api-key"] = connection.apiKey;
  return headers;
}

function imagePartToPart(url: string): Record<string, unknown> | null {
  const dataMatch = /^data:([^;]+);base64,(.+)$/.exec(url);
  if (dataMatch) return { inlineData: { mimeType: dataMatch[1], data: dataMatch[2] } };
  // Remote (non data:) image URLs aren't supported without Gemini's separate
  // File API upload flow — out of scope; drop rather than send a broken part.
  return null;
}

function contentToParts(content: string | ChatContentPart[]): Record<string, unknown>[] {
  if (typeof content === "string") return content ? [{ text: content }] : [];
  const parts: Record<string, unknown>[] = [];
  for (const part of content) {
    if (part.type === "image_url") {
      const p = imagePartToPart(part.image_url.url);
      if (p) parts.push(p);
    } else {
      parts.push({ text: part.text });
    }
  }
  return parts;
}

/** Translate the internal OpenAI-shaped message list into Gemini's request shape. */
function toGeminiRequest(messages: ChatMessageInput[]): {
  systemInstruction?: Record<string, unknown>;
  contents: Record<string, unknown>[];
} {
  const systemParts: string[] = [];
  const contents: Record<string, unknown>[] = [];
  // Gemini's functionResponse needs the original call's name, which our wire
  // "tool" messages don't carry directly (only tool_call_id) — recover it
  // from the preceding assistant message's tool_calls as we walk forward.
  const callIdToName = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role === "system") {
      if (typeof msg.content === "string" && msg.content) systemParts.push(msg.content);
      continue;
    }
    if (msg.role === "tool") {
      const name = (msg.tool_call_id && callIdToName.get(msg.tool_call_id)) || "tool";
      contents.push({
        role: "function",
        parts: [
          {
            functionResponse: {
              name,
              response: { result: typeof msg.content === "string" ? msg.content : "" },
            },
          },
        ],
      });
      continue;
    }
    if (msg.role === "assistant") {
      const parts = contentToParts(msg.content);
      for (const tc of msg.tool_calls ?? []) {
        callIdToName.set(tc.id, tc.function.name);
        let args: unknown = {};
        try {
          args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
        } catch {
          args = {};
        }
        parts.push({ functionCall: { name: tc.function.name, args } });
      }
      contents.push({ role: "model", parts });
      continue;
    }
    contents.push({ role: "user", parts: contentToParts(msg.content) });
  }
  return {
    systemInstruction: systemParts.length > 0 ? { parts: [{ text: systemParts.join("\n\n") }] } : undefined,
    contents,
  };
}

function toGeminiTools(tools?: ToolDef[]): Record<string, unknown>[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
      })),
    },
  ];
}

function toGeminiToolConfig(toolChoice?: string): Record<string, unknown> | undefined {
  if (!toolChoice || toolChoice === "auto") return undefined;
  if (toolChoice === "none") return { functionCallingConfig: { mode: "NONE" } };
  if (toolChoice === "required") return { functionCallingConfig: { mode: "ANY" } };
  return { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [toolChoice] } };
}

function buildBody(args: {
  messages: ChatMessageInput[];
  tools?: ToolDef[];
  toolChoice?: string;
  maxTokens?: number;
}): Record<string, unknown> {
  const { systemInstruction, contents } = toGeminiRequest(args.messages);
  const body: Record<string, unknown> = { contents };
  if (systemInstruction) body.systemInstruction = systemInstruction;
  const tools = toGeminiTools(args.tools);
  if (tools) {
    body.tools = tools;
    const toolConfig = toGeminiToolConfig(args.toolChoice);
    if (toolConfig) body.toolConfig = toolConfig;
  }
  if (args.maxTokens) body.generationConfig = { maxOutputTokens: args.maxTokens };
  return body;
}

let toolCallCounter = 0;
function nextToolCallId(): string {
  toolCallCounter += 1;
  return `gemini-call-${Date.now()}-${toolCallCounter}`;
}

async function streamChat(args: AdapterChatArgs): Promise<{ toolCalls: ToolCallWire[] }> {
  const res = await providerFetch(
    endpoint(args.connection, `/models/${args.modelId}:streamGenerateContent?alt=sse`),
    {
      method: "POST",
      headers: authHeaders(args.connection),
      body: JSON.stringify(
        buildBody({ messages: args.messages, tools: args.tools, toolChoice: args.toolChoice, maxTokens: args.maxTokens })
      ),
      signal: args.signal,
    },
    args.proxy
  );

  const contentType = res.headers.get("content-type") || "";
  if (!res.ok || !contentType.includes("text/event-stream")) {
    const raw = await res.text().catch(() => "");
    const { message, malformed } = parseErrorMessage(raw, res.status);
    throw new GatewayError(res.status, message, malformed);
  }

  let sawContent = false;
  let sawError = false;
  const toolCalls: ToolCallWire[] = [];

  const handleEvent = (payload: string) => {
    let json: unknown;
    try {
      json = JSON.parse(payload);
    } catch {
      return;
    }
    const obj = json as Record<string, unknown>;
    if (extractError(obj)) {
      sawError = true;
      args.onError?.(extractError(obj) || "Provider returned an error");
      return;
    }
    const candidate = (obj.candidates as Array<Record<string, unknown>> | undefined)?.[0];
    const content = candidate?.content as Record<string, unknown> | undefined;
    const parts = (content?.parts as Array<Record<string, unknown>> | undefined) ?? [];
    for (const part of parts) {
      if (typeof part.text === "string" && part.text) {
        sawContent = true;
        // Gemini 2.5 "thinking" models mark a thought-summary part with its
        // own native `thought: true` flag (only sent when the request opts
        // into thinkingConfig.includeThoughts, which this app doesn't today)
        // — route it to the "Thinking" UI instead of the visible answer,
        // mirroring how adapters/anthropic.ts already reads Anthropic's
        // native "thinking" content-block kind.
        if (part.thought === true) args.onReasoning?.(stripLeakedSpecialTokens(part.text));
        else args.onDelta(part.text);
      }
      const fc = part.functionCall as Record<string, unknown> | undefined;
      if (fc && typeof fc.name === "string") {
        sawContent = true;
        toolCalls.push({
          id: nextToolCallId(),
          type: "function",
          function: { name: fc.name, arguments: JSON.stringify(fc.args ?? {}) },
        });
      }
    }
  };

  try {
    for await (const raw of iterateSSEEvents(res)) {
      const { data } = parseSSEBlock(raw);
      if (data) handleEvent(data);
    }
  } catch (err) {
    if (!args.signal?.aborted) {
      sawError = true;
      args.onError?.(err instanceof Error ? err.message : String(err));
    }
  }
  if (!sawContent && !sawError) {
    args.onError?.("Provider returned an empty response");
  }
  args.onDone?.();
  if (toolCalls.length > 0) args.onToolCalls?.(toolCalls);
  return { toolCalls };
}

async function completeChat(args: AdapterCompleteArgs): Promise<string> {
  const res = await providerFetch(endpoint(args.connection, `/models/${args.modelId}:generateContent`), {
    method: "POST",
    headers: authHeaders(args.connection),
    body: JSON.stringify(buildBody({ messages: args.messages, maxTokens: args.maxTokens })),
    signal: args.signal,
  }, args.proxy);
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const candidate = (data.candidates as Array<Record<string, unknown>> | undefined)?.[0];
  const content = candidate?.content as Record<string, unknown> | undefined;
  const parts = (content?.parts as Array<Record<string, unknown>> | undefined) ?? [];
  // Exclude thought-summary parts (see streamChat above) — this path has no
  // reasoning UI to route them to, so they'd otherwise contaminate the result.
  const text = parts
    .map((p) => (p.thought === true ? "" : typeof p.text === "string" ? p.text : ""))
    .join("")
    .trim();
  if (!text) {
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
  const modelId = preferredModelId ?? connection.models[0]?.id ?? "gemini-2.0-flash";
  const reply = await completeChat({
    connection,
    modelId,
    messages: [{ role: "user", content: "Say OK." }],
    maxTokens: 64,
    proxy,
  });
  return { reply, latencyMs: Math.round(performance.now() - started) };
}

/** Real auto-discovery: fetches Gemini's own current model list (GET /models), keeping only chat-capable ones. */
async function listModels(connection: ProviderConnection, proxy?: CustomProxy): Promise<ProviderPluginModel[]> {
  const res = await providerFetch(
    endpoint(connection, "/models?pageSize=1000"),
    { headers: authHeaders(connection) },
    proxy
  );
  const data = (await res.json().catch(() => ({}))) as {
    models?: {
      name: string;
      inputTokenLimit?: number;
      outputTokenLimit?: number;
      supportedGenerationMethods?: string[];
    }[];
  };
  if (!res.ok || !Array.isArray(data.models)) {
    throw new GatewayError(res.status, extractError(data) || `HTTP ${res.status}`);
  }
  return data.models
    .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
    .map((m) => ({
      id: m.name.replace(/^models\//, ""),
      contextLength: m.inputTokenLimit,
      maxOutputTokens: m.outputTokenLimit,
    }));
}

export const geminiAdapter: ChatAdapter = { streamChat, completeChat, testConnection, listModels };
