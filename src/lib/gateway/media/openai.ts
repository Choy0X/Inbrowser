import type { CustomProxy, ProviderConnection } from "../../types";
import { GatewayError } from "../types";
import { providerFetch } from "../providerFetch";
import { extractError } from "../util";

function endpoint(connection: ProviderConnection, path: string): string {
  return `${connection.baseUrl.trim().replace(/\/+$/, "")}${path}`;
}

function authHeaders(connection: ProviderConnection, json: boolean): HeadersInit {
  const headers: Record<string, string> = {};
  if (json) headers["Content-Type"] = "application/json";
  if (connection.apiKey) headers.Authorization = `Bearer ${connection.apiKey}`;
  return headers;
}

interface RawMediaItem {
  b64_json?: string;
  url?: string;
}

function mediaUrl(item: RawMediaItem): string | null {
  if (item.b64_json) return `data:image/png;base64,${item.b64_json}`;
  if (item.url) return item.url;
  return null;
}

export async function generateImages(
  connection: ProviderConnection,
  modelId: string,
  options: { prompt: string; size?: string; n?: number; signal?: AbortSignal; proxy?: CustomProxy }
): Promise<string[]> {
  const res = await providerFetch(endpoint(connection, "/images/generations"), {
    method: "POST",
    headers: authHeaders(connection, true),
    body: JSON.stringify({
      model: modelId,
      prompt: options.prompt,
      ...(options.size ? { size: options.size } : {}),
      ...(options.n ? { n: options.n } : {}),
      response_format: "b64_json",
    }),
    signal: options.signal,
  }, options.proxy);
  const data = (await res.json().catch(() => ({}))) as { data?: RawMediaItem[] };
  const urls = (data.data ?? []).map(mediaUrl).filter((u): u is string => Boolean(u));
  if (urls.length === 0) throw new GatewayError(res.status, extractError(data) || "Image generation returned no image");
  return urls;
}

export async function editImage(
  connection: ProviderConnection,
  modelId: string,
  options: { prompt: string; image: string | File; signal?: AbortSignal; proxy?: CustomProxy }
): Promise<string[]> {
  const fd = new FormData();
  fd.append("prompt", options.prompt);
  fd.append("model", modelId);
  if (typeof options.image === "string") {
    const blob = await (await fetch(options.image)).blob();
    fd.append("image", blob, "image.png");
  } else {
    fd.append("image", options.image);
  }
  const res = await providerFetch(endpoint(connection, "/images/edits"), {
    method: "POST",
    headers: authHeaders(connection, false),
    body: fd,
    signal: options.signal,
  }, options.proxy);
  const data = (await res.json().catch(() => ({}))) as { data?: RawMediaItem[] };
  const urls = (data.data ?? []).map(mediaUrl).filter((u): u is string => Boolean(u));
  if (urls.length === 0) throw new GatewayError(res.status, extractError(data) || "Image edit returned no image");
  return urls;
}

export async function transcribeAudio(
  connection: ProviderConnection,
  modelId: string,
  file: Blob,
  name: string,
  proxy?: CustomProxy
): Promise<string> {
  const fd = new FormData();
  fd.append("file", file, name);
  fd.append("model", modelId);
  const res = await providerFetch(endpoint(connection, "/audio/transcriptions"), {
    method: "POST",
    headers: authHeaders(connection, false),
    body: fd,
  }, proxy);
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (typeof data.text === "string") return data.text;
  throw new GatewayError(res.status, extractError(data) || "Transcription returned no text");
}
