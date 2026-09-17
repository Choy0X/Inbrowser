import type { ChatMessage, Conversation } from "./types";
import { extractFencedArtifactsFromText } from "./fencedCodeArtifacts";

/**
 * Retroactively applies fencedCodeArtifacts.ts's promotion to a message
 * stored before that fix existed. Safe/idempotent by construction: the live
 * streaming pipeline only ever appends a fence's *prose* onto `content` —
 * anything that crossed PROMOTE_THRESHOLD was already diverted into `files`
 * at stream time and never touched `content` at all. So re-running this on
 * an already-migrated (or always-fine) message finds nothing to promote and
 * returns the exact same object reference.
 */
function migrateMessageFences(message: ChatMessage): ChatMessage {
  if (message.role !== "assistant" || !message.content.includes("```")) return message;
  const { prose, artifacts } = extractFencedArtifactsFromText(message.content);
  if (artifacts.length === 0) return message;
  return { ...message, content: prose, files: [...(message.files ?? []), ...artifacts] };
}

const FRAME_BUDGET_MS = 8; // headroom in a ~16ms frame

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

export interface ConversationMigrationResult {
  /**
   * Messages whose content/files actually changed, keyed by id — NOT a
   * full rebuilt Conversation. A migration that spans multiple frames runs
   * against a point-in-time snapshot of `conversation.messages`, so callers
   * MUST merge this onto whatever the live messages array is at write-back
   * time (by id) rather than writing back a whole-array snapshot — the live
   * array may have gained/changed messages (a new send, an edit, a retry)
   * while this was still running.
   */
  changed: Map<string, ChatMessage>;
}

/**
 * Runs the fence migration once per conversation, ever — see
 * Conversation.fencesMigrated (types.ts). Adaptive/time-sliced rather than a
 * fixed message-count batch, so it handles "many small messages" and "few
 * huge messages" alike without needing any size pre-check: each message is
 * migrated synchronously until the running slice has spent FRAME_BUDGET_MS,
 * at which point it reports progress and yields to the browser (a real
 * requestAnimationFrame, i.e. a real paint boundary) before continuing. A
 * conversation whose total migration cost never crosses that budget just
 * resolves in one go, with `onProgress` never called at all.
 */
export async function migrateConversationFencesChunked(
  conversation: Conversation,
  onProgress?: (processed: number, total: number) => void,
  shouldAbort?: () => boolean
): Promise<ConversationMigrationResult> {
  if (conversation.fencesMigrated) return { changed: new Map() };
  const total = conversation.messages.length;
  const changed = new Map<string, ChatMessage>();
  let sliceStart = performance.now();
  for (let i = 0; i < total; i++) {
    if (shouldAbort?.()) break;
    const original = conversation.messages[i];
    const migrated = migrateMessageFences(original);
    if (migrated !== original) changed.set(original.id, migrated);
    if (performance.now() - sliceStart >= FRAME_BUDGET_MS) {
      onProgress?.(i + 1, total);
      await yieldToBrowser();
      sliceStart = performance.now();
    }
  }
  onProgress?.(total, total);
  return { changed };
}
