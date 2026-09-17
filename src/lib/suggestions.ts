/**
 * Starter prompts for the chat empty state.
 *
 * This module deliberately contains NO prompt copy. The list lives on the
 * server (`server/src/suggestions.ts`), which refreshes it once a day and ships
 * a curated default underneath. That is the one place to edit a suggestion, and
 * `verify:layout` asserts no suggestion array reappears in Welcome.tsx.
 *
 * WHAT LEAVES THE BROWSER. A day part ("morning") and up to three capability
 * booleans, as query parameters. No identifier, no chat content, no history,
 * not even a date. The day part is sent because only the browser knows the
 * user's local hour; the capabilities are sent so a text-only model is never
 * offered an image prompt it would fail.
 *
 * This is the only first-party API call the client makes on an ordinary page
 * load, and `client.suggestionsEnabled: false` in config.json removes it - see
 * the architecture note in CLAUDE.md.
 */
import { APP_RELAY_URL, SUGGESTIONS_ENABLED } from "./appConfig";
import type { ModelCapabilities } from "./capabilities";

/**
 * Only the three flags that reach the server. Narrower than ModelCapabilities
 * on purpose: the caller can then pass three primitive booleans as effect
 * dependencies instead of an object that is rebuilt on every render.
 */
export type SuggestionCaps = Pick<ModelCapabilities, "vision" | "toolCalling" | "reasoning">;

export interface Suggestion {
  id: string;
  title: string;
  prompt: string;
}

interface CachedSuggestions {
  /** Capability bucket the cached set was fetched for; a change invalidates it. */
  capsKey: string;
  suggestions: Suggestion[];
}

const KEY = "fachoy:suggestions:v1";

/**
 * Local hour -> the day part the server filters on. Boundaries are ordinary
 * rather than clever: the point is that an evening visitor sees wind-down
 * prompts instead of "plan the day", not that 17:00 is meaningfully different
 * from 17:01.
 */
export function dayPart(now = new Date()): string {
  const hour = now.getHours();
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  if (hour < 22) return "evening";
  return "night";
}

function capsKeyFor(caps: SuggestionCaps): string {
  return [caps.vision ? "v" : "", caps.toolCalling ? "t" : "", caps.reasoning ? "r" : ""].join("");
}

/**
 * The deployment's own server, never the user's configured proxy relay.
 *
 * `getRelayUrl()` in gateway/proxy/relay.ts intentionally honours the user's
 * override, because that is a proxy they chose to route provider traffic
 * through. Suggestions are not provider traffic, and pointing them at a
 * third-party relay would tell that relay when this browser opens the app. So
 * this reads the deployment default directly: empty means same origin, and a
 * CDN build with an absolute `client.relayUrl` still resolves correctly.
 */
function endpoint(caps: SuggestionCaps): string {
  const base = APP_RELAY_URL.trim().replace(/\/+$/, "");
  const params = new URLSearchParams({ part: dayPart() });
  if (caps.vision) params.set("vision", "1");
  if (caps.toolCalling) params.set("tools", "1");
  if (caps.reasoning) params.set("reasoning", "1");
  return `${base}/v1/suggestions?${params.toString()}`;
}

function loadCache(capsKey: string): Suggestion[] | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CachedSuggestions>;
    if (parsed?.capsKey !== capsKey || !Array.isArray(parsed.suggestions)) return null;
    return parsed.suggestions.length > 0 ? parsed.suggestions : null;
  } catch {
    return null;
  }
}

function saveCache(capsKey: string, suggestions: Suggestion[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ capsKey, suggestions } satisfies CachedSuggestions));
  } catch {
    /* quota or a privacy mode that refuses storage - the feature works without it */
  }
}

/** Drops anything malformed rather than rendering a blank card. */
function usable(value: unknown): Suggestion[] | null {
  if (!Array.isArray(value)) return null;
  const out = value.filter(
    (s): s is Suggestion =>
      Boolean(s) &&
      typeof (s as Suggestion).id === "string" &&
      typeof (s as Suggestion).title === "string" &&
      typeof (s as Suggestion).prompt === "string" &&
      (s as Suggestion).title.length > 0 &&
      (s as Suggestion).prompt.length > 0
  );
  return out.length > 0 ? out : null;
}

/**
 * The day's suggestions, or null when there is nothing worth rendering.
 *
 * Returns null rather than a fallback array on purpose: there is no client-side
 * default list to fall back to, so Welcome omits the grid entirely instead of
 * showing an empty box. A previously cached set is used when the fetch fails,
 * which covers an offline reload; a first visit with no server (a CDN-only
 * deployment) legitimately has nothing to show.
 */
export async function fetchSuggestions(
  caps: SuggestionCaps,
  signal?: AbortSignal
): Promise<Suggestion[] | null> {
  const capsKey = capsKeyFor(caps);
  if (!SUGGESTIONS_ENABLED) return null;

  try {
    const res = await fetch(endpoint(caps), { signal });
    if (!res.ok) return loadCache(capsKey);

    const body = (await res.json()) as { suggestions?: unknown };
    const suggestions = usable(body?.suggestions);
    if (!suggestions) return loadCache(capsKey);

    saveCache(capsKey, suggestions);
    return suggestions;
  } catch {
    // Offline, blocked, aborted, or a deployment with no server at all.
    return loadCache(capsKey);
  }
}
