import { useEffect, useId, useState } from "react";

/** Loaded once and reused - mermaid's own module cache does the same, but this
 * avoids a repeat dynamic import() for every diagram on the page. */
let mermaidPromise: Promise<typeof import("mermaid")> | null = null;
function loadMermaid() {
  if (!mermaidPromise) mermaidPromise = import("mermaid");
  return mermaidPromise;
}

function isDarkTheme(): boolean {
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr === "dark") return true;
  if (attr === "light") return false;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

/** Re-renders callers when the app's light/dark mode changes. */
function useIsDarkTheme(): boolean {
  const [dark, setDark] = useState(isDarkTheme);
  useEffect(() => {
    const update = () => setDark(isDarkTheme());
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    media?.addEventListener("change", update);
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      media?.removeEventListener("change", update);
      observer.disconnect();
    };
  }, []);
  return dark;
}

/** Renders a ```mermaid fenced code block as a diagram, falling back to the
 * raw source (in a code block) when the diagram text doesn't parse - which
 * is also what shows while `streaming` is true, since a diagram that's
 * still being typed out can't parse as anything meaningful yet and
 * re-attempting on every token would just flicker between the diagram and
 * a "Rendering…" placeholder. */
export function MermaidDiagram({ code, streaming }: { code: string; streaming?: boolean }) {
  const rawId = useId().replace(/[^a-zA-Z0-9]/g, "");
  const dark = useIsDarkTheme();
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (streaming) return;
    let cancelled = false;
    setSvg(null);
    setError(null);
    void loadMermaid().then(async ({ default: mermaid }) => {
      try {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: dark ? "dark" : "default",
          fontFamily: "inherit",
        });
        const { svg: rendered } = await mermaid.render(`mermaid-${rawId}`, code);
        if (!cancelled) setSvg(rendered);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to render diagram");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [code, dark, rawId, streaming]);

  if (streaming || error) {
    return (
      <pre data-ui="code-block" className="code-block">
        <code>{code}</code>
      </pre>
    );
  }
  if (!svg) {
    return <div className="mermaid-loading">Rendering diagram…</div>;
  }
  // securityLevel: "strict" (set above) runs mermaid's own DOMPurify pass over
  // the SVG before it's returned, so this is safe against a diagram label
  // that embeds HTML/script - the string here is already sanitized.
  return <div className="mermaid-diagram" dangerouslySetInnerHTML={{ __html: svg }} />;
}
