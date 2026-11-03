import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "../env";
import { body } from "../lib/http";
import { safeEqual } from "../lib/crypto";
import { all, first, insert, nowIso, run } from "../lib/db";
import { clientIp, createSession, destroySession, validateSession } from "../auth/session";
import { forUser, rawDb } from "../lib/scoped";
import { OWNER_ID } from "../lib/userkeys";
import { lockedFor, lockedKey, recordFailure, recordKeyFailure, recordSignupRequest, resetFailures, resetKey } from "../auth/ratelimit";
import { confirmEnrolment, disableMfa, mfaEnabled, mfaStatus, regenerateRecoveryCodes, skipMfa, startEnrolment, verifySecondFactor } from "../auth/mfa";
import { signToken, verifyToken } from "../lib/secretbox";
import { getSetting, setSetting } from "../services/settings";
import { authUrl, exchangeCode, googleConfigured } from "../services/google";
import { notifyAdmins, escapeHtml } from "../services/telegram";
import { randomToken } from "../lib/crypto";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";

const app = new Hono<AppEnv>();

app.post("/login", async (c) => {
  const { password } = await body(c, z.object({ password: z.string().max(500) }));
  if (!c.env.APP_PASSWORD) {
    throw new HTTPException(503, {
      message: "No password is configured yet. Add the APP_PASSWORD secret (see the setup guide) and redeploy.",
    });
  }
  const ip = clientIp(c);
  const wait = await lockedFor(c.env.DB, ip);
  if (wait > 0) throw new HTTPException(429, { message: `Too many attempts. Try again in ${Math.ceil(wait / 60)} minute(s).` });

  if (!(await safeEqual(password, c.env.APP_PASSWORD))) {
    await recordFailure(c.env.DB, ip);
    throw new HTTPException(401, { message: "Wrong password" });
  }
  await resetFailures(c.env.DB, ip);
  return signIn(c, OWNER_ID);
});

/**
 * The last step of every sign-in method (password, Google): users with two-step verification get a short-lived
 * signed "password done" cookie and must send a code to /mfa/verify; everyone else gets their session now.
 */
async function signIn(c: Context<AppEnv>, userId: number, redirect = false) {
  if (await mfaEnabled(forUser(c.env, userId))) {
    setCookie(c, MFA_COOKIE, await signToken(c.env, { u: userId }, 300), {
      httpOnly: true,
      secure: new URL(c.req.url).protocol === "https:",
      sameSite: "Strict",
      path: "/api/auth",
      maxAge: 300,
    });
    return redirect ? c.redirect("/?auth=mfa") : c.json({ ok: false, mfa_required: true });
  }
  await createSession(c, userId);
  return redirect ? c.redirect("/") : c.json({ ok: true });
}

const MFA_COOKIE = "wallet_mfa";

app.post("/mfa/verify", async (c) => {
  const { code } = await body(c, z.object({ code: z.string().min(6).max(20) }));
  const pending = await verifyToken<{ u: number }>(c.env, getCookie(c, MFA_COOKIE));
  if (!pending) throw new HTTPException(401, { message: "Your sign-in timed out. Please start again." });
  const db = rawDb(c.env);
  const ip = clientIp(c);
  const key = `mfa:${pending.u}`;
  const wait = Math.max(await lockedFor(db, ip), await lockedKey(db, key));
  if (wait > 0) throw new HTTPException(429, { message: `Too many attempts. Try again in ${Math.ceil(wait / 60)} minute(s).` });
  if (!(await verifySecondFactor(forUser(c.env, pending.u), code))) {
    await recordFailure(db, ip);
    await recordKeyFailure(db, key, 5, 15);
    throw new HTTPException(401, { message: "That code is not correct" });
  }
  await resetKey(db, key);
  deleteCookie(c, MFA_COOKIE, { path: "/api/auth" });
  await createSession(c, pending.u);
  return c.json({ ok: true });
});

app.post("/logout", async (c) => {
  await destroySession(c);
  return c.json({ ok: true });
});

app.get("/me", async (c) => {
  const session = await validateSession(c);
  return c.json({
    authenticated: Boolean(session),
    password_configured: Boolean(c.env.APP_PASSWORD),
    google_configured: googleConfigured(c.env),
    registration_open: (await getSetting(rawDb(c.env), "registration_open")) === "1",
  });
});

