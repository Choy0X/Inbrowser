/**
 * Turning a local-runtime failure into something a user can act on.
 *
 * WebLLM runs its engine in a Worker and marshals failures back across
 * postMessage. An Error does not survive that trip, so the client rejects with
 * the *string* it was sent (`reject(msg.content)` in web-llm's `getPromise`).
 * Every `err instanceof Error ? err.message : "..."` on this path therefore
 * takes the fallback branch and throws the real diagnosis away - which is how
 * a device that reported exactly why it could not load a model surfaced as
 * "Local model failed."
 */

/** The message out of a rejection of any shape, including a bare string. */
export function localErrorMessage(err: unknown, fallback: string): string {
  if (typeof err === "string" && err.trim()) return err.trim();
  if (err instanceof Error && err.message.trim()) return err.message.trim();
  if (err && typeof err === "object") {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message.trim();
    try {
      const json = JSON.stringify(err);
      if (json && json !== "{}") return json;
    } catch {
      /* circular or exotic; fall through to the caller's fallback */
    }
  }
  return fallback;
}

/** Failures that mean "this device cannot fit this model", not "it is broken". */
function looksLikeCapacityFailure(message: string): boolean {
  return /maxBufferSize|maxStorageBufferBindingSize|out of memory|OOM|allocation|device was lost|deviceLost/i.test(
    message
  );
}

/** Failures that mean the GPU lacks a feature the model's build needs. */
function looksLikeF16Failure(message: string): boolean {
  return /shader-f16|ShaderF16/i.test(message);
}

export interface ModelSizeInfo {
  id: string;
  vramRequiredMB?: number;
}

/**
 * Add the advice the runtime cannot give.
 *
 * WebLLM knows its buffer request was refused; it does not know the catalog
 * holds a smaller build of the same model. A user told only "requested
 * maxBufferSize exceeds limit" has no way to get from there to "use the q4f16
 * build", so the alternative is named explicitly.
 */
export function explainLocalFailure(
  message: string,
  modelId: string,
  catalog: ModelSizeInfo[]
): string {
  const capacity = looksLikeCapacityFailure(message);
  const f16 = looksLikeF16Failure(message);
  if (!capacity && !f16) return message;

  const current = catalog.find((m) => m.id === modelId);
  const needs = current?.vramRequiredMB
    ? ` ${modelId} needs about ${(current.vramRequiredMB / 1024).toFixed(1)} GB of GPU memory.`
    : "";

  if (f16) {
    return `${message}\n\nThis build needs the GPU "shader-f16" feature, which this device does not report.${needs} A -q4f32_1- build of the same model does not need it.`;
  }

  const lighter = lighterAlternative(modelId, catalog);
  const suggestion = lighter
    ? ` A smaller build of the same model is available: ${lighter.id}${
        lighter.vramRequiredMB ? ` (about ${(lighter.vramRequiredMB / 1024).toFixed(1)} GB)` : ""
      }. Install it from the store and select it instead.`
    : " Try a smaller model from the store - the 1B builds run on most devices.";

  return `${message}\n\nThis device could not give the model the GPU memory it asked for.${needs}${suggestion}`;
}

/**
 * The smallest build of the same model family that is meaningfully lighter.
 *
 * Model ids are `<Family>-<quantisation>-MLC`, so dropping the quantisation
 * suffix groups the builds of one model: Llama-3.2-3B-Instruct-q4f32_1-MLC and
 * -q4f16_1-MLC are the same weights at different precision.
 */
export function lighterAlternative(
  modelId: string,
  catalog: ModelSizeInfo[]
): ModelSizeInfo | undefined {
  const current = catalog.find((m) => m.id === modelId);
  if (!current?.vramRequiredMB) return undefined;

  const family = familyOf(modelId);
  const candidates = catalog
    .filter((m) => m.id !== modelId && familyOf(m.id) === family)
    .filter((m) => (m.vramRequiredMB ?? Infinity) < current.vramRequiredMB! * 0.95)
    .sort((a, b) => (b.vramRequiredMB ?? 0) - (a.vramRequiredMB ?? 0));

  // The largest build that is still clearly smaller: the closest thing to what
  // was asked for that has a chance of loading.
  return candidates[0];
}

function familyOf(modelId: string): string {
  return modelId.replace(/-MLC$/, "").replace(/-q\d+f\d+(_\d+)?$/, "");
}
