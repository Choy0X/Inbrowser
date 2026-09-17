/**
 * Theme mode.
 *
 * InBrowser has one design system (Terminal Ink, authored in styles.css) and
 * one independent axis: light or dark. There used to be a second axis — a
 * choice of eight "skins," seven of them borrowed design systems users could
 * switch to in Settings — but restructuring the app's own components for
 * this redesign would have meant restructuring markup all eight skins
 * shared, so that picker is gone. See git history before this change if that
 * system is ever needed again.
 */

const THEME_COLOR_LIGHT = "#FFFFFF";
const THEME_COLOR_DARK = "#010120";

/** Keep mobile browser chrome in step with the active mode. */
export function applyThemeColor(mode: "light" | "dark"): void {
  if (typeof document === "undefined") return;
  const color = mode === "dark" ? THEME_COLOR_DARK : THEME_COLOR_LIGHT;
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.appendChild(meta);
  }
  meta.content = color;
}
