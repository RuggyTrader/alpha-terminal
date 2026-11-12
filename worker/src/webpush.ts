// Standards-based Web Push from a Cloudflare Worker, with WebCrypto only (no paid provider, no dependency).
//   * VAPID (RFC 8292): an ES256 JWT signed with the server's P-256 key; the private key is a Worker SECRET
//     (VAPID_PRIVATE_KEY, base64url d), the public key a variable (VAPID_PUBLIC_KEY, base64url uncompressed point).
//   * Message encryption (RFC 8291, "aes128gcm" content coding, RFC 8188): ECDH with the browser's p256dh key,
//     HKDF with its auth secret, AES-128-GCM, one record. Works with Apple (iOS 16.4+ Home Screen apps), Google and
//     Mozilla push services.
// Nothing here logs or returns a key.

export interface PushSubscriptionKeys { endpoint: string; p256dh: string; auth: string }
export interface VapidConfig { publicKey: string; privateKey: string; subject: string }
export type PushOutcome = { ok: true; status: number } | { ok: false; status: number; gone: boolean; retry: boolean; error: string };

const enc = new TextEncoder();

export function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export function bytesToB64url(b: ArrayBuffer | Uint8Array): string {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = "";
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

/** Push services this Worker will deliver to (prevents using the Worker as a request relay to arbitrary hosts). */
const PUSH_HOSTS = [/\.push\.apple\.com$/, /^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /\.push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/];
export function allowedEndpoint(endpoint: unknown): boolean {
  if (typeof endpoint !== "string" || endpoint.length > 1024) return false;
  let u: URL;
  try { u = new URL(endpoint); } catch { return false; }
  return u.protocol === "https:" && !u.port && PUSH_HOSTS.some((r) => r.test(u.hostname));
}

/** Browser keys must be a P-256 public point (65 bytes, 0x04...) and a 16-byte auth secret. */
export function validKeys(p256dh: unknown, auth: unknown): boolean {
  try {
    if (typeof p256dh !== "string" || typeof auth !== "string") return false;
    const k = b64urlToBytes(p256dh), a = b64urlToBytes(auth);
    return k.length === 65 && k[0] === 4 && a.length === 16;
  } catch {
    return false;
  }
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

/**
 * RFC 8291 encryption of one message. `fixed` is for tests only (the RFC's example keys and salt); in production
 * every message gets a fresh sender key pair and a random salt.
 */
export async function encryptPayload(sub: { p256dh: string; auth: string }, plaintext: Uint8Array,
  fixed?: { senderPrivateJwk: JsonWebKey; senderPublic: Uint8Array; salt: Uint8Array }): Promise<Uint8Array> {
  const uaPublic = b64urlToBytes(sub.p256dh);
  const authSecret = b64urlToBytes(sub.auth);
  let asPrivate: CryptoKey, asPublic: Uint8Array;
  if (fixed) {
    asPrivate = await crypto.subtle.importKey("jwk", fixed.senderPrivateJwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    asPublic = fixed.senderPublic;
  } else {
    const kp = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
    asPrivate = kp.privateKey;
    asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer);
  }
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm, asPrivate, 256));
  const ikm = await hkdf(authSecret, ecdh, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = fixed ? fixed.salt : crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const record = concat(plaintext, new Uint8Array([2])); // last (and only) record: padding delimiter 0x02
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, record));
  const rs = new Uint8Array([0, 0, 0x10, 0]); // record size 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, sealed);
}

/** VAPID Authorization header value for one push endpoint (JWT valid 12 hours). */
export async function vapidAuthorization(endpoint: string, vapid: VapidConfig, nowMs = Date.now()): Promise<string> {
  const pub = b64urlToBytes(vapid.publicKey);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error("VAPID_PUBLIC_KEY is not an uncompressed P-256 point");
  const jwk: JsonWebKey = { kty: "EC", crv: "P-256", d: vapid.privateKey, x: bytesToB64url(pub.slice(1, 33)), y: bytesToB64url(pub.slice(33, 65)), ext: true };
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const header = bytesToB64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = bytesToB64url(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(nowMs / 1000) + 12 * 3600, sub: vapid.subject })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${bytesToB64url(sig)}, k=${vapid.publicKey}`;
}

/** Sends one encrypted message. Never throws: the outcome says whether to retry or to drop the subscription. */
export async function sendPush(sub: PushSubscriptionKeys, payload: unknown, vapid: VapidConfig, opts: { ttl?: number; urgency?: "high" | "normal"; fetcher?: typeof fetch } = {}): Promise<PushOutcome> {
  try {
    if (!allowedEndpoint(sub.endpoint)) return { ok: false, status: 0, gone: true, retry: false, error: "endpoint is not a known push service" };
    const body = await encryptPayload(sub, enc.encode(JSON.stringify(payload)));
    const r = await (opts.fetcher ?? fetch)(sub.endpoint, {
      method: "POST",
      headers: {
        Authorization: await vapidAuthorization(sub.endpoint, vapid),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: String(opts.ttl ?? 6 * 3600),
        Urgency: opts.urgency ?? "high",
      },
      body,
    });
    if (r.status >= 200 && r.status < 300) return { ok: true, status: r.status };
    const gone = r.status === 404 || r.status === 410;
    const retry = r.status === 429 || r.status >= 500;
    return { ok: false, status: r.status, gone, retry, error: `push service answered HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, status: 0, gone: false, retry: true, error: String((e as Error)?.message ?? e).slice(0, 200) };
  }
}
