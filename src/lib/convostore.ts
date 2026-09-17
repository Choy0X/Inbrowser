import type { Conversation } from "./types";

/**
 * Conversation persistence, on IndexedDB.
 *
 * This used to be a single localStorage key holding every conversation,
 * including inline base64 image attachments and rasterized PDF pages. That hit
 * the ~5 MB quota quickly, and the quota handler retried with `slice(-20)`
 * while new conversations were unshifted to the front - so it kept the twenty
 * OLDEST chats and silently destroyed the newest ones, then gave up silently if
 * that still didn't fit. IndexedDB has orders of magnitude more room and no
 * such cliff.
 *
 * Two other properties matter here:
 *   - One record per conversation, written by diff, so streaming a reply
 *     rewrites only the active chat rather than re-serializing all history on
 *     every token.
 *   - An explicit id order is stored alongside, so list order stays exactly
 *     what it was (creation order, newest first) rather than being re-derived
 *     from timestamps.
 */

const DB_NAME = "fachoy-conversations";
const DB_VERSION = 1;
const STORE = "conversations";
const META = "meta";
const ORDER_KEY = "order";

/** The pre-IndexedDB localStorage key, drained once by `migrateFromLocalStorage`. */
const LEGACY_KEY = "fachoy:conversations:v1";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Failed to open the conversation store"));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("Conversation write aborted"));
    tx.onerror = () => reject(tx.error ?? new Error("Conversation write failed"));
  });
}

function requestValue<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Conversation read failed"));
  });
}

/**
 * Mirror of what is currently on disk, so each save can write only what
 * changed. React replaces the objects it updates, so reference equality is a
 * sufficient and very cheap dirty check.
 */
let persisted = new Map<string, Conversation>();
let persistedOrder: string[] = [];

/** Only conversations with content belong in history. */
function persistable(conversations: Conversation[]): Conversation[] {
  return conversations.filter((c) => !c.temporary && c.messages.length > 0);
}

const INTERRUPTED_MESSAGE =
  "Generation was interrupted (lost connection, page reload, or the tab was closed) before it finished.";

/**
 * A live turn that never reaches its `finally` block (network drop, page reload,
 * tab closed) leaves its empty assistant placeholder persisted as-is: no content,
 * no error, nothing for the UI to key off, so it renders as a dead, empty bubble
 * with no retry option forever. Normal completion already drops an empty
 * placeholder (see the `runAssistant` finally block) - anything empty reaching
 * disk is therefore always an interrupted one. Flagging it with an error on load
 * reuses the existing error/Retry UI instead of a special-cased "stuck" state.
 */
function reconcileInterruptedMessages(convo: Conversation): Conversation {
  let changed = false;
  const messages = convo.messages.map((m) => {
    if (
      m.role === "assistant" &&
      !m.content &&
      !m.error &&
      !m.reasoning &&
      !m.media?.length &&
      !m.files?.length &&
      !m.toolCalls?.length
    ) {
      changed = true;
      return { ...m, error: INTERRUPTED_MESSAGE };
    }
    return m;
  });
  return changed ? { ...convo, messages } : convo;
}

/**
 * Moves any pre-IndexedDB history across, then clears the old key. Runs once;
 * a partially-migrated state is safe to retry because writes are keyed by id.
 */
async function migrateFromLocalStorage(db: IDBDatabase): Promise<Conversation[] | null> {
  let legacy: Conversation[];
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      localStorage.removeItem(LEGACY_KEY);
      return null;
    }
    legacy = parsed as Conversation[];
  } catch {
    return null;
  }

  const rows = persistable(legacy);
  const tx = db.transaction([STORE, META], "readwrite");
  const store = tx.objectStore(STORE);
  for (const convo of rows) store.put(convo);
  tx.objectStore(META).put(rows.map((c) => c.id), ORDER_KEY);
  await done(tx);

  // Only drop the old copy once the new one is committed.
  try {
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    /* ignore */
  }
  return rows;
}

/**
 * Read all conversations, in their stored order. Async, unlike the localStorage
 * version it replaces, so App.tsx loads them in an effect rather than as a
 * lazy useState initializer.
 */