// ---------------------------------------------------------------------------
// Continue with Google. The state/nonce cookie is SameSite=Lax because the browser comes back from Google as a
// cross-site navigation (Strict cookies would not be sent).

const GOOGLE_COOKIE = "wallet_google";
const MAX_PENDING = 20;

function startGoogle(c: Context<AppEnv>, linkingUserId: number | null) {
  if (!googleConfigured(c.env)) return c.redirect("/?auth=error");
  const state = randomToken(16);
  const nonce = randomToken(16);
  setCookie(c, GOOGLE_COOKIE, `${state}.${nonce}`, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax",
    path: "/api/auth/google",
    maxAge: 600,
  });
  return { state, nonce, url: authUrl(c.env, new URL(c.req.url).origin, state, nonce), linkingUserId };
}

app.get("/google/start", (c) => {
  const r = startGoogle(c, null);
  return r instanceof Response ? r : c.redirect(r.url);
});

app.get("/google/callback", async (c) => {
  const done = (to: string) => {
    deleteCookie(c, GOOGLE_COOKIE, { path: "/api/auth/google" });
    return c.redirect(to);
  };
  if (!googleConfigured(c.env)) return done("/?auth=error");
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (c.req.query("error") || !code || !state) return done("/?auth=cancelled");
  const [cookieState, nonce] = (getCookie(c, GOOGLE_COOKIE) ?? "").split(".");
  if (!cookieState || !nonce || cookieState !== state) return done("/?auth=error");

  let claims;
  try {
    claims = await exchangeCode(c.env, new URL(c.req.url).origin, code, nonce);
  } catch (e) {
    console.error("google sign-in", e);
    return done("/?auth=error");
  }
  const db = rawDb(c.env);
  const email = claims.email.trim().toLowerCase();

  // A signed-in user linking their Google account: the link was started from their session.
  const link = await first<{ user_id: number; value: string }>(db, "SELECT user_id, value FROM user_settings WHERE key = 'google_link_state' AND value LIKE ?", `${state}:%`);
  if (link) {
    await run(db, "DELETE FROM user_settings WHERE user_id = ? AND key = 'google_link_state'", link.user_id);
    if (Number(link.value.split(":")[1]) < Date.now()) return done("/settings?google=expired");
    const taken = await first(db, "SELECT id FROM users WHERE id <> ? AND (google_sub = ? OR lower(email) = ?)", link.user_id, claims.sub, email);
    if (taken) return done("/settings?google=taken");
    await run(db, "UPDATE users SET email = ?, google_sub = ?, name = CASE WHEN name = '' OR name = 'Owner' THEN ? ELSE name END WHERE id = ?", email, claims.sub, claims.name ?? "", link.user_id);
    return done("/settings?google=linked");
  }

  const user = await first<{ id: number; status: string; google_sub: string | null }>(
    db,
    "SELECT id, status, google_sub FROM users WHERE google_sub = ? OR lower(email) = ? ORDER BY (google_sub = ?) DESC LIMIT 1",
    claims.sub,
    email,
    claims.sub,
  );
  if (user) {
    if (user.status === "pending") return done("/?auth=pending");
    if (user.status === "disabled") return done("/?auth=disabled");
    if (!user.google_sub) await run(db, "UPDATE users SET google_sub = ? WHERE id = ?", claims.sub, user.id);
    deleteCookie(c, GOOGLE_COOKIE, { path: "/api/auth/google" });
    return signIn(c, user.id, true);
  }

  // A new person asking for access.
  if ((await getSetting(db, "registration_open")) !== "1") return done("/?auth=closed");
  const ip = clientIp(c);
  const pending = (await first<{ n: number }>(db, "SELECT COUNT(*) AS n FROM users WHERE status = 'pending'"))?.n ?? 0;
  if ((await lockedKey(db, `signup:${ip}`)) > 0 || pending >= MAX_PENDING) return done("/?auth=busy");
  await recordSignupRequest(db, ip);
  await insert(db, "INSERT INTO users (email, name, google_sub, role, status, created_at) VALUES (?, ?, ?, 'user', 'pending', ?)", email, claims.name ?? "", claims.sub, nowIso());
  c.executionCtx.waitUntil(notifyAdmins(c.env, `🆕 <b>${escapeHtml(claims.name || email)}</b> (${escapeHtml(email)}) asked for access. Open Admin → Users to approve.`));
  return done("/?auth=pending");
});

