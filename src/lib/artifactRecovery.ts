import type { ChatMessage, GeneratedArtifact } from "./types";
import { createArtifactStreamParser, reduceArtifactEvent } from "./artifacts";
import { createProtocolOutputGuard } from "./gateway/protocolOutput";

/** Some providers fence the entire artifact despite the output instructions.
 * Recover only a complete standalone protocol envelope, never ordinary code
 * fences or markup embedded in an explanation. Run after the response ends. */
export function recoverFencedArtifactMessage(message: ChatMessage): ChatMessage {
  if (message.role !== "assistant" || message.error || message.files?.length || message.toolCalls?.length ||
    !/<fachoy-artifact\s/i.test(message.content)) return message;
  const wrapper = /^(`{3,}|~{3,})(?:xml|html)?[ \t]*\r?\n([\s\S]*?)\r?\n\1[ \t]*$/i.exec(message.content.trim());
  if (!wrapper) return message;
  const inner = wrapper[2].trim();
  if (!/^<fachoy-artifact\s/i.test(inner) || !/<\/fachoy-artifact>$/i.test(inner)) return message;
  // Keep the guard's scanning buffer bounded even for large saved files.
  let validated = "";
  const guard = createProtocolOutputGuard(text => { validated += text; }, true);
  for (let offset = 0; offset < inner.length; offset += 256) guard.push(inner.slice(offset, offset + 256));
  guard.flush();
  if (validated !== inner) return message;
  const parser = createArtifactStreamParser();
  const parsed = parser.push(inner);
  const end = parser.flush();
  if ((parsed.prose + end.prose).trim()) return message;
  const events = [...parsed.events, ...end.events];
  const ids = events.filter(event => event.kind === "start").map(event => event.id);
  if (new Set(ids).size !== ids.length) return message;
  const files = events.reduce<GeneratedArtifact[]>(reduceArtifactEvent, []);
  if (!files.length || files.some(file => file.status !== "complete")) return message;
  return { ...message, content: "", files };
}
