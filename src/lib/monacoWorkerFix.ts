/**
 * vite-plugin-monaco-editor injects `window.MonacoEnvironment.getWorkerUrl`
 * via a head-prepend <script> (node_modules/vite-plugin-monaco-editor/dist/
 * index.js) and bundles Monaco's worker chunks in IIFE format - meant for
 * classic, `importScripts`-based workers. But monaco-editor 0.56's own
 * worker-loading always constructs `new Worker(url, {type: "module"})` and
 * dynamically `import()`s it, appending a `?vscode-coi=N` query param
 * whenever `self.crossOriginIsolated` is true (true in this app since the
 * interactive-stdin feature added Cross-Origin-Embedder-Policy - see
 * vite.config.ts and server/src/app.ts). That ESM path can never load the plugin's
 * IIFE-format bundles - the mismatch was latent (COI.addSearchParam is a
 * no-op when not isolated) until isolation turned it on, then failed with
 * "Failed to fetch dynamically imported module: blob:...#editorWorkerService".
 *
 * monaco-editor's worker service checks `MonacoEnvironment.getWorker()`
 * *before* falling through to that ESM/COI path (see
 * node_modules/monaco-editor/esm/vs/editor/standalone/browser/services/
 * standaloneWebWorkerService.js's `_createWorker`). Supplying one here - a
 * classic (non-module) Worker built from the exact same URL `getWorkerUrl`
 * already resolves - skips the broken path entirely, independent of
 * isolation state, without giving up the interactive-stdin feature.
 *
 * Must run before Monaco itself first spawns a worker: import this module
 * for its side effect as early as possible (main.tsx), well before either
 * lazy Monaco import site (ArtifactPanel.tsx, SkillFiles.tsx) can resolve.
 */

interface MonacoEnvironmentLike {
  getWorkerUrl?: (moduleId: string, label: string) => string;
  getWorker?: (moduleId: string, label: string) => Worker;
}

const env = (window as unknown as { MonacoEnvironment?: MonacoEnvironmentLike }).MonacoEnvironment;

if (env?.getWorkerUrl && !env.getWorker) {
  const getWorkerUrl = env.getWorkerUrl;
  env.getWorker = (moduleId: string, label: string) => new Worker(getWorkerUrl(moduleId, label), { name: label });
}
