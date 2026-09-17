const PLUGINS_KEY = "fachoy:plugins:v1";

export interface PluginState {
  installed: boolean;
  enabled: boolean;
}

export type PluginStateMap = Record<string, PluginState>;

const DEFAULTS: PluginStateMap = {
  javascript: { installed: true, enabled: true },
  python: { installed: false, enabled: false },
};

export function loadPluginStates(): PluginStateMap {
  try {
    const raw = localStorage.getItem(PLUGINS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return { ...DEFAULTS, ...parsed };
    }
  } catch {
    /* ignore */
  }
  return { ...DEFAULTS };
}

export function savePluginStates(states: PluginStateMap): void {
  try {
    localStorage.setItem(PLUGINS_KEY, JSON.stringify(states));
  } catch {
    /* ignore */
  }
}

export function getPluginState(states: PluginStateMap, pluginId: string): PluginState {
  return states[pluginId] ?? { installed: false, enabled: false };
}