export async function loadConversations(): Promise<Conversation[]> {
  let db: IDBDatabase;
  try {
    db = await openDb();
  } catch {
    return [];
  }

  try {
    const migrated = await migrateFromLocalStorage(db);
    let rows: Conversation[];
    let order: string[];

    if (migrated) {
      rows = migrated;
      order = migrated.map((c) => c.id);
    } else {
      const tx = db.transaction([STORE, META], "readonly");
      const all = await requestValue(tx.objectStore(STORE).getAll() as IDBRequest<Conversation[]>);
      const storedOrder = await requestValue(tx.objectStore(META).get(ORDER_KEY) as IDBRequest<string[] | undefined>);
      const byId = new Map(all.map((c) => [c.id, c]));
      order = (storedOrder ?? []).filter((id) => byId.has(id));
      // Anything missing from the order record (an interrupted write) still
      // belongs in the list; put it after the known order, newest first.
      const extras = all
        .filter((c) => !order.includes(c.id))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((c) => c.id);
      order = [...order, ...extras];
      rows = order.map((id) => byId.get(id)!).filter(Boolean);
    }

    // Keep `persisted` pointing at the on-disk objects so the reconciled copies
    // returned below still diff as "changed" on the next save and actually get
    // written back - otherwise the fix-up would be redone (and re-rendered as
    // fresh) on every load instead of sticking.
    persisted = new Map(rows.map((c) => [c.id, c]));
    persistedOrder = rows.map((c) => c.id);
    return rows.map(reconcileInterruptedMessages);
  } catch {
    return [];
  } finally {
    db.close();
  }
}

async function writeConversations(conversations: Conversation[]): Promise<void> {
  const rows = persistable(conversations);
  const order = rows.map((c) => c.id);

  const changed = rows.filter((c) => persisted.get(c.id) !== c);
  const live = new Set(order);
  const removed = [...persisted.keys()].filter((id) => !live.has(id));
  const orderChanged =
    order.length !== persistedOrder.length || order.some((id, i) => persistedOrder[i] !== id);

  if (changed.length === 0 && removed.length === 0 && !orderChanged) return;

  const db = await openDb();
  try {
    const tx = db.transaction([STORE, META], "readwrite");
    const store = tx.objectStore(STORE);
    for (const convo of changed) store.put(convo);
    for (const id of removed) store.delete(id);
    if (orderChanged) tx.objectStore(META).put(order, ORDER_KEY);
    await done(tx);

    for (const convo of changed) persisted.set(convo.id, convo);
    for (const id of removed) persisted.delete(id);
    persistedOrder = order;
  } finally {
    db.close();
  }
}

const SAVE_DEBOUNCE_MS = 800;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingSave: Conversation[] | null = null;
/** Serializes writes so a flush during an in-flight save can't interleave. */
let writeChain: Promise<void> = Promise.resolve();

function enqueue(conversations: Conversation[]): Promise<void> {
  writeChain = writeChain.then(() => writeConversations(conversations)).catch(() => {
    /* a failed write is retried by the next save; never break the UI over it */
  });
  return writeChain;
}

/**
 * Called on every `conversations` state change - which during streaming is every
 * SSE token. Debounced to at most one write per SAVE_DEBOUNCE_MS of inactivity;
 * combined with the diff in `writeConversations`, a streaming reply costs one
 * record write rather than a full re-serialization of all history.
 */
export function saveConversations(conversations: Conversation[]): void {
  pendingSave = conversations;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (pendingSave) {
      void enqueue(pendingSave);
      pendingSave = null;
    }
  }, SAVE_DEBOUNCE_MS);
}

/**
 * Start any pending write immediately - call before the tab may disappear.
 *
 * IndexedDB is asynchronous, so unlike the old synchronous localStorage write
 * this cannot guarantee completion if the browser kills the page instantly.
 * It is called on `visibilitychange` (where the page normally stays alive long
 * enough) as well as on `pagehide`, and at most one debounce window is ever at
 * risk. Returns the write promise so callers can await it when they can.
 */
export function flushConversations(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (pendingSave) {
    const p = enqueue(pendingSave);
    pendingSave = null;
    return p;
  }
  return writeChain;
}

/** Remove every stored conversation (used by "delete all chats"). */
export async function clearConversations(): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction([STORE, META], "readwrite");
    tx.objectStore(STORE).clear();
    tx.objectStore(META).delete(ORDER_KEY);
    await done(tx);
    persisted.clear();
    persistedOrder = [];
  } finally {
    db.close();
  }
}

/** Rough on-disk usage, for the storage readout in Settings. */
export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  if (!navigator.storage?.estimate) return null;
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  return { usage, quota };
}
