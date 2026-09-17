import type { CustomProxy, ProviderConnection } from "../../types";
import { GatewayError } from "../types";
import { providerFetch } from "../providerFetch";
import { extractError } from "../util";

function base(connection: ProviderConnection): string {
  return connection.baseUrl.trim().replace(/\/+$/, "");
}

function authHeaders(connection: ProviderConnection): HeadersInit {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (connection.apiKey) headers["x-goog-api-key"] = connection.apiKey;
  return headers;
}

export async function generateImages(
  connection: ProviderConnection,
  modelId: string,
  options: { prompt: string; n?: number; signal?: AbortSignal; proxy?: CustomProxy }
): Promise<string[]> {
  const res = await providerFetch(`${base(connection)}/models/${modelId}:predict`, {
    method: "POST",
    headers: authHeaders(connection),
    body: JSON.stringify({
      instances: [{ prompt: options.prompt }],
      parameters: { sampleCount: options.n ?? 1 },
    }),
    signal: options.signal,
  }, options.proxy);
  const data = (await res.json().catch(() => ({}))) as {
    predictions?: { bytesBase64Encoded?: string; mimeType?: string }[];
  };
  const urls = (data.predictions ?? [])
    .filter((p) => p.bytesBase64Encoded)
    .map((p) => `data:${p.mimeType || "image/png"};base64,${p.bytesBase64Encoded}`);
  if (urls.length === 0) throw new GatewayError(res.status, extractError(data) || "Image generation returned no image");
  return urls;
}

const VIDEO_POLL_INTERVAL_MS = 5000;
const VIDEO_POLL_TIMEOUT_MS = 5 * 60 * 1000;

function extractVideoUrls(payload: unknown): string[] {
  const urls: string[] = [];
  const obj = payload as Record<string, unknown> | undefined;
  const generateVideoResponse = obj?.generateVideoResponse as Record<string, unknown> | undefined;
  const samples =
    (generateVideoResponse?.generatedSamples as Array<Record<string, unknown>> | undefined) ??
    (obj?.generatedSamples as Array<Record<string, unknown>> | undefined) ??
    [];
  for (const sample of samples) {
    const video = sample.video as Record<string, unknown> | undefined;
    const uri = video?.uri ?? video?.videoUri ?? sample.uri;
    if (typeof uri === "string" && uri) urls.push(uri);
    const b64 = video?.bytesBase64Encoded ?? sample.bytesBase64Encoded;
    if (typeof b64 === "string" && b64) urls.push(`data:video/mp4;base64,${b64}`);
  }
  return urls;
}

/**
 * Video generation via Veo is asynchronous (predictLongRunning + operation
 * polling), unlike every other media endpoint here. Polls in-browser with a
 * bounded timeout rather than surfacing a raw "queued" error, since the
 * relay is a plain per-request pipe with no server-side job tracking.
 */
export async function generateVideo(
  connection: ProviderConnection,
  modelId: string,
  options: { prompt: string; signal?: AbortSignal; proxy?: CustomProxy }
): Promise<string[]> {
  const startRes = await providerFetch(
    `${base(connection)}/models/${modelId}:predictLongRunning`,
    {
      method: "POST",
      headers: authHeaders(connection),
      body: JSON.stringify({ instances: [{ prompt: options.prompt }] }),
      signal: options.signal,
    },
    options.proxy
  );
  const startData = (await startRes.json().catch(() => ({}))) as { name?: string };
  if (!startData.name) {
    throw new GatewayError(startRes.status, extractError(startData) || "Video generation did not return an operation");
  }

  const deadline = Date.now() + VIDEO_POLL_TIMEOUT_MS;
  for (;;) {
    if (options.signal?.aborted) throw new GatewayError(0, "Video generation cancelled");
    await new Promise((resolve) => setTimeout(resolve, VIDEO_POLL_INTERVAL_MS));
    // Same proxy as the start call, deliberately: the operation was created
    // from that egress IP and polling it from another one can 404.
    const pollRes = await providerFetch(
      `${base(connection)}/${startData.name}`,
      { method: "GET", headers: authHeaders(connection), signal: options.signal },
      options.proxy
    );
    const pollData = (await pollRes.json().catch(() => ({}))) as {
      done?: boolean;
      response?: unknown;
      error?: unknown;
    };
    if (pollData.error) {
      throw new GatewayError(pollRes.status, extractError(pollData) || "Video generation failed");
    }
    if (pollData.done) {
      const urls = extractVideoUrls(pollData.response);
      if (urls.length === 0) throw new GatewayError(200, "Video generation finished but returned no video");
      return urls;
    }
    if (Date.now() > deadline) {
      throw new GatewayError(202, "Video generation is taking longer than expected; try again shortly.");
    }
  }
}
