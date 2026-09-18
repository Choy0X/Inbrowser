import { Github, Info } from "lucide-react";
import { PageShell } from "./PageShell";
import { Section } from "./ui";
import { APP_NAME, APP_REPO_URL } from "../lib/appConfig";

/**
 * The credibility page. `SEO-STRATEGY.md` §6 names this the strongest available
 * signal for AI citation: the app has no company and no team to point to, so
 * the case for trusting it rests on what a visitor can check themselves rather
 * than on how official it sounds.
 */
export function AboutView() {
  return (
    <PageShell
      title="About InBrowser"
      icon={<Info size={24} className="shrink-0 text-accent" />}
      subtitle="An independent, open-source project - not a company."
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
      <div className="space-y-4">
        <Section title="Verify it, don't take it on faith">
          <p>
            Every claim this site makes about running locally, storing nothing on a server, and
            needing no account is checkable in the app itself: open DevTools, watch the network
            tab, and confirm no provider, search or model-weight request ever targets this site's
            own origin except the optional proxy relay a visitor configures themselves. The full
            source is public.
          </p>
          <ul className="mt-3 space-y-1">
            <li>
              <a
                href={APP_REPO_URL}
                target="_blank"
                rel="noreferrer"
                className="text-accent underline underline-offset-2 hover:text-accent/80"
              >
                {APP_REPO_URL.replace(/^https?:\/\//, "")}
              </a>
            </li>
          </ul>
        </Section>

        <Section title="What actually runs where">
          <p>
            Chat models, code execution, agents, skills and storage all run on the visitor's own
            device: local models on WebGPU, twelve language runtimes compiled to WebAssembly, and
            conversations kept in the browser's own IndexedDB. Hosted providers are called
            directly from the browser rather than through a shared server, so a rate limit applies
            per person instead of being exhausted by everyone at once.
          </p>
        </Section>

        <Section title="An independent project">
          <p>
            {APP_NAME} has no company, no trademark and no commercial backing - it is built and
            maintained as an open-source project. That is stated plainly here rather than implied
            otherwise, because the credibility this site asks for should rest on what can be
            inspected, not on how official it sounds.
          </p>
        </Section>
      </div>
    </PageShell>
  );
}
