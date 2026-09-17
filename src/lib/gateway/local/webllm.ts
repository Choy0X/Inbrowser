import type { ProviderPluginModel } from "../../types";
import type { AdapterChatArgs, AdapterCompleteArgs } from "../types";
import { GatewayError } from "../types";
import { explainLocalFailure, localErrorMessage, type ModelSizeInfo } from "./errors";
import { toWebLLMMessages } from "./messageOrder";
import { publishLocalProgress } from "./progress";
import type { LocalRuntime } from "./runtime";

/**
 * WebLLM: full models running in the browser on WebGPU.
 *
 * This is where most of InBrowser's free model catalog comes from. Only five
 * hosted keyless providers exist and every one rate-limits; a local model has
 * no key, no quota and no network at all once its weights are cached, so it is
 * also the natural last-resort target for the auto-router when the hosted
 * providers start returning 429.
 *
 * The library and its WASM runtime are ~2 MB, so everything here is behind a
 * dynamic import: a user who never touches a local model never downloads it.
 */

type Engine = import("@mlc-ai/web-llm").MLCEngineInterface;

let enginePromise: Promise<Engine> | null = null;
let loadedModelId: string | null = null;

function supported(): boolean {
  return typeof navigator !== "undefined" && "gpu" in navigator;
}

/**
 * Model sizes from WebLLM's own catalog, cached after the first load.
 *
 * Needed to explain a capacity failure: the runtime knows its buffer request
 * was refused but not that a smaller build of the same model exists.
 */
let sizeCatalog: ModelSizeInfo[] = [];

async function loadSizeCatalog(): Promise<ModelSizeInfo[]> {
  if (sizeCatalog.length > 0) return sizeCatalog;
  try {
    const { prebuiltAppConfig } = await import("@mlc-ai/web-llm");
    sizeCatalog = prebuiltAppConfig.model_list.map((m) => ({
      id: m.model_id,
      vramRequiredMB: m.vram_required_MB,
    }));
  } catch {
    /* an explanation is a nicety; never let it mask the real failure */
  }
  return sizeCatalog;
}

async function createEngine(modelId: string): Promise<Engine> {
  const webllm = await import("@mlc-ai/web-llm");
  const worker = new Worker(new URL("../../../workers/webllmWorker.ts", import.meta.url), {
    type: "module",
  });
  return webllm.CreateWebWorkerMLCEngine(worker, modelId, {
    initProgressCallback: (report) => {
      publishLocalProgress({
        modelId,
        progress: typeof report.progress === "number" ? report.progress : undefined,
        text: report.text,
        done: false,
      });
    },
  });
}

/**
 * One engine at a time. Weights are large enough that holding two resident is a
 * good way to run a machine out of GPU memory, so switching models tears the
 * previous engine down first.
 */
async function engineFor(modelId: string): Promise<Engine> {
  if (!supported()) {
    throw new GatewayError(
      0,
      "This browser has no WebGPU support, so local models can't run here. Chrome or Edge 113+ on a machine with a supported GPU is required."
    );
  }

  if (enginePromise && loadedModelId === modelId) return enginePromise;

  if (enginePromise) {
    const previous = enginePromise;
    enginePromise = null;
    loadedModelId = null;
    try {
      await (await previous).unload();
    } catch {
      /* tearing down a broken engine must not block loading the next one */
    }
  }

  loadedModelId = modelId;
  enginePromise = createEngine(modelId).catch(async (err) => {
    enginePromise = null;
    loadedModelId = null;
    publishLocalProgress(null);
    // The engine runs in a Worker, so this rejection is usually the plain
    // string web-llm marshalled back - not an Error. Reading it as one threw
    // away the device's actual diagnosis and reported "Local model failed."
    const raw = localErrorMessage(err, `${modelId} failed to load in this browser.`);
    throw new GatewayError(0, explainLocalFailure(raw, modelId, await loadSizeCatalog()));
  });
  return enginePromise;
}

export const webllmRuntime: LocalRuntime = {
  id: "webllm",
  label: "WebLLM (WebGPU)",

  available() {
    return supported();
  },

  unavailableReason() {
    return "Needs WebGPU. Use Chrome or Edge 113+ on a machine with a supported GPU.";
  },

  async listModels(): Promise<ProviderPluginModel[]> {
    const { prebuiltAppConfig } = await import("@mlc-ai/web-llm");
    return prebuiltAppConfig.model_list.map((m) => ({
      id: m.model_id,
      name: m.model_id.replace(/-MLC$/, ""),
      contextLength: m.overrides?.context_window_size ?? undefined,
      // Every local model is free by definition: no key, no quota, no network.
      freeAccess: true,
      // WebLLM's OpenAI-compatible layer supports function calling only for a
      // few models, and never reliably enough to advertise it here.
      toolCalling: false,
      supportsVision: /vision|llava|phi-3\.5-vision/i.test(m.model_id),
      supportsReasoning: /deepseek-r1|qwq/i.test(m.model_id),
    }));
  },

  async streamChat(args: AdapterChatArgs): Promise<void> {
    const engine = await engineFor(args.modelId);
    publishLocalProgress({ modelId: args.modelId, text: "Generating", done: true });

    try {
      const stream = await engine.chat.completions.create({
        messages: toWebLLMMessages(args.messages),
        stream: true,
        max_tokens: args.maxTokens,
      });

      for await (const chunk of stream) {
        if (args.signal?.aborted) {
          await engine.interruptGenerate();
          break;
        }
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) args.onDelta(delta);
      }
    } finally {
      publishLocalProgress(null);
    }
  },

  async completeChat(args: AdapterCompleteArgs): Promise<string> {
    const engine = await engineFor(args.modelId);
    try {
      const res = await engine.chat.completions.create({
        messages: toWebLLMMessages(args.messages),
        stream: false,
        max_tokens: args.maxTokens,
      });
      return res.choices[0]?.message?.content ?? "";
    } finally {
      publishLocalProgress(null);
    }
  },

  /** Frees GPU memory. Called when the Plugins store uninstalls a model. */
  async unload(): Promise<void> {
    if (!enginePromise) return;
    const previous = enginePromise;
    enginePromise = null;
    loadedModelId = null;
    try {
      await (await previous).unload();
    } catch {
      /* ignore */
    }
  },
};
