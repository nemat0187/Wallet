import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "../env";
import { body } from "../lib/http";
import { safeEqual } from "../lib/crypto";
import { all, run } from "../lib/db";
import { clientIp, createSession, destroySession, validateSession } from "../auth/session";
import { lockedFor, recordFailure, resetFailures } from "../auth/ratelimit";
import { generateTotpSecret, totpUri, verifyTotp } from "../auth/totp";
import { getRawSettings, getSetting, setSetting } from "../services/settings";

const app = new Hono<AppEnv>();

app.post("/login", async (c) => {
  const { password, code } = await body(c, z.object({ password: z.string().max(500), code: z.string().max(10).optional() }));
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
  const totpSecret = await getSetting(c.env.DB, "totp_secret");
  if (totpSecret) {
    if (!code) return c.json({ ok: false, totp_required: true });
    if (!(await verifyTotp(totpSecret, code))) {
      await recordFailure(c.env.DB, ip);
      throw new HTTPException(401, { message: "Wrong 6-digit code" });
    }
  }
  await resetFailures(c.env.DB, ip);
  await createSession(c);
  return c.json({ ok: true });
});

app.post("/logout", async (c) => {
  await destroySession(c);
  return c.json({ ok: true });
});

app.get("/me", async (c) => {
  const session = await validateSession(c);
  return c.json({ authenticated: Boolean(session), password_configured: Boolean(c.env.APP_PASSWORD) });
});

// Routes below require a session (and, for changes, a request from this site).
app.use("/*", async (c, next) => {
  const session = await validateSession(c);
  if (!session) throw new HTTPException(401, { message: "Please log in" });
  const origin = c.req.header("origin");
  if (c.req.method !== "GET" && origin && origin !== new URL(c.req.url).origin) {
    throw new HTTPException(403, { message: "Cross-site request blocked" });
  }
  c.set("sessionHash", session);
  await next();
});

app.post("/totp/setup", async (c) => {
  const secret = generateTotpSecret();
  await setSetting(c.env.DB, "totp_pending_secret", secret);
  return c.json({ secret, uri: totpUri(secret, "owner", "Wallet") });
});

app.post("/totp/enable", async (c) => {
  const { code } = await body(c, z.object({ code: z.string() }));
  const pending = await getSetting(c.env.DB, "totp_pending_secret");
  if (!pending) throw new HTTPException(400, { message: "Start the setup first" });
  if (!(await verifyTotp(pending, code))) throw new HTTPException(400, { message: "That code is not correct. Check the time on your phone and try again." });
  await setSetting(c.env.DB, "totp_secret", pending);
  await setSetting(c.env.DB, "totp_pending_secret", null);
  return c.json({ ok: true });
});

app.post("/totp/disable", async (c) => {
  const { code } = await body(c, z.object({ code: z.string() }));
  const raw = await getRawSettings(c.env.DB);
  if (!raw.totp_secret) return c.json({ ok: true });
  if (!(await verifyTotp(raw.totp_secret, code))) throw new HTTPException(400, { message: "That code is not correct" });
  await setSetting(c.env.DB, "totp_secret", null);
  return c.json({ ok: true });
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

/** Log out every other device. */
app.post("/sessions/revoke-others", async (c) => {
  await run(c.env.DB, "DELETE FROM sessions WHERE token_hash <> ?", c.get("sessionHash"));
  return c.json({ ok: true });
});

export default app;
