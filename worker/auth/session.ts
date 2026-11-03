// Cookie sessions. The cookie holds a random token; only
// its SHA-256 hash is stored, so a database leak cannot be replayed as a login.

import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { AppEnv } from "../env";
import { first, run, nowIso } from "../lib/db";
import { randomToken, sha256Hex } from "../lib/crypto";
import { forUser, rawDb } from "../lib/scoped";
import { describeAgent } from "../lib/ua";
import { getSetting, setSetting } from "../services/settings";
import { notifyOwner, escapeHtml } from "../services/telegram";

export const SESSION_COOKIE = "wallet_session";
const SESSION_DAYS = 30;
const REFRESH_AFTER_MS = 24 * 3600 * 1000;

/** Phone/desktop shells that cannot use cookies send this header and get the session token back in the JSON instead. */
export function isAppClient(c: Context<AppEnv>): boolean {
  return c.req.header("x-client") === "app";
}

/** The token of the signed-in session: from the cookie (browser) or from "Authorization: Bearer" (app shell). */
function sessionToken(c: Context<AppEnv>): { token: string; bearer: boolean } | null {
  const cookie = getCookie(c, SESSION_COOKIE);
  if (cookie) return { token: cookie, bearer: false };
  const m = c.req.header("authorization")?.match(/^Bearer\s+([A-Za-z0-9_-]{20,200})$/);
  return m ? { token: m[1], bearer: true } : null;
}

/** Creates a session. Browsers get a cookie; app clients (x-client: app) get the token back and no cookie. */
export async function createSession(c: Context<AppEnv>, userId: number): Promise<string | null> {
  const token = randomToken(32);
  const hash = await sha256Hex(token);
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 86_400_000);
  await run(
    rawDb(c.env),
    "INSERT INTO sessions (user_id, token_hash, created_at, last_seen_at, expires_at, user_agent, ip) VALUES (?, ?, ?, ?, ?, ?, ?)",
    userId,
    hash,
    now.toISOString(),
    now.toISOString(),
    expires.toISOString(),
    (c.req.header("user-agent") ?? "").slice(0, 200),
    clientIp(c),
  );
  const app = isAppClient(c);
  if (!app) {
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      secure: new URL(c.req.url).protocol === "https:",
      sameSite: "Strict",
      path: "/",
      expires,
    });
  }
  c.executionCtx.waitUntil(alertOnNewDevice(c, userId).catch((e) => console.error("new-device alert", e)));
  return app ? token : null;
}

/**
 * Remember which browsers/phones this user has signed in from (a short hash of the User-Agent) and send a Telegram
 * message when a new one appears. The first device is remembered silently.
 */
async function alertOnNewDevice(c: Context<AppEnv>, userId: number): Promise<void> {
  const ua = c.req.header("user-agent") ?? "";
  const env = forUser(c.env, userId);
  const id = (await sha256Hex(ua)).slice(0, 16);
  let known: string[] = [];
  try {
    known = JSON.parse((await getSetting(env.DB, "known_devices")) ?? "[]");
  } catch {
    known = [];
  }
  if (known.includes(id)) return;
  await setSetting(env.DB, "known_devices", JSON.stringify([...known, id].slice(-20)));
  if (known.length === 0) return;
  await notifyOwner(env, `🔐 New sign-in from <b>${escapeHtml(describeAgent(ua))}</b> (${escapeHtml(clientIp(c))}). If this wasn't you, open Settings → Security and log that device out.`);
}

/** The session (and its user) if the request carries a valid one and the user is active, else null. */
export async function validateSession(c: Context<AppEnv>): Promise<{ hash: string; userId: number; role: "admin" | "user"; bearer: boolean } | null> {
  const db = rawDb(c.env);
  const found = sessionToken(c);
  if (!found) return null;
  const { token, bearer } = found;
  const hash = await sha256Hex(token);
  const row = await first<{ expires_at: string; last_seen_at: string; user_id: number; role: "admin" | "user" }>(
    db,
    `SELECT s.expires_at, s.last_seen_at, s.user_id, u.role FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND u.status = 'active'`,
    hash,
  );
  if (!row) return null;
  const now = Date.now();
  if (Date.parse(row.expires_at) < now) {
    await run(db, "DELETE FROM sessions WHERE token_hash = ?", hash);
    return null;
  }
  // Sliding expiry: refresh at most once a day to keep writes low.
  if (now - Date.parse(row.last_seen_at) > REFRESH_AFTER_MS) {
    const expires = new Date(now + SESSION_DAYS * 86_400_000);
    await run(
      db,
      "UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?",
      nowIso(),
      expires.toISOString(),
      hash,
    );
    if (!bearer) {
      setCookie(c, SESSION_COOKIE, token, {
        httpOnly: true,
        secure: new URL(c.req.url).protocol === "https:",
        sameSite: "Strict",
        path: "/",
        expires,
      });
    }
  }
  return { hash, userId: row.user_id, role: row.role, bearer };
}

export async function destroySession(c: Context<AppEnv>): Promise<void> {
  const found = sessionToken(c);
  if (found) await run(rawDb(c.env), "DELETE FROM sessions WHERE token_hash = ?", await sha256Hex(found.token));
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

export function clientIp(c: Context<AppEnv>): string {
  return c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
}
