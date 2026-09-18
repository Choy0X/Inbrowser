/**
 * Sealing and opening the dial frame.
 *
 * THIS FILE IS A TWIN of `server/src/crypto.ts`; see the note at the top of
 * protocol.ts. It uses only WebCrypto, which Node 18+ and workerd both expose
 * as `globalThis.crypto.subtle`, so one implementation serves both sides and
 * there is no chance of the two disagreeing about key derivation.
 *
 * Why the dial is encrypted rather than merely signed: it carries the user's
 * proxy credentials. A signature would authenticate the VPS to the Worker but
 * leave those credentials readable by anything that records the WebSocket
 * handshake - including Cloudflare itself. AES-256-GCM gives authentication
 * (the tag is a MAC over the whole payload) and confidentiality in one pass, so
 * the Worker both proves the dial came from a holder of RELAY_SECRET and is
 * itself unable to read the credentials it is dialling with... except insofar
 * as it must decrypt them to use them. The property that actually holds is the
 * narrower one: nobody on the path between VPS and Worker can read them, and
 * nobody without RELAY_SECRET can forge a dial, which is what keeps a publicly
 * reachable Worker from being an open relay.
 */
import {
  DIAL_MAX_AGE_MS,
  IV_BYTES,
  decodeDialFrame,
  encodeDialFrame,
  type DialRequest,
} from "./protocol.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Domain separation, so the same secret could safely derive other keys later. */
const HKDF_INFO = encoder.encode("inbrowser-relay-dial-v1");

/** The "later" the line above anticipated. Separate label, same secret. */
const BUCKET_INFO = encoder.encode("inbrowser-relay-bucket-v1");

/** Derived keys, by secret. See deriveDialKey below for why this exists. */
const dialKeyCache = new Map<string, Promise<CryptoKey>>();

/**
 * HKDF-SHA256 over RELAY_SECRET. No salt: the secret is already high-entropy
 * (the deploy docs specify `openssl rand -hex 32`) and a fixed empty salt keeps
 * both sides derivable from the secret alone, with no extra value to distribute.
 *
 * Memoized, because the secret is process-constant and this was running two
 * WebCrypto operations on every single dial. The cache holds the PROMISE, not
 * the resolved key, so concurrent callers arriving before the first derivation
 * settles share it instead of each starting their own - which is the common
 * case under load, and the whole point. A rejection is evicted rather than
 * cached: the only way this throws is a secret that fails the length check,
 * which is deterministic, but a sticky rejected promise would be a miserable
 * thing to debug if that ever stopped being true.
 *
 * Keyed by secret rather than kept in a single slot so a process using more
 * than one (the test suites do) stays correct.
 */
export function deriveDialKey(secret: string): Promise<CryptoKey> {
  const cached = dialKeyCache.get(secret);
  if (cached) return cached;
  const pending = deriveDialKeyUncached(secret);
  dialKeyCache.set(secret, pending);
  pending.catch(() => dialKeyCache.delete(secret));
  return pending;
}

async function deriveDialKeyUncached(secret: string): Promise<CryptoKey> {
  if (!secret || secret.length < 32) {
    throw new Error("RELAY_SECRET must be at least 32 characters. Generate one with: openssl rand -hex 32");
  }
  const material = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: HKDF_INFO },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/** Seals a dial into a complete frame, ready to be sent as WebSocket frame 0. */
export async function sealDial(key: CryptoKey, dial: DialRequest): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plaintext = encoder.encode(JSON.stringify(dial));
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return encodeDialFrame(iv, new Uint8Array(sealed));
}

/**
 * Opens and validates a dial frame. Throws on a bad tag, a malformed frame, a
 * non-object payload, or a stale timestamp - the caller maps any throw to
 * RelayClose.DIAL_DECRYPT_FAILED without distinguishing which, deliberately, so
 * the Worker is not an oracle for why a forgery attempt failed.
 */
export async function openDial(key: CryptoKey, frame: Uint8Array, now = Date.now()): Promise<DialRequest> {
  const { iv, ciphertext } = decodeDialFrame(frame);
  // decodeDialFrame returns subarrays, which TypeScript widens to
  // Uint8Array<ArrayBufferLike>; WebCrypto's BufferSource wants an ArrayBuffer
  // specifically, since a SharedArrayBuffer view would be a data race. These
  // never are one - copying makes that true by construction rather than by
  // assertion, and a dial is at most 4 KiB.
  const opened = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(iv) },
    key,
    new Uint8Array(ciphertext)
  );
  const parsed: unknown = JSON.parse(decoder.decode(new Uint8Array(opened)));
  if (!parsed || typeof parsed !== "object") throw new Error("Dial payload is not an object");
  const dial = parsed as DialRequest;
  if (typeof dial.ts !== "number" || !Number.isFinite(dial.ts)) throw new Error("Dial has no timestamp");
  // Absolute value: a clock skewed into the future is as suspect as a replay.
  if (Math.abs(now - dial.ts) > DIAL_MAX_AGE_MS) throw new Error("Dial timestamp is outside the accepted window");
  return dial;
}

/** Derived bucket keys, by secret. Same reasoning as dialKeyCache above. */
const bucketKeyCache = new Map<string, Promise<CryptoKey>>();

function bucketKey(secret: string): Promise<CryptoKey> {
  const cached = bucketKeyCache.get(secret);
  if (cached) return cached;
  const pending = (async () => {
    const material = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: BUCKET_INFO },
      material,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
  })();
  bucketKeyCache.set(secret, pending);
  pending.catch(() => bucketKeyCache.delete(secret));
  return pending;
}

/**
 * An opaque per-user rate-limit bucket, carried inside the sealed dial.
 *
 * The Worker cannot rate-limit per user on its own: every dial reaches it from
 * this one machine, so keying on the connecting address makes its limit a
 * single global budget for the whole platform rather than a per-user one. This
 * gives it something to key on that it cannot forge (the dial is sealed) and
 * cannot resolve to a person from anything it observes (it never sees an
 * address).
 *
 * Derived from RELAY_SECRET rather than a per-process salt. That is what makes
 * it identical across every cluster worker and across restarts - a per-process
 * salt would give one user a different bucket per worker, multiplying their
 * real ceiling by the worker count and making it depend on which worker
 * happened to take the connection.
 *
 * Not rotated, deliberately. Rotation cannot merge buckets here: the verifier
 * is a counter keyed on an opaque string, with no way to know that yesterday's
 * key and today's are the same user, so every rotation is a full quota reset -
 * which is precisely the window a scanner would ride. Rotating hourly would
 * hand every user 24 free resets a day.
 *
 * Be precise about what this is worth: the Worker holds RELAY_SECRET too, so it
 * could recompute this value for a candidate address. The property is that it
 * has no address to try - not that the mapping is hidden from someone who has
 * both.
 */
export async function deriveBucket(secret: string, clientKey: string): Promise<string> {
  const key = await bucketKey(secret);
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(clientKey));
  // 128 bits is far more than enough to keep distinct users in distinct
  // buckets, and a shorter key is a smaller thing to pass around.
  return base64url(new Uint8Array(mac).subarray(0, 16));
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 16 random bytes as hex. Distinguishes two dials sealed in the same millisecond. */
export function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
