// Cookie sessions. The cookie holds a random token; only
// its SHA-256 hash is stored, so a database leak cannot be replayed as a login.

import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { AppEnv } from "../env";
import { first, run, nowIso } from "../lib/db";
import { randomToken, sha256Hex } from "../lib/crypto";
import { rawDb } from "../lib/scoped";

export const SESSION_COOKIE = "wallet_session";
const SESSION_DAYS = 30;
const REFRESH_AFTER_MS = 24 * 3600 * 1000;

export async function createSession(c: Context<AppEnv>, userId: number): Promise<void> {
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
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Strict",
    path: "/",
    expires,
  });
}

/** The session (and its user) if the request carries a valid one and the user is active, else null. */
export async function validateSession(c: Context<AppEnv>): Promise<{ hash: string; userId: number } | null> {
  const db = rawDb(c.env);
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const hash = await sha256Hex(token);
  const row = await first<{ expires_at: string; last_seen_at: string; user_id: number }>(
    db,
    `SELECT s.expires_at, s.last_seen_at, s.user_id FROM sessions s JOIN users u ON u.id = s.user_id
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
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      secure: new URL(c.req.url).protocol === "https:",
      sameSite: "Strict",
      path: "/",
      expires,
    });
  }
  return { hash, userId: row.user_id };
}

export async function destroySession(c: Context<AppEnv>): Promise<void> {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await run(rawDb(c.env), "DELETE FROM sessions WHERE token_hash = ?", await sha256Hex(token));
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

export function clientIp(c: Context<AppEnv>): string {
  return c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
}
