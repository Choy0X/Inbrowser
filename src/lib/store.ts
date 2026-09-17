/**
 * UI state and id generation. Conversation persistence moved to IndexedDB -
 * see convostore.ts, which is re-exported here so existing imports keep working.
 */
export {
  loadConversations,
  saveConversations,
  flushConversations,
  clearConversations,
  storageEstimate,
} from "./convostore";

const UI_KEY = "fachoy:ui:v1";

export type ThemeMode = "system" | "light" | "dark";

export interface UiState {
  sidebarCollapsed: boolean;
  theme: ThemeMode;
  defaultSearchEnabled: boolean;
}

const DEFAULT_UI: UiState = {
  sidebarCollapsed: false,
  theme: "system",
  defaultSearchEnabled: false,
};

export function loadUi(): UiState {
  try {
    const raw = localStorage.getItem(UI_KEY);
    if (raw) return { ...DEFAULT_UI, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_UI };
}

export function saveUi(ui: UiState): void {
  try {
    localStorage.setItem(UI_KEY, JSON.stringify(ui));
  } catch {
    /* ignore */
  }
}

/**
 * `crypto.randomUUID()` only exists in secure contexts (HTTPS, or the page's
 * own `localhost`) — it's `undefined` when InBrowser is opened over plain HTTP
 * from another device's IP on the LAN, which throws synchronously and aborts
 * whatever action (e.g. sending a message) triggered an id. `getRandomValues`
 * has no such restriction, so build a v4 UUID from it as the fallback.
 */
export function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}