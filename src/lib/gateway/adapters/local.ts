import type { CustomProxy, ProviderConnection, ProviderPluginModel } from "../../types";
import type { AdapterChatArgs, AdapterCompleteArgs, AdapterTestResult, ChatAdapter, ToolCallWire } from "../types";
import { GatewayError } from "../types";
import { chromeAIRuntime } from "../local/chromeAI";
import { localErrorMessage } from "../local/errors";
import { webllmRuntime } from "../local/webllm";
import { type LocalRuntime, runtimeIdFromBaseUrl } from "../local/runtime";

/**
 * Adapter for models that run inside this browser.
 *
 * Implementing the same ChatAdapter interface as the networked providers is
 * what makes local models first-class: they inherit auto-routing, circuit
 * breaking, the capability index and the skill tool loop without any of that
 * code knowing they exist. A connection selects its runtime through a
 * `local://<id>` base URL.
 */

export const LOCAL_RUNTIMES: LocalRuntime[] = [webllmRuntime, chromeAIRuntime];

export function localRuntimeById(id: string): LocalRuntime | undefined {
  return LOCAL_RUNTIMES.find((r) => r.id === id);
}

function runtimeFor(connection: ProviderConnection): LocalRuntime {
  const id = runtimeIdFromBaseUrl(connection.baseUrl);
  const runtime = localRuntimeById(id);
  if (!runtime) {
    throw new GatewayError(0, `Unknown local runtime "${id}". Expected one of: ${LOCAL_RUNTIMES.map((r) => r.id).join(", ")}.`);
  }
  if (!runtime.available()) throw new GatewayError(0, runtime.unavailableReason());
  return runtime;
}

async function streamChat(args: AdapterChatArgs): Promise<{ toolCalls: ToolCallWire[] }> {
  const runtime = runtimeFor(args.connection);
  try {
    await runtime.streamChat(args);
    args.onDone?.();
  } catch (err) {
    // Not `err instanceof Error`: a WebLLM worker failure arrives as a bare
    // string, which that test sends to the fallback, hiding the real cause.
    const message = localErrorMessage(err, `${args.modelId} failed to run in this browser.`);
    args.onError?.(message);
    throw err instanceof GatewayError ? err : new GatewayError(0, message);
  }
  // No local runtime here supports function calling reliably, so a turn never
  // comes back with tool calls; the caller's tool loop simply ends.
  return { toolCalls: [] };
}

async function completeChat(args: AdapterCompleteArgs): Promise<string> {
  return runtimeFor(args.connection).completeChat(args);
}

// Proxy params are accepted and ignored: a local model runs in this tab and
// never touches the network, so there is nothing to route.
async function testConnection(
  connection: ProviderConnection,
  _proxy?: CustomProxy,
  preferredModelId?: string
): Promise<AdapterTestResult> {
  const runtime = runtimeFor(connection);
  const models = await runtime.listModels();
  const modelId = preferredModelId ?? connection.models.find((m) => m.enabled !== false)?.id ?? models[0]?.id;
  if (!modelId) throw new GatewayError(0, `${runtime.label} has no models available on this device.`);

  const started = performance.now();
  const reply = await runtime.completeChat({
    connection,
    modelId,
    messages: [{ role: "user", content: "Say OK." }],
    maxTokens: 64,
  });
  return { reply, latencyMs: Math.round(performance.now() - started) };
}

async function listModels(connection: ProviderConnection, _proxy?: CustomProxy): Promise<ProviderPluginModel[]> {
  return runtimeFor(connection).listModels();
}

export const localAdapter: ChatAdapter = { streamChat, completeChat, testConnection, listModels };
