import type { ProviderConnection, ProviderPluginModel } from "../../types";
import type { AdapterChatArgs, AdapterCompleteArgs } from "../types";

/**
 * A local inference backend: a model that runs inside this browser, with no
 * network call, no API key and no rate limit.
 *
 * Each runtime is addressed by a `local://<id>` base URL on a normal
 * ProviderConnection, so local models flow through the same routing, failover,
 * capability indexing and tool loop as any hosted provider (see
 * adapters/local.ts).
 */
export interface LocalRuntime {
  id: string;
  label: string;
  /** Whether this device can run the runtime at all (WebGPU present, etc.). */
  available(): boolean;
  /** Shown in the UI when `available()` is false. */
  unavailableReason(): string;
  listModels(): Promise<ProviderPluginModel[]>;
  streamChat(args: AdapterChatArgs): Promise<void>;
  completeChat(args: AdapterCompleteArgs): Promise<string>;
  /** Release any resident model (GPU memory). */
  unload(): Promise<void>;
}

/** The scheme that marks a connection as local rather than networked. */
export const LOCAL_SCHEME = "local://";

export function isLocalBaseUrl(baseUrl: string): boolean {
  return baseUrl.trim().toLowerCase().startsWith(LOCAL_SCHEME);
}

export function runtimeIdFromBaseUrl(baseUrl: string): string {
  return baseUrl.trim().toLowerCase().slice(LOCAL_SCHEME.length).replace(/\/+$/, "");
}

export function localBaseUrl(runtimeId: string): string {
  return `${LOCAL_SCHEME}${runtimeId}`;
}

export function isLocalConnection(connection: ProviderConnection): boolean {
  return connection.format === "local" || isLocalBaseUrl(connection.baseUrl);
}
