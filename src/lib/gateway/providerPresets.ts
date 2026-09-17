/**
 * Provider presets for direct browser access or an explicitly configured proxy.
 * Free/keyless claims apply to eligible models, not an entire mixed catalog.
 * Proxy-required providers must never silently fall back to a direct request.
 * Research and live checks: KEYLESS_PROVIDERS.md.
 */
import type { ProviderFormat } from "../types";

export type PresetCategory = "inference" | "inference-keyed" | "local";

export interface ProviderPreset {
  id: string;
  label: string;
  format: ProviderFormat;
  baseUrl: string;
  aliasSuggestion: string;
  starterModels: string[];
  category: PresetCategory;
  /** True when the provider offers real, ongoing free-tier access (not just a signup credit). */
  hasFree?: boolean;
  /** True when no API key is required at all (e.g. a public free endpoint). */
  keyless?: boolean;
  /** True when EVERY model in the catalog is optionally-authed, not just some (see keyless). */
  keylessUniform?: boolean;
  /** Runs in this browser: no network, no key, no rate limit. See gateway/local/. */
  local?: boolean;
  /** Shown under the preset in the picker when it needs hardware/browser support. */
  requirement?: string;
  /** Browser responses lack CORS; requires the user's selected proxy. */
  requiresProxy?: boolean;
}

