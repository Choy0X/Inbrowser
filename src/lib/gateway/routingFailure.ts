import { GatewayError } from "./types";

/** Attribute a failure to the component that can actually fix it. */
export function routingFailure(error: unknown, proxied: boolean) {
  const status = error instanceof GatewayError ? error.status : undefined;
  const code = error instanceof GatewayError ? error.code : undefined;
  const message = error instanceof Error ? error.message : String(error);
  const relayFailure = Boolean(code && /^(relay_|origin_not_allowed|rate_limited$|worker_rate_limited$|dial_decrypt_failed$|dial_rejected$|target_not_allowed$|cap_exceeded$|malformed_request$|body_too_large$)/.test(code));
  const transportFailure = !relayFailure && (status === 0 || error instanceof TypeError ||
    Boolean(code && /^(proxy_|tunnel_|socks_|handshake_failed$)/.test(code)));
  const explicitAuth = status === 401 || /(?:api.?key|authentication|credentials|subscription|payment|balance)/i.test(message);
  const routeFailure = proxied && !relayFailure && !transportFailure &&
    (status === 403 && !explicitAuth || error instanceof GatewayError && error.malformed ||
      Boolean(code && /^(provider_|upstream_|idle_timeout$)/.test(code)));
  return {
    rotateProxy: proxied && (transportFailure || routeFailure),
    proxyFailure: proxied && (transportFailure || routeFailure),
    targetOnly: routeFailure,
    modelFailure: !relayFailure && !transportFailure && !routeFailure,
    connectionFailure: !proxied && transportFailure || !relayFailure && (status === 401 || status === 429 ||
      status === 503 && error instanceof GatewayError && error.retryAfterMs !== undefined),
    stop: relayFailure,
  };
}
