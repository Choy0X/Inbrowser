import { promptScaleFor } from "./promptScale";
import { ARTIFACT_SYSTEM_PROMPT } from "./artifacts";
import { COMPACT_SYSTEM_PROMPT, DEFAULT_SYSTEM_PROMPT } from "./preferences";
import type { ChatMessageInput } from "./gateway/types";

/** Apply capacity policy to instructions and parsing on every route attempt.
 * User text never determines capabilities or permissions. */
export function responsePolicyFor(
  modelId: string,
  messages: ChatMessageInput[],
  artifactsEnabled = false,
  contextLength?: number,
) {
  const scale = promptScaleFor(modelId, { contextLength });
  const allowArtifacts = artifactsEnabled && scale.artifacts;
  return {
    allowArtifacts,
    messages: messages
      .filter(m => allowArtifacts || !(m.role === "system" && m.content === ARTIFACT_SYSTEM_PROMPT))
      .map(m => scale.compact && m.role === "system" && m.content === DEFAULT_SYSTEM_PROMPT
        ? { ...m, content: COMPACT_SYSTEM_PROMPT } : m),
  };
}
