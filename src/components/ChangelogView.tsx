import { useEffect, useState } from "react";
import { Github, Sparkles } from "lucide-react";
import { PageShell } from "./PageShell";
import { Mark } from "./Mark";
import { APP_NAME, APP_REPO_URL } from "../lib/appConfig";
import { fetchChangelog, installedEntries, pendingEntries, type ChangelogEntry } from "../lib/changelog";

export function ChangelogView({ onRequestUpdate }: { onRequestUpdate: () => void }) {
  const [entries, setEntries] = useState<ChangelogEntry[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchChangelog(true).then((data) => {
      if (!cancelled) setEntries(data);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const installed = entries ? installedEntries(entries, __APP_VERSION__) : null;
  const pending = entries ? pendingEntries(entries, __APP_VERSION__) : [];

  return (
    <PageShell
      title="Change logs"
      icon={<Sparkles size={24} className="shrink-0 text-accent" />}
      subtitle={`Everything shipped in ${APP_NAME}, newest first.`}
      actions={
        <a
          href={APP_REPO_URL}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm text-fg-dim transition-colors hover:bg-bg-hover hover:text-fg"
        >
          <Github size={16} />
          View source
        </a>
      }
    >
      <div className="relative isolate mb-8 overflow-hidden rounded-2xl border border-border bg-bg-elevated">
        <div className="brand-gradient-wash" aria-hidden />
        <div className="relative flex items-center gap-4 p-6">
          <Mark size={40} className="shrink-0 text-accent" />
          <div>
            <p className="text-xs uppercase tracking-[0.08em] text-fg-faint">You're running</p>
            <p className="font-mono text-xl font-medium">v{__APP_VERSION__}</p>
          </div>
        </div>
      </div>

      {pending.length > 0 && (
        <div className="mb-8 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-accent/30 bg-accent/5 p-4">
          <p className="text-sm text-fg-dim">
            Update available - <span className="font-mono text-fg">v{pending[0].version}</span> is ready to
            install.
          </p>
          <button
            type="button"
            onClick={onRequestUpdate}
            className="shrink-0 rounded-md bg-accent px-3 py-1.5 font-mono text-xs font-medium uppercase tracking-[0.06em] text-on-accent transition-colors hover:bg-accent-hover"
          >
            Update now
          </button>
        </div>
      )}

      {installed === null ? (
        <p className="text-sm text-fg-dim">Loading...</p>
      ) : installed.length === 0 ? (
        <div className="rounded-2xl border border-border-subtle bg-bg-elevated/40 p-8 text-center">
          <p className="text-sm text-fg-dim">No releases yet.</p>
        </div>
      ) : (
        <ol className="relative space-y-8 border-l border-border pl-6">
          {installed.map((entry, i) => (
            <li key={entry.version} className="relative">
              <span className="absolute -left-[29px] top-1 h-3 w-3 rounded-full border-2 border-canvas bg-accent" />
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="rounded-full bg-accent/10 px-2.5 py-0.5 font-mono text-xs font-medium text-accent">
                  v{entry.version}
                </span>
                <span className="text-xs text-fg-faint">{entry.date}</span>
                {i === 0 && (
                  <span className="rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-success">
                    Latest
                  </span>
                )}
              </div>
              <ul className="mt-2 list-disc space-y-1 pl-4 text-sm text-fg-dim">
                {entry.items.map((item, j) => (
                  <li key={j}>{item}</li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </PageShell>
  );
}
