import { registerSW } from "virtual:pwa-register";

let updateSW: ((reload?: boolean) => Promise<void>) | null = null;

/**
 * Registers the service worker with `registerType: "prompt"` (see
 * pwaPlugin() in vite.config.ts): a new build installs and waits rather than
 * silently taking over. `onNeedRefresh` only reports the state change - it
 * never applies the update itself, so the user always decides. Detection
 * relies entirely on the browser's own SW revalidation on page load/
 * navigation; there is deliberately no polling for an open tab.
 */
export function startUpdateChecker(onNeedRefresh: () => void): void {
  updateSW = registerSW({ onNeedRefresh });
}

export function applyUpdate(): void {
  void updateSW?.(true);
}