// Routes below require a session (and, for changes, a request from this site).
app.use("/*", async (c, next) => {
  const session = await validateSession(c);
  if (!session) throw new HTTPException(401, { message: "Please log in" });
  const origin = c.req.header("origin");
  if (c.req.method !== "GET" && origin && origin !== new URL(c.req.url).origin) {
    throw new HTTPException(403, { message: "Cross-site request blocked" });
  }
  c.set("sessionHash", session.hash);
  c.set("userId", session.userId);
  c.set("role", session.role);
  c.env = forUser(c.env, session.userId);
  await next();
});

/** Signed-in user links their Google account (the owner does this once to sign in with Google later). */
app.get("/google/link", async (c) => {
  const r = startGoogle(c, c.get("userId"));
  if (r instanceof Response) return r;
  await setSetting(c.env.DB, "google_link_state", `${r.state}:${Date.now() + 10 * 60_000}`);
  return c.redirect(r.url);
});

app.get("/mfa", async (c) => c.json(await mfaStatus(c.env)));

app.post("/mfa/setup", async (c) => {
  if (await mfaEnabled(c.env)) throw new HTTPException(400, { message: "Two-step verification is already on" });
  const me = await first<{ email: string | null; name: string }>(rawDb(c.env), "SELECT email, name FROM users WHERE id = ?", c.get("userId"));
  return c.json(await startEnrolment(c.env, me?.email || me?.name || "account"));
});

app.post("/mfa/confirm", async (c) => {
  const { code } = await body(c, z.object({ code: z.string() }));
  const codes = await confirmEnrolment(c.env, code);
  if (!codes) throw new HTTPException(400, { message: "That code is not correct. Check the time on your phone and try again." });
  return c.json({ ok: true, recovery_codes: codes });
});

app.post("/mfa/skip", async (c) => {
  await skipMfa(c.env);
  return c.json({ ok: true });
});

app.post("/mfa/disable", async (c) => {
  const { code } = await body(c, z.object({ code: z.string() }));
  if (!(await mfaEnabled(c.env))) return c.json({ ok: true });
  if (!(await disableMfa(c.env, code))) throw new HTTPException(400, { message: "That code is not correct" });
  return c.json({ ok: true });
});

app.post("/mfa/recovery-codes", async (c) => {
  const { code } = await body(c, z.object({ code: z.string() }));
  const codes = await regenerateRecoveryCodes(c.env, code);
  if (!codes) throw new HTTPException(400, { message: "That code is not correct" });
  return c.json({ ok: true, recovery_codes: codes });
});

app.get("/sessions", async (c) => {
  const current = c.get("sessionHash");
  const rows = await all<{ token_hash: string; created_at: string; last_seen_at: string; user_agent: string | null; ip: string | null }>(
    c.env.DB,
    "SELECT token_hash, created_at, last_seen_at, user_agent, ip FROM sessions ORDER BY last_seen_at DESC",
  );
  return c.json(
    rows.map((r) => ({
      id: r.token_hash.slice(0, 12),
      created_at: r.created_at,
      last_seen_at: r.last_seen_at,
      user_agent: r.user_agent,
      ip: r.ip,
      current: r.token_hash === current,
    })),
  );
});

/** Log out one device (by the short id shown in the list). */
app.delete("/sessions/:id", async (c) => {
  const id = c.req.param("id");
  if (!/^[0-9a-f]{12}$/.test(id)) throw new HTTPException(400, { message: "Unknown device" });
  if (c.get("sessionHash").startsWith(id)) throw new HTTPException(400, { message: "That is this device. Use Log out instead." });
  await run(c.env.DB, "DELETE FROM sessions WHERE token_hash LIKE ?", `${id}%`);
  return c.json({ ok: true });
});

/** Log out every other device. */
app.post("/sessions/revoke-others", async (c) => {
  await run(c.env.DB, "DELETE FROM sessions WHERE token_hash <> ?", c.get("sessionHash"));
  return c.json({ ok: true });
});

export default app;
