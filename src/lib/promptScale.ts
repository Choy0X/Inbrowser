import type { ModelCapabilities } from "./capabilities";
import { declaredParamsB, SMALL_CONTEXT, SMALL_PARAMS_B } from "./modelSize";

export { declaredParamsB };

/**
 * Matching the system prompt to what the model can actually follow.
 *
 * A 1B model asked "hi" replied with the artifact contract's own template:
 *
 *   <fachoy-artifact id="UNIQUE_ID" type="TYPE" title="FILENAME.EXT">
 *   FILE CONTENT HERE, NOTHING ELSE
 *   </fachoy-artifact>
 *
 * It was doing the most literal thing available to it. The turn carried about
 * 1,000 tokens of instructions - a 350-token behavioural prompt plus a
 * 646-token artifact contract containing that exact template - into a 4,096
 * token context window. A small model handed a long list of clauses and one
 * concrete example will reproduce the example.
 *
 * So the contract is not sent to models that cannot perform it. This is not a
 * workaround for one model: a 1B model will never emit a well-formed
 * <fachoy-artifact> tag with a matching id, type, title and closing tag, so
 * the 646 tokens were buying nothing and costing 16% of everything the model
 * could see - while actively breaking ordinary conversation.
 *
 * The behavioural prompt is also replaced with a short one. Its long form
 * spends most of its length on negative constraints ("don't narrate", "don't
 * restate the question"), and every one of those is another clause a small
 * model can latch onto and echo.
 */

export interface PromptScale {
  /** Use the short behavioural prompt rather than the full one. */
  compact: boolean;
  /** Send the artifact contract at all. */
  artifacts: boolean;
  /**
   * Tell the model that diagrams, maths and charts render (richOutput.ts).
   * Tracks `compact`: the same models that cannot hold the artifact contract
   * cannot hold a second capability list either, and would echo it instead.
   */
  richOutput: boolean;
  /** Why, for the settings UI and for explaining a missing feature. */
  reason?: string;
}

export function promptScaleFor(modelId: string, caps?: Pick<ModelCapabilities, "contextLength">): PromptScale {
  const params = declaredParamsB(modelId);
  if (params !== undefined && params <= SMALL_PARAMS_B) {
    return {
      compact: true,
      artifacts: false,
      richOutput: false,
      reason: `${params}B models do not reliably follow the file-artifact contract, so it is left out to keep ordinary replies working.`,
    };
  }

  const context = caps?.contextLength;
  if (context !== undefined && context > 0 && context <= SMALL_CONTEXT) {
    return {
      compact: true,
      artifacts: false,
      richOutput: false,
      reason: `A ${context.toLocaleString()}-token context is too small to add the file-artifact contract reliably.`,
    };
  }

  return { compact: false, artifacts: true, richOutput: true };
}
