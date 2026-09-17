import { useEffect, useMemo, useState } from "react";
import { Shuffle, Sparkles } from "lucide-react";
import { Mark } from "./Mark";
import { IconButton } from "./ui";
import { APP_NAME } from "../lib/appConfig";
import { fetchSuggestions, type Suggestion } from "../lib/suggestions";

/**
 * The chat empty state.
 *
 * There is deliberately NO suggestion copy in this file. Starter prompts come
 * from `GET /v1/suggestions`, which serves a pool the server regenerates once a
 * day; `src/lib/suggestions.ts` is the client half. Edit prompts in
 * `server/src/suggestions.ts`, which is also where the curated default lives.
 *
 * Everything above the grid renders synchronously and must keep doing so: `/`
 * is prerendered at build time (see lib/seo/routeTable.ts) and is the LCP
 * route, so the mark, the h1 and the tagline are in the static shell. Only the
 * grid below them is async, and it reserves its own height so the hero never
 * shifts when the cards land.
 */

/** Shown at once. The rest of the pool is what the shuffle button walks. */
const VISIBLE = 4;

export function Welcome({
  onPick,
  caps,
}: {
  onPick: (prompt: string) => void;
  /** Gates prompts the active model could not actually carry out. */
  caps: { vision: boolean; toolCalling: boolean; reasoning: boolean };
}) {
  const [pool, setPool] = useState<Suggestion[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [offset, setOffset] = useState(0);

  // Depend on the three booleans rather than `caps`: modelCapabilities() builds
  // a fresh object on every render, so an object dependency would refetch in a
  // loop.
  const { vision, toolCalling, reasoning } = caps;

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    fetchSuggestions({ vision, toolCalling, reasoning }, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setPool(next);
        setOffset(0);
        setLoading(false);
      })
      .catch(() => {
        // fetchSuggestions already swallows its own failures; this is only
        // reachable if it is ever changed to reject.
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [vision, toolCalling, reasoning]);

  const visible = useMemo(() => {
    if (!pool || pool.length === 0) return [];
    return Array.from({ length: Math.min(VISIBLE, pool.length) }, (_, i) => pool[(offset + i) % pool.length]);
  }, [pool, offset]);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col items-center px-4 pt-12 pb-6">
      <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent text-on-accent">
        <Mark size={24} />
      </div>
      <h1 className="mt-4 font-display text-3xl font-normal tracking-[-0.02em]">{APP_NAME}</h1>
      <p className="mt-1 text-center text-sm text-fg-dim">
        The whole AI stack, in one tab. Models that run on your own device, code that runs
        in your browser, and agents that work on their own. No account, no API key.
      </p>

      {loading ? (
        <SuggestionSkeleton />
      ) : visible.length > 0 ? (
        <>
          <div className="mt-8 flex w-full items-center justify-between">
            <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-fg-faint">
              Try something
            </span>
            {pool && pool.length > VISIBLE ? (
              <IconButton
                label="Show other suggestions"
                size="sm"
                icon={<Shuffle size={14} />}
                // Walks the pool the server already shuffled today. No refetch:
                // the endpoint would return the same set until tomorrow.
                onClick={() => setOffset((current) => current + VISIBLE)}
              />
            ) : null}
          </div>

          <div className="mt-3 grid w-full grid-cols-1 gap-3 sm:grid-cols-2">
            {visible.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => onPick(s.prompt)}
                className="group rounded-xl border border-border bg-bg-elevated p-4 text-left transition-colors hover:bg-bg-hover"
              >
                <span className="flex items-center gap-1.5 text-sm font-medium">
                  <Sparkles size={13} className="text-accent" />
                  {s.title}
                </span>
                <span className="mt-1 line-clamp-2 block text-xs leading-5 text-fg-faint">{s.prompt}</span>
              </button>
            ))}
          </div>
        </>
      ) : null}
      {/*
        Nothing renders where the grid would be when there are no suggestions:
        no server (a CDN-only build), offline with an empty cache, or
        client.suggestionsEnabled turned off. An empty bordered box would read
        as broken; the hero alone reads as intentional.
      */}
    </div>
  );
}

/**
 * Matches a real card's box exactly - same border, radius, padding and the two
 * text rows - so the hero does not jump when the cards arrive.
 */
function SuggestionSkeleton() {
  return (
    <>
      <div className="mt-8 flex w-full items-center justify-between">
        <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-fg-faint">
          Try something
        </span>
      </div>
      <div aria-hidden className="mt-3 grid w-full grid-cols-1 gap-3 sm:grid-cols-2">
        {Array.from({ length: VISIBLE }, (_, i) => (
          <div key={i} className="rounded-xl border border-border bg-bg-elevated p-4">
            <div className="h-5 w-1/2 animate-pulse rounded bg-bg-hover" />
            <div className="mt-2 h-3 w-full animate-pulse rounded bg-bg-hover" />
            <div className="mt-1.5 h-3 w-4/5 animate-pulse rounded bg-bg-hover" />
          </div>
        ))}
      </div>
    </>
  );
}
