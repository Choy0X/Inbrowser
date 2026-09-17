import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Download, Loader2, Pause, Plus, X } from "lucide-react";
import { Dialog } from "./Dialog";
import { Tooltip } from "./Tooltip";
import { Button } from "./ui";
import type { CustomProxy } from "../lib/types";
import { FREE_PROXY_SOURCES } from "../lib/gateway/freeProxySources";
import { mergeProxyLists, parseProxyList, proxyKey } from "../lib/gateway/freeProxyList";
import {
  checkFreeProxyCandidates,
  buildFreeProxyExportPayload,
  type FreeProxyCheckResult,
} from "../lib/gateway/freeProxyScan";

const CONCURRENCY = 8;

/**
 * How many working proxies to find before pausing.
 *
 * Public lists carry thousands of entries and the overwhelming majority are
 * dead. At roughly 12s per check with 8 in flight, working through a few hundred
 * is many minutes, and nobody waits for that - so the scan stops once it has
 * found enough to be useful and offers to carry on.
 */
const STOP_AFTER_ALIVE = 20;

type Phase = "loading" | "scanning" | "paused" | "done";

interface FreeProxyFinderModalProps {
  open: boolean;
  onClose: () => void;
  /** Used to grey out Add for a proxy already in the pool. */
  draftProxies: CustomProxy[];
  onAddProxy: (proxy: CustomProxy) => void;
  /** Unsaved relay override, so the finder tests against the same relay Settings shows. */
  relayUrl?: string;
  allowInsecureProxyTls?: boolean;
}

