/**
 * Some providers (especially free/experimental ones) occasionally fail to
 * strip their own chat-template special tokens from the response — e.g.
 * DeepSeek's `<｜end▁of▁sentence｜>` or ChatML's `<|im_end|>` leaking into
 * visible content instead of just ending the turn. Strip these known
 * raw-tokenizer artifacts defensively; real prose/code essentially never
 * contains a pipe-delimited marker in this exact shape.
 */
export function stripLeakedSpecialTokens(text: string): string {
  return text.replace(/<｜[^｜<>]{1,40}｜>|<\|[a-zA-Z0-9_]{1,40}\|>/g, "");
}

export function extractError(payload: unknown): string | null {
  if (payload && typeof payload === "object") {
    const p = payload as Record<string, unknown>;
    const err = p.error;
    if (err && typeof err === "object") {
      const e = err as Record<string, unknown>;
      if (typeof e.message === "string") return e.message;
    }
    if (typeof err === "string") return err;
    if (typeof p.message === "string") return p.message;
  }
  return null;
}

/**
 * Turns a non-2xx/non-stream response body into a clean error message.
 * Shared by every adapter's "this response isn't what I expected" path
 * (openaiChunks.ts, adapters/anthropic.ts, adapters/gemini.ts) so a
 * provider that returns an HTML auth/redirect/maintenance page instead of
 * JSON doesn't get its raw markup dumped verbatim as the error text.
 * `malformed: true` flags exactly that case — the auto-router (routingEngine.ts)
 * treats it as a stronger failure signal than an ordinary API error.
 */
/** 401/403 is unambiguous regardless of what the body looks like — no need to
 *  hedge with "likely" when the status code already says exactly what's wrong. */
function authFailureMessage(status: number): string {
  return `Authentication failed (HTTP ${status}) — check this connection's API key`;
}

const PAYMENT_REQUIRED_PATTERN =
  /\b402\b|payment required|insufficient (credit|balance|funds)|billing (issue|error|required)|active subscription|pay-as-you-go|positive balance|requires (a |an )?(paid|premium|pro) (plan|subscription|tier)|upgrade (your|to a) (plan|subscription)|top up (your|an?) (balance|account)/i;

/** Some providers wrap a genuine payment/billing rejection in a non-auth
 *  status (e.g. Pollinations returning HTTP 500 with body text "402 Payment
 *  Required") instead of a clean 401/403. This only inspects the message
 *  text, independent of status code, so it still counts as "this model
 *  needs something we don't have" for the caller's keyRequired exclusion. */
export function looksLikePaymentRequired(message: string): boolean {
  return PAYMENT_REQUIRED_PATTERN.test(message);
}

/**
 * Reads the standard `Retry-After` response header (RFC 9110 §10.2.3), which
 * a well-behaved API sets on a 429/503 to say exactly how long to back off —
 * either an integer number of seconds, or an HTTP-date. Returns milliseconds,
 * or undefined when the header is absent/unparseable — the caller decides
 * what to do then (this never invents a duration itself; rate-limit windows
 * are entirely provider-specific and not something this app can guess).
 */
export function parseRetryAfterMs(res: Response): number | undefined {
  const raw = res.headers.get("retry-after");
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const asDate = Date.parse(trimmed);
  if (!Number.isNaN(asDate)) {
    const deltaMs = asDate - Date.now();
    return deltaMs > 0 ? deltaMs : undefined;
  }
  return undefined;
}

export function parseErrorMessage(raw: string, status: number): { message: string; malformed: boolean } {
  if (status === 401 || status === 403) {
    // Prefer a real upstream message when there is one (e.g. SambaNova's
    // detailed "you didn't provide an API key..." text) — only fall back to
    // the generic confident message when the body doesn't give us anything.
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        const message = extractError(Array.isArray(parsed) ? parsed[0] : parsed);
        if (message) return { message, malformed: false };
      } catch {
        /* not JSON — fall through to the generic auth message below */
      }
    }
    return { message: authFailureMessage(status), malformed: true };
  }
  if (!raw) return { message: `HTTP ${status}`, malformed: false };
  try {
    const parsed = JSON.parse(raw);
    const message = extractError(Array.isArray(parsed) ? parsed[0] : parsed);
    // A 5xx is the upstream's own server failing, not a request-shaped
    // problem — cleanly-formatted JSON doesn't make it any more likely to
    // succeed on an immediate retry against the same model. Treat it as a
    // hard failure too (same as an unparseable body) so the auto-router
    // excludes it fast instead of waiting for several recent failures to
    // accumulate.
    return { message: message || `HTTP ${status}`, malformed: status >= 500 };
  } catch {
    const looksLikeHtml = /^\s*<(!doctype|html)/i.test(raw);
    return {
      message: looksLikeHtml
        ? `Non-JSON response from provider (HTTP ${status}) — likely a redirect or maintenance page`
        : `HTTP ${status}: ${raw.trim().slice(0, 160)}`,
      malformed: true,
    };
  }
}