export const CUSTOM_PRESET_ID = "custom";

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "kilo-gateway",
    label: "Kilo Gateway",
    format: "openai",
    baseUrl: "https://api.kilo.ai/api/gateway",
    aliasSuggestion: "kilo",
    starterModels: ["kilo-auto/free"],
    category: "inference",
    hasFree: true,
    keyless: true,
    requiresProxy: true,
    requirement: "Requires a configured proxy. Free models vary; prompts may be logged by upstream providers.",
    // https://kilo.ai/docs/getting-started/using-kilo-for-free
    // Anonymous discovery exposes only entries with isFree: true.
  },
  {
    id: "blockrun",
    label: "BlockRun Free",
    format: "openai",
    baseUrl: "https://blockrun.ai/api/v1",
    aliasSuggestion: "br",
    starterModels: ["nvidia/nemotron-3.5-lightning", "cohere/north-mini-code"],
    category: "inference",
    hasFree: true,
    keyless: true,
    requiresProxy: true,
    requirement: "Requires a configured proxy. Only the free model pool needs no key or wallet.",
    // https://blockrun.ai/free - filter billing_mode: free, not paid wallet routes.
  },
  {
    id: "vireonix",
    label: "Vireonix",
    format: "openai",
    baseUrl: "https://vireonix.ai/v1",
    aliasSuggestion: "vx",
    starterModels: ["auto"],
    category: "inference",
    hasFree: true,
    keyless: true,
    keylessUniform: true,
    requiresProxy: true,
    requirement: "Requires a configured proxy. Auto selects the model; hourly limits apply.",
    // https://vireonix.ai/docs - auto is its only public model ID.
  },
  {
    id: "kouzi",
    label: "KouziAI (community)",
    format: "openai",
    baseUrl: "https://kouzi--9af6501c44f211f1a04a42b51c65c3df.web.val.run/v1",
    aliasSuggestion: "kouzi",
    starterModels: ["codestral-latest"],
    category: "inference",
    hasFree: true,
    keyless: true,
    requirement: "Community gateway. Free model availability can change; no service guarantee.",
    // Landing page documents this public API. Anonymous catalog: tier: turbo.
  },
  {
    id: "ovhcloud-ai",
    label: "OVHcloud AI Endpoints",
    format: "openai",
    baseUrl: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1",
    aliasSuggestion: "ovh",
    starterModels: ["gpt-oss-120b", "Meta-Llama-3_3-70B-Instruct", "Qwen3-32B"],
    category: "inference",
    // Verified live: a real chat completion succeeds with zero Authorization
    // header. OVHcloud's own docs describe this as an intentional anonymous
    // tier (2 req/min per IP per model; a real OVHcloud key raises that to
    // 400 req/min) — every model here is optionally-authed, not a mixed
    // free/paid catalog like OpenCode.
    hasFree: true,
    keyless: true,
    keylessUniform: true,
  },
  {
    id: "uncloseai",
    label: "Uncloseai",
    format: "openai",
    baseUrl: "https://hermes.ai.unturf.com/v1",
    aliasSuggestion: "unc",
    starterModels: [],
    category: "inference",
    // Verified live: a real chat completion succeeds with zero auth. Unlike
    // the other presets here this is an individually-run box, not a
    // company — its single hosted model rotates and it may not be as
    // durable/available as the others.
    hasFree: true,
    keyless: true,
    keylessUniform: true,
  },
  {
    id: "pollinations",
    label: "Pollinations AI",
    format: "openai",
    baseUrl: "https://text.pollinations.ai/openai",
    aliasSuggestion: "pol",
    starterModels: ["openai"],
    category: "inference",
    // Verified live via text.pollinations.ai/models: the default model
    // ("openai-fast", aliased "openai") is tagged tier:"anonymous" — no key,
    // no signup, no login required. Anonymous requests are rate-limited to
    // ~1 req/15s; an optional free account at auth.pollinations.ai raises
    // that but isn't required for real usage.
    hasFree: true,
    keyless: true,
  },
  {
    id: "llm7",
    label: "LLM7.io",
    format: "openai",
    baseUrl: "https://api.llm7.io/v1",
    aliasSuggestion: "l7",
    starterModels: ["gpt-oss", "codestral-latest", "mistral-Nemo-Instruct-2407"],
    category: "inference",
    // Verified live: GET /v1/models returns 46 models, 41 tagged tier:"pro"
    // (paid — a completion against one of these 401s "Missing API key." with
    // no key) and 5 tagged tier:"turbo" (e.g. "gpt-oss", "codestral-latest",
    // "gemma4:31b", "minimax-m2.7", "mistral-Nemo-Instruct-2407") — a real
    // chat completion against a turbo-tier id succeeds with zero
    // Authorization header. Mixed catalog like OpenCode/Kilo Gateway, not
    // uniformly keyless. Anonymous requests are rate-limited (~10-30 RPM per
    // third-party reports); an optional free token from token.llm7.io raises
    // the limit but isn't required for real usage.
    hasFree: true,
    keyless: true,
  },
  {
    id: "aihorde",
    label: "AI Horde",
    format: "openai",
    baseUrl: "https://oai.aihorde.net/v1",
    aliasSuggestion: "horde",
    starterModels: [],
    category: "inference",
    // Documented OpenAI-compatible REST proxy in front of AI Horde's
    // crowdsourced volunteer-GPU network (oai.aihorde.net). Anonymous
    // requests use AI Horde's own documented "anonymous key" literal
    // ("0000000000", lowest queue priority) — it now must be sent explicitly
    // (a fully header-less request 401s "Authorization header missing", a
    // change from when this preset was first verified); adapters/openai.ts's
    // authHeaders() sends it automatically whenever this connection has no
    // real user key configured, so this still needs zero setup in practice.
    // An optional free aihorde.net key only buys higher priority. Throughput
    // is a shared queue, not a quota —
    // jobs can take minutes when the network is busy, tool calling isn't
    // supported, and the model catalog is worker-dependent (changes as
    // volunteers join/leave), so rely on auto-discovery rather than a fixed
    // starter list.
    hasFree: true,
    keyless: true,
  },
  {
    id: "airforce",
    label: "Api.Airforce",
    format: "openai",
    baseUrl: "https://api.airforce/v1",
    aliasSuggestion: "af",
    starterModels: ["gpt-oss-20b", "gpt-oss-120b", "glm-4.7-flash"],
    category: "inference-keyed",
    // Not keyless: needs a free account (no card) at api.airforce, whose Free
    // plan is a genuine standing $0/month tier (1 RPM / 1,000 req/day,
    // "access to basic models"), not a signup credit that runs out. Verified
    // live: OPTIONS preflight AND a real chat completion sent with no
    // Authorization header both carry `Access-Control-Allow-Origin` for a
    // browser origin — including on the resulting 401, so the browser can
    // even surface the "missing API key" error itself. GET /v1/models lists
    // 28 chat models tagged tier:"free"; the per-token prices shown there are
    // the pay-as-you-go reference price, not what a Free-plan account is
    // billed. A real account key is still needed to confirm an authenticated
    // completion against a free-tier model succeeds end-to-end.
    hasFree: true,
  },
  // ---------------------------------------------------------------- local
  // Models that run inside the browser. These matter disproportionately: only
  // hosted keyless providers rate-limit requests, so a
  // model with no key, no quota and no network is both the largest source of
  // free models here (WebLLM ships 160+) and the natural fallback when the
  // hosted providers start refusing. They also make the app work fully offline.
  {
    id: "webllm",
    label: "Local models (WebGPU)",
    format: "local",
    baseUrl: "local://webllm",
    aliasSuggestion: "local",
    starterModels: ["Llama-3.2-1B-Instruct-q4f32_1-MLC", "Qwen2.5-1.5B-Instruct-q4f16_1-MLC"],
    category: "local",
    hasFree: true,
    keyless: true,
    keylessUniform: true,
    local: true,
    requirement: "Needs WebGPU (Chrome or Edge 113+). Weights download once, then run offline.",
  },
  {
    id: "chrome-ai",
    label: "Chrome built-in AI",
    format: "local",
    baseUrl: "local://chrome-ai",
    aliasSuggestion: "nano",
    starterModels: ["gemini-nano"],
    category: "local",
    hasFree: true,
    keyless: true,
    keylessUniform: true,
    local: true,
    requirement: "Needs Chrome 138+ with the built-in Gemini Nano model. Nothing to download.",
  },
];

/** Match exact origins and path boundaries, including endpoints beneath a base. */
export function providerPresetForUrl(value: string): ProviderPreset | undefined {
  try {
    const url = new URL(value);
    return PROVIDER_PRESETS.find(p => {
      const base = new URL(p.baseUrl);
      const path = base.pathname.replace(/\/+$/, "");
      return url.origin === base.origin && (url.pathname === path || url.pathname.startsWith(`${path}/`));
    });
  } catch { return undefined; }
}
