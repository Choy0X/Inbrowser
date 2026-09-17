import type { ProviderConnection } from "../../types";
import { getSettings, saveSettings } from "../../onniroute";
import { PROVIDER_PRESETS } from "../providerPresets";
import { localBaseUrl, runtimeIdFromBaseUrl, isLocalConnection } from "./runtime";

/**
 * Publishing an installed local model to the model picker.
 *
 * Installing a model from the store used to do only half the job: it
 * downloaded the weights into Cache Storage and recorded the id in the
 * installed set, which is what the store's Installed/Uninstall state reads.
 * But the chat model list is built from configured *connections*
 * (`modelsFromProviders` in onniroute.ts walks `connection.models`), and
 * nothing here ever touched those. So a freshly installed model was on disk,
 * shown as installed, and absent from the picker - with no way to select it.
 *
 * Two separate reasons it could not appear, both handled below:
 *   1. No local connection existed at all, because adding one is a manual step
 *      in Settings > Providers that installing a model never implied.
 *   2. Even with a connection, its `models` array was whatever the preset
 *      seeded at add-time, so a model installed later was not in it.
 *
 * The connection is the app's own local runtime, not a third-party endpoint:
 * there is no key, no host and nothing to configure, so creating it on demand
 * is bookkeeping rather than a decision made on the user's behalf.
 */

/** The only local runtime with downloadable weights; Chrome's built-in model
 *  has nothing to install. */
const RUNTIME_ID = "webllm";

/** Fired after the provider connections change, so the model list can reload. */
export const PROVIDERS_CHANGED_EVENT = "fachoy:providers-changed";

function announce(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(PROVIDERS_CHANGED_EVENT));
}

function connectionFor(providers: ProviderConnection[], runtimeId: string): ProviderConnection | undefined {
  return providers.find((p) => isLocalConnection(p) && runtimeIdFromBaseUrl(p.baseUrl) === runtimeId);
}

/** A fresh connection for a local runtime, seeded from that runtime's preset. */
function createConnection(runtimeId: string, existing: ProviderConnection[]): ProviderConnection {
  const preset = PROVIDER_PRESETS.find((p) => p.id === runtimeId);
  const taken = new Set(existing.map((p) => p.alias));
  let alias = preset?.aliasSuggestion ?? runtimeId;
  for (let n = 2; taken.has(alias); n++) alias = `${preset?.aliasSuggestion ?? runtimeId}${n}`;

  return {
    id: `local-${runtimeId}-${Date.now().toString(36)}`,
    alias,
    label: preset?.label ?? `Local models (${runtimeId})`,
    format: "local",
    baseUrl: preset?.baseUrl ?? localBaseUrl(runtimeId),
    apiKey: "",
    // Deliberately empty: only models the user has actually installed are
    // added, so the picker never offers weights that are not on disk.
    models: [],
    enabled: true,
  };
}

/**
 * Make an installed local model selectable, creating the runtime's connection
 * if this is the first model installed for it.
 */
export function registerLocalModel(
  runtimeId: string,
  modelId: string,
  name?: string,
  contextLength?: number
): void {
  if (!modelId) return;
  const settings = getSettings();
  const providers = [...settings.providers];

  let connection = connectionFor(providers, runtimeId);
  if (!connection) {
    connection = createConnection(runtimeId, providers);
    providers.push(connection);
  }

  const index = providers.indexOf(connection);
  const models = [...connection.models];
  const at = models.findIndex((m) => m.id === modelId);
  if (at === -1) {
    models.push({ id: modelId, name, contextLength, enabled: true });
  } else if (models[at].enabled === false || (contextLength && !models[at].contextLength)) {
    models[at] = { ...models[at], enabled: true, contextLength: models[at].contextLength ?? contextLength };
  } else {
    // Already listed and enabled; re-enabling the connection below is still
    // worth doing in case the user had switched it off.
    if (connection.enabled) return;
  }

  providers[index] = { ...connection, models, enabled: true };
  saveSettings({ ...settings, providers });
  announce();
}

/**
 * Publish every already-installed local model that is not in the picker yet.
 *
 * Registering on install fixes this going forward, but anything installed
 * before that existed is still on disk, still recorded as installed, and still
 * missing from the picker - and reinstalling a multi-gigabyte model to fix
 * bookkeeping is not a reasonable thing to ask. This reconciles the two on
 * startup and is a no-op once they agree.
 */
export function syncInstalledLocalModels(installed: Iterable<string>): void {
  const ids = [...installed];
  if (ids.length === 0) return;

  const settings = getSettings();
  const connection = connectionFor(settings.providers, RUNTIME_ID);
  const listed = new Set(connection?.models.map((m) => m.id) ?? []);
  const missing = ids.filter((id) => !listed.has(id));
  if (missing.length === 0) return;

  for (const id of missing) registerLocalModel(RUNTIME_ID, id);
}

/** Drop an uninstalled model from the picker, leaving the connection in place. */
export function unregisterLocalModel(runtimeId: string, modelId: string): void {
  if (!modelId) return;
  const settings = getSettings();
  const providers = [...settings.providers];
  const connection = connectionFor(providers, runtimeId);
  if (!connection) return;

  const models = connection.models.filter((m) => m.id !== modelId);
  if (models.length === connection.models.length) return;

  providers[providers.indexOf(connection)] = { ...connection, models };
  saveSettings({ ...settings, providers });
  announce();
}
