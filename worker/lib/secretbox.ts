// Encryption at rest and signed short-lived tokens, both from one installation key (the ENCRYPTION_KEY secret,
// 32 random bytes in base64, generated once by the deploy script and never changed afterwards).

import type { Env } from "../env";

const enc = new TextEncoder();
const dec = new TextDecoder();
const PREFIX = "enc1:";

export class MissingKeyError extends Error {
  constructor() {
    super("The app's encryption key is missing. Run the Deploy workflow again (it creates the key on the first run).");
  }
}

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64url = (bytes: Uint8Array) => b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) => unb64(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "="));

function rawKey(env: Env): Uint8Array {
  if (!env.ENCRYPTION_KEY) throw new MissingKeyError();
  const bytes = unb64(env.ENCRYPTION_KEY.trim());
  if (bytes.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes (base64)");
  return bytes;
}

async function aesKey(env: Env): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", rawKey(env), "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function hmacKey(env: Env): Promise<CryptoKey> {
  // A different key from the encryption one, derived from it.
  const material = new Uint8Array([...enc.encode("sign:"), ...rawKey(env)]);
  const derived = await crypto.subtle.digest("SHA-256", material);
  return crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/** Encrypt a string. Output looks like "enc1:<iv>:<ciphertext>". */
export async function seal(env: Env, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(env), enc.encode(plain)));
  return `${PREFIX}${b64(iv)}:${b64(ct)}`;
}

/** Decrypt a sealed value. Values stored before encryption existed (no prefix) are returned as they are. */
export async function open(env: Env, stored: string): Promise<string> {
  if (!stored.startsWith(PREFIX)) return stored;
  const [iv, ct] = stored.slice(PREFIX.length).split(":");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await aesKey(env), unb64(ct));
  return dec.decode(plain);
}

export const isSealed = (stored: string) => stored.startsWith(PREFIX);

/** A tamper-proof token that carries a small JSON payload and expires. */
export async function signToken(env: Env, payload: Record<string, unknown>, ttlSeconds: number): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds })));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(env), enc.encode(body)));
  return `${body}.${b64url(sig)}`;
}

/** The payload if the token is genuine and not expired, else null. */
export async function verifyToken<T extends Record<string, unknown>>(env: Env, token: string | undefined, now = Date.now()): Promise<T | null> {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(env), unb64url(sig), enc.encode(body));
    if (!ok) return null;
    const payload = JSON.parse(dec.decode(unb64url(body))) as T & { exp?: number };
    return payload.exp && payload.exp * 1000 > now ? payload : null;
  } catch (e) {
    if (e instanceof MissingKeyError) throw e;
    return null;
  }
}
