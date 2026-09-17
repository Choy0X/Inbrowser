/**
 * Shared "is this model too small" signal, extracted from promptScale.ts so
 * routingEngine.ts can reuse it too without an import cycle: routingEngine.ts
 * -> promptScale.ts -> capabilities.ts -> routingEngine.ts (capabilities.ts
 * already imports selectUsableModels from routingEngine.ts). This module has
 * no dependencies of its own, so both can import it directly.
 */

/**
 * Parameter count in billions, if the model id declares one.
 *
 * Ids state it by convention: Llama-3.2-1B-Instruct, Qwen2.5-1.5B-Instruct,
 * llama-3.1-70b-instruct. The delimiters matter - without them "gpt-4o" reads
 * as a 4-billion parameter model.
 */
export function declaredParamsB(modelId: string): number | undefined {
  const match = /[-_/ ](\d+(?:\.\d+)?)\s*b(?=[-_/. ]|$)/i.exec(modelId);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Above this, models follow a multi-clause contract well enough to be worth
 * sending one. Below it they echo the example instead. 4B is where the
 * observed behaviour changes, not a figure from a spec.
 */
export const SMALL_PARAMS_B = 4;

/** A window this small cannot afford ~650 tokens of contract. */
export const SMALL_CONTEXT = 8192;

/**
 * Same "too small" line promptScale.ts draws for the artifact contract,
 * reused by Auto routing: a model that cannot reliably follow a multi-clause
 * contract is also not one to hand an expert-level coding/document task to.
 */
export function isSmallModel(modelId: string, contextLength?: number): boolean {
  const params = declaredParamsB(modelId);
  if (params !== undefined && params <= SMALL_PARAMS_B) return true;
  return contextLength !== undefined && contextLength > 0 && contextLength <= SMALL_CONTEXT;
}
