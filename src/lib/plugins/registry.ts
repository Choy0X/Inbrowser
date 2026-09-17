import { javascriptPlugin } from "./javascriptPlugin";
import { pythonPlugin } from "./pythonPlugin";
import { phpPlugin } from "./phpPlugin";
import { rubyPlugin } from "./rubyPlugin";
import { rPlugin } from "./rPlugin";
import { cPlugin, cppPlugin } from "./clangPlugin";
import { LANGUAGE_PLUGINS } from "./languagePlugins";
import type { Plugin } from "./types";

export type { Plugin } from "./types";

/**
 * JavaScript, Python, PHP, Ruby, R and C/C++ keep bespoke installers (each
 * fetches its own self-hosted asset manifest into Cache Storage); everything
 * else comes from languagePlugins.ts, where a runtime is one spec entry plus a
 * worker.
 *
 * cppPlugin and cPlugin deliberately share the id "cpp" - they are one engine
 * and one download behind two languages, and BY_LANGUAGE below is keyed by
 * language, so each dialect still reaches its own worker. See clangPlugin.ts.
 */
export const PLUGINS: Plugin[] = [
  javascriptPlugin,
  pythonPlugin,
  phpPlugin,
  rubyPlugin,
  rPlugin,
  cppPlugin,
  cPlugin,
  ...LANGUAGE_PLUGINS,
];

/** Language id -> plugin, built once instead of scanned per lookup. */
const BY_LANGUAGE = new Map<string, Plugin>();
for (const plugin of PLUGINS) {
  for (const language of plugin.languages) BY_LANGUAGE.set(language, plugin);
}

export function getPluginForLanguage(language: string | undefined): Plugin | undefined {
  return language ? BY_LANGUAGE.get(language.toLowerCase()) : undefined;
}
