import { useEffect, useState } from "react";

/**
 * Whether the app is currently in dark mode, tracked live.
 *
 * Extracted from MermaidDiagram so ChartBlock can share it: both draw into
 * something that is NOT styled by CSS - mermaid injects a themed SVG string,
 * Chart.js paints a canvas - so neither restyles on its own when the theme
 * changes. They have to re-render, which means they need this as state rather
 * than as a class name.
 *
 * Two sources, because the theme has two: the explicit `data-theme` the app
 * writes, and the OS preference it falls back to.
 */
export function isDarkTheme(): boolean {
  // Guarded so the hook can be rendered outside a browser - the verify scripts
  // render real components through react-dom/server, and an unguarded document
  // access here would take the whole pass down.
  if (typeof document === "undefined") return false;
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr === "dark") return true;
  if (attr === "light") return false;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

/** Re-renders callers when the app's light/dark mode changes. */
export function useIsDarkTheme(): boolean {
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
