import { PageShell } from "./PageShell";

/**
 * What fills `<main>` while a lazily-loaded route page is fetched.
 *
 * Shaped like a real page rather than a spinner, and rendered through the same
 * PageShell every route uses, so the header lands in its final position the
 * first time and swapping the real page in shifts nothing. A bare centred
 * spinner would cost a layout shift on every first visit to a section, which is
 * a Core Web Vitals regression traded for the code-splitting win.
 */
export function RouteFallback() {
  return (
    <PageShell title="Loading" subtitle="One moment.">
      <div className="space-y-3" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-20 animate-pulse border border-border-subtle bg-bg-subtle" />
        ))}
      </div>
    </PageShell>
  );
}