export function FreeProxyFinderModal({
  open,
  onClose,
  draftProxies,
  onAddProxy,
  relayUrl,
  allowInsecureProxyTls,
}: FreeProxyFinderModalProps) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [candidates, setCandidates] = useState<CustomProxy[]>([]);
  const [results, setResults] = useState<FreeProxyCheckResult[]>([]);
  const [addedKeys, setAddedKeys] = useState<Set<string>>(new Set());
  const [sourceErrors, setSourceErrors] = useState<string[]>([]);
  const [inFlight, setInFlight] = useState(0);
  const controllerRef = useRef<AbortController | null>(null);

  const existingKeys = useMemo(() => new Set(draftProxies.map(proxyKey)), [draftProxies]);

  /** Scans a slice of the candidate pool, streaming results in as they settle. */
  const runScan = useCallback(
    async (pool: CustomProxy[], startIndex: number) => {
      const controller = new AbortController();
      controllerRef.current?.abort();
      controllerRef.current = controller;

      const slice = pool.slice(startIndex);
      if (slice.length === 0) {
        setPhase("done");
        return;
      }

      setPhase("scanning");
      setInFlight(slice.length);
      let settled = 0;
      let alive = 0;

      for await (const result of checkFreeProxyCandidates(slice, controller.signal, {
        concurrency: CONCURRENCY,
        stopAfterAlive: STOP_AFTER_ALIVE,
        relayUrl,
        allowInsecureProxyTls,
      })) {
        if (controller.signal.aborted) return;
        settled++;
        if (result.status === "alive") alive++;
        setResults((r) => [...r, result]);
      }

      if (controller.signal.aborted) return;
      setInFlight(0);
      // Distinguishing these matters: "done" means the pool is exhausted and
      // there is nothing left to offer, "paused" means we stopped early and
      // there is more to try.
      setPhase(startIndex + settled >= pool.length ? "done" : alive > 0 ? "paused" : "done");
    },
    [relayUrl, allowInsecureProxyTls]
  );

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setPhase("loading");
    setResults([]);
    setAddedKeys(new Set());
    setSourceErrors([]);
    setCandidates([]);

    void (async () => {
      const lists: CustomProxy[][] = [];
      const errors: string[] = [];

      // Sources are fetched straight from the browser: jsDelivr sends ACAO *,
      // so no relay is involved in getting the lists - only in testing them.
      await Promise.all(
        FREE_PROXY_SOURCES.map(async (source) => {
          try {
            const res = await fetch(source.url, { signal: controller.signal });
            if (!res.ok) {
              errors.push(`${source.label}: HTTP ${res.status}`);
              return;
            }
            lists.push(parseProxyList(await res.text(), source.protocol, source.label));
          } catch (err) {
            if (controller.signal.aborted) return;
            errors.push(`${source.label}: ${err instanceof Error ? err.message : "failed"}`);
          }
        })
      );

      if (controller.signal.aborted) return;
      const pool = mergeProxyLists(lists, draftProxies);
      setCandidates(pool);
      setSourceErrors(errors);
      if (pool.length === 0) {
        setPhase("done");
        return;
      }
      void runScan(pool, 0);
    })();

    return () => {
      controller.abort();
      controllerRef.current?.abort();
    };
    // draftProxies is read once to seed the dedupe set; re-running on every
    // keystroke in the pool behind the modal would restart the scan.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, runScan]);

  const counts = useMemo(
    () => ({
      alive: results.filter((r) => r.status === "alive").length,
      dead: results.filter((r) => r.status === "dead").length,
    }),
    [results]
  );

  const aliveRows = useMemo(() => results.filter((r) => r.status === "alive"), [results]);

  /** Failed strict TLS verification against the provider - likely MITMing, not just dead. */
  const tlsUnverifiedRows = useMemo(
    () => results.filter((r) => r.status === "dead" && r.code === "provider_tls_unverified"),
    [results]
  );

  const handleAdd = (proxy: CustomProxy) => {
    onAddProxy(proxy);
    setAddedKeys((s) => new Set(s).add(proxyKey(proxy)));
  };

  /** Adds a TLS-unverified candidate only with the explicit opt-in set - never silently. */
  const handleAddUnverified = (proxy: CustomProxy) => {
    onAddProxy({ ...proxy, allowInsecureTls: true });
    setAddedKeys((s) => new Set(s).add(proxyKey(proxy)));
  };

  /**
   * Pauses in place: the "paused" phase already exists for the auto-stop-after
   * finding enough case, and its "Resume" action (continue from results.length)
   * works identically regardless of why the scan stopped, so a manual pause
   * just reuses it rather than introducing a parallel state.
   */
  const handlePause = () => {
    controllerRef.current?.abort();
    setInFlight(0);
    setPhase("paused");
  };

  /** Unlike pause, abandons the scan entirely rather than leaving it resumable. */
  const handleCancel = () => {
    controllerRef.current?.abort();
    onClose();
  };

  const runExport = (scope: "all" | "alive" | "dead") => {
    const payload = buildFreeProxyExportPayload(results, scope);
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `free-proxies-${scope}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Dialog open={open} onClose={onClose} title="Find free proxies" size="xl" closeOnOverlay>
      <div>
        <p className="mb-3 text-xs leading-5 text-fg-faint">
          Public proxy lists, tested end to end through the relay. Most public proxies are dead or
          slow at any given moment - this is a way to try a lot of them quickly, not a sign that
          they are good. A proxy you control will be far more reliable.
        </p>

        {allowInsecureProxyTls && (
          <p className="mb-3 text-xs leading-5 text-warning">
            Unverified connections are allowed for all proxies. Certificate verification is off for these tests.
          </p>
        )}

        {sourceErrors.length > 0 && (
          <p className="mb-3 rounded-xl border border-warning/30 bg-warning/10 p-2 text-[11px] leading-5 text-warning">
            {sourceErrors.length} of {FREE_PROXY_SOURCES.length} sources did not load:{" "}
            {sourceErrors.join("; ")}
          </p>
        )}

        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs text-fg-dim">
            {phase === "loading" ? (
              <span className="flex items-center gap-1 text-fg-faint">
                <Loader2 size={12} className="animate-spin" /> Loading lists...
              </span>
            ) : (
              <>
                <span className="text-success">{counts.alive} working</span>{" "}
                <span className="text-fg-faint">
                  · {counts.dead} dead · {candidates.length} found
                </span>
                {phase === "scanning" && inFlight > 0 && <> · testing...</>}
              </>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            {phase === "scanning" && (
              <>
                <button
                  type="button"
                  onClick={handlePause}
                  className="flex items-center gap-1 rounded-lg border border-border bg-canvas px-2 py-1 text-[11px] font-medium hover:bg-bg-hover"
                >
                  <Pause size={11} /> Pause
                </button>
                <button
                  type="button"
                  onClick={handleCancel}
                  className="flex items-center gap-1 rounded-lg border border-border bg-canvas px-2 py-1 text-[11px] font-medium hover:bg-bg-hover"
                >
                  <X size={11} /> Cancel
                </button>
              </>
            )}
            {(["all", "alive", "dead"] as const).map((scope) => (
              <button
                key={scope}
                type="button"
                onClick={() => runExport(scope)}
                disabled={results.length === 0}
                className="flex items-center gap-1 rounded-lg border border-border bg-canvas px-2 py-1 text-[11px] font-medium hover:bg-bg-hover disabled:opacity-40"
              >
                <Download size={11} /> Export {scope}
              </button>
            ))}
          </div>
        </div>

        <div className="max-h-[55vh] space-y-1 overflow-y-auto">
          {aliveRows.map((row) => (
            <FreeProxyRow
              key={proxyKey(row.proxy)}
              result={row}
              alreadyInPool={existingKeys.has(proxyKey(row.proxy)) || addedKeys.has(proxyKey(row.proxy))}
              onAdd={handleAdd}
            />
          ))}

          {aliveRows.length === 0 && phase !== "loading" && (
            <p className="rounded-xl border border-dashed border-border-subtle bg-canvas p-4 text-center text-xs text-fg-faint">
              {phase === "scanning"
                ? "Testing proxies - working ones appear here as they are found."
                : "None of the proxies tested so far are working."}
            </p>
          )}

          {tlsUnverifiedRows.length > 0 && (
            <div className="mt-2 space-y-1">
              <p className="px-1 text-[11px] font-medium uppercase tracking-[0.06em] text-warning">
                Unverified - likely intercepting traffic
              </p>
              {tlsUnverifiedRows.map((row) => (
                <TlsUnverifiedProxyRow
                  key={proxyKey(row.proxy)}
                  result={row}
                  alreadyInPool={existingKeys.has(proxyKey(row.proxy)) || addedKeys.has(proxyKey(row.proxy))}
                  onAdd={handleAddUnverified}
                />
              ))}
            </div>
          )}
        </div>

        {(phase === "paused" || (phase === "done" && results.length < candidates.length)) && (
          <div className="mt-3 flex items-center justify-between gap-2 rounded-xl border border-border-subtle bg-canvas p-3">
            <p className="text-xs text-fg-dim">
              Stopped after {counts.alive} working {counts.alive === 1 ? "proxy" : "proxies"}.{" "}
              {candidates.length - results.length} untested.
            </p>
            <div className="flex items-center gap-1.5">
              <Button size="sm" variant="ghost" onClick={handleCancel}>
                Cancel
              </Button>
              <Button size="sm" variant="secondary" onClick={() => void runScan(candidates, results.length)}>
                Resume
              </Button>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}

const FreeProxyRow = memo(function FreeProxyRow({
  result,
  alreadyInPool,
  onAdd,
}: {
  result: FreeProxyCheckResult;
  alreadyInPool: boolean;
  onAdd: (proxy: CustomProxy) => void;
}) {
  const { proxy } = result;
  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-border-subtle bg-canvas px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-xs">
          {proxy.protocol}://{proxy.host}:{proxy.port}
        </div>
        <div className="truncate text-[11px] text-fg-faint">
          {proxy.source}
          {proxy.exitIp && <> · exits from {proxy.exitIp}</>}
        </div>
      </div>
      <div className="w-24 shrink-0 text-xs">
        <Tooltip label={`Round trip through the relay and this proxy`}>
          <span className="flex items-center gap-1 text-success">
            <Check size={12} /> {result.result?.latencyMs} ms
          </span>
        </Tooltip>
      </div>
      <button
        type="button"
        onClick={() => onAdd(proxy)}
        disabled={alreadyInPool}
        className="flex shrink-0 items-center gap-1 rounded-lg border border-border bg-canvas px-2 py-1 text-[11px] font-medium hover:bg-bg-hover disabled:opacity-40"
      >
        {alreadyInPool ? <Check size={11} /> : <Plus size={11} />}
        {alreadyInPool ? "Added" : "Add"}
      </button>
    </div>
  );
});

/**
 * A candidate that failed strict TLS verification against the provider - it
 * likely intercepted (MITMed) the connection rather than passing it through,
 * which is why it's shown separately from plain dead proxies with an explicit
 * warning, never auto-added.
 */
const TlsUnverifiedProxyRow = memo(function TlsUnverifiedProxyRow({
  result,
  alreadyInPool,
  onAdd,
}: {
  result: FreeProxyCheckResult;
  alreadyInPool: boolean;
  onAdd: (proxy: CustomProxy) => void;
}) {
  const { proxy } = result;
  return (
    <div className="flex flex-col gap-1.5 rounded-xl border border-warning/30 bg-warning/10 px-3 py-2">
      <div className="flex items-center gap-2.5">
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-xs">
            {proxy.protocol}://{proxy.host}:{proxy.port}
          </div>
          <div className="truncate text-[11px] text-fg-faint">{proxy.source}</div>
        </div>
        <button
          type="button"
          onClick={() => onAdd(proxy)}
          disabled={alreadyInPool}
          className="flex shrink-0 items-center gap-1 rounded-lg border border-warning/40 bg-canvas px-2 py-1 text-[11px] font-medium text-warning hover:bg-bg-hover disabled:opacity-40"
        >
          {alreadyInPool ? <Check size={11} /> : <Plus size={11} />}
          {alreadyInPool ? "Added" : "Add anyway (unverified)"}
        </button>
      </div>
      <p className="text-[11px] leading-5 text-warning">
        Allow this proxy even though its connection to providers can't be verified as secure. If
        enabled, this proxy's operator could potentially read your API keys and messages.
      </p>
    </div>
  );
});
