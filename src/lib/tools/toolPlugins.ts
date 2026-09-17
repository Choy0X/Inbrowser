import type { ToolDef } from "../gateway/types";
import type { ToolHandler } from "./types";
import { registerTool, unregisterTool } from "./registry";
import { getPluginState, loadPluginStates } from "../pluginStore";

/**
 * Tool plugins: small utilities the model can call.
 *
 * The plumbing for these already existed and was never connected -
 * `registerTool` was declared but called from nowhere, and the `worker-tool`
 * executor wrote source into Cache Storage that nothing read back, so a tool
 * plugin had no name, no parameters, and could never be offered to a model.
 * This is the missing loader.
 *
 * First-party tools are plain functions loaded through one dynamic import, so
 * they cost nothing until enabled and cannot fail the way sandbox-loading a
 * script can. Third-party tools would go through the worker sandbox instead.
 */

export interface ToolPluginSpec {
  id: string;
  name: string;
  description: string;
  tags: string[];
  def: ToolDef;
  run(args: Record<string, unknown>): Promise<string> | string;
}

/** Registered tool ids, so a disabled plugin can be withdrawn cleanly. */
const active = new Set<string>();

function toHandler(spec: ToolPluginSpec): ToolHandler {
  return {
    id: spec.id,
    group: "plugin",
    def: spec.def,
    applies: () => true,
    async run(args) {
      try {
        return await spec.run(args);
      } catch (err) {
        return `${spec.name} failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

/**
 * Register every enabled tool plugin and withdraw the rest. Safe to call
 * repeatedly - the store calls it after each install, uninstall or toggle.
 */
export async function syncToolPlugins(): Promise<void> {
  const states = loadPluginStates();
  const { TOOL_PLUGINS } = await import("./toolCatalog");

  for (const spec of TOOL_PLUGINS) {
    const state = getPluginState(states, spec.id);
    const shouldRun = state.installed && state.enabled;
    if (shouldRun && !active.has(spec.id)) {
      registerTool(toHandler(spec));
      active.add(spec.id);
    } else if (!shouldRun && active.has(spec.id)) {
      unregisterTool(spec.id);
      active.delete(spec.id);
    }
  }
}

/** Ids of the tool plugins, for the store catalogue. */
export async function toolPluginSpecs(): Promise<ToolPluginSpec[]> {
  const { TOOL_PLUGINS } = await import("./toolCatalog");
  return TOOL_PLUGINS;
}
