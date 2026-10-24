// Phone → app: the webhook your SMS/notification forwarder calls, plus the
// Inbox of received messages and the access tokens that protect the webhook.

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "../env";
import type { RawMessage } from "@shared/types";
import { body, intParam, notFound } from "../lib/http";
import { all, first, insert, nowIso, run } from "../lib/db";
import { randomToken, sha256Hex } from "../lib/crypto";
import { ingestMessage, processMessage } from "../services/ingest";
import { afterTransactions } from "../services/alerts";
import { parseBankMessage } from "../services/parser";
import { getSettings } from "../services/settings";

// ---------------------------------------------------------------------------
// Public webhook: POST /api/ingest  (token in "Authorization: Bearer", "X-Api-Key", ?token= or body.token)

export const publicIngest = new Hono<AppEnv>();

publicIngest.post("/", async (c) => {
  const contentType = c.req.header("content-type") ?? "";
  let payload: Record<string, unknown> = {};
  let rawText = "";
  if (contentType.includes("application/json")) {
    payload = ((await c.req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  } else if (contentType.includes("form")) {
    payload = Object.fromEntries((await c.req.formData()).entries()) as Record<string, unknown>;
  } else {
    rawText = await c.req.text();
    try {
      payload = JSON.parse(rawText);
    } catch {
      payload = { text: rawText };
    }
  }

  const token =
    c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ??
    c.req.header("x-api-key") ??
    c.req.query("token") ??
    (typeof payload.token === "string" ? payload.token : undefined);
  if (!token) throw new HTTPException(401, { message: "Missing token" });
  const tokenHash = await sha256Hex(token.trim());
  const tokenRow = await first<{ id: number }>(c.env.DB, "SELECT id FROM api_tokens WHERE token_hash = ?", tokenHash);
  if (!tokenRow) throw new HTTPException(401, { message: "Invalid token" });
  await run(c.env.DB, "UPDATE api_tokens SET last_used_at = ? WHERE id = ?", nowIso(), tokenRow.id);

  // Different forwarder apps use different field names; accept the common ones.
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = payload[k];
      if (typeof v === "string" && v.trim()) return v;
      if (typeof v === "number") return String(v);
    }
    return undefined;
  };
  const text = pick("text", "message", "body", "msg", "content", "sms", "notification", "data");
  if (!text) throw new HTTPException(400, { message: "No message text found (send it as 'text')" });
  const sender = pick("from", "sender", "address", "phone", "app", "title") ?? null;
  const ts = pick("received_at", "receivedStamp", "timestamp", "sentStamp", "date", "time");
  let receivedAt: Date | undefined;
  if (ts) {
    const n = Number(ts);
    const d = Number.isFinite(n) ? new Date(n < 1e12 ? n * 1000 : n) : new Date(ts);
    if (!Number.isNaN(d.getTime()) && Math.abs(d.getTime() - Date.now()) < 7 * 86_400_000) receivedAt = d;
  }
  const source = (pick("source", "type") ?? "sms").toLowerCase().includes("push") ? "push" : "sms";

  const result = await ingestMessage(c.env, { body: text, sender, source, receivedAt });
  if (result.transaction_id && result.status === "parsed") {
    c.executionCtx.waitUntil(afterTransactions(c.env, [result.transaction_id], { needsAi: result.needs_ai }));
  }
  return c.json({ ok: true, status: result.status, transaction_id: result.transaction_id, error: result.error ?? null });
});

// ---------------------------------------------------------------------------
// Inbox (requires login): /api/messages

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  const status = c.req.query("status");
  const rows = await all<RawMessage>(
    c.env.DB,
    `SELECT id, source, sender, body, received_at, status, parse_method, parse_result, error, transaction_id
       FROM raw_messages ${status ? "WHERE status = ?" : ""} ORDER BY received_at DESC LIMIT 200`,
    ...(status ? [status] : []),
  );
  return c.json(rows);
});

/** Try parsing a pasted message without saving anything (parser playground). */
app.post("/test", async (c) => {
  const { text } = await body(c, z.object({ text: z.string().min(1).max(2000) }));
  const settings = await getSettings(c.env);
  return c.json(parseBankMessage(text, { receivedAt: new Date(), tzOffsetMinutes: settings.tz_offset_minutes }));
});

/** Record a pasted bank message (same as if the phone had sent it). */
app.post("/", async (c) => {
  const { text } = await body(c, z.object({ text: z.string().min(1).max(2000) }));
  const result = await ingestMessage(c.env, { body: text, source: "test" });
  if (result.transaction_id && result.status === "parsed") {
    c.executionCtx.waitUntil(afterTransactions(c.env, [result.transaction_id], { needsAi: result.needs_ai }));
  }
  return c.json(result);
});

app.post("/:id/reprocess", async (c) => {
  const id = intParam(c, "id");
  const msg = await first<RawMessage & { body_hash: string }>(c.env.DB, "SELECT * FROM raw_messages WHERE id = ?", id);
  if (!msg) notFound();
  if (msg.transaction_id) return c.json({ status: "parsed", transaction_id: msg.transaction_id });
  const result = await processMessage(c.env, id, msg.body, new Date(msg.received_at), `msg:${msg.body_hash}`);
  if (result.transaction_id) c.executionCtx.waitUntil(afterTransactions(c.env, [result.transaction_id], { needsAi: result.needs_ai }));
  return c.json(result);
});

app.post("/:id/ignore", async (c) => {
  await run(c.env.DB, "UPDATE raw_messages SET status = 'ignored' WHERE id = ?", intParam(c, "id"));
  return c.json({ ok: true });
});

app.delete("/:id", async (c) => {
  await run(c.env.DB, "DELETE FROM raw_messages WHERE id = ?", intParam(c, "id"));
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Webhook tokens: /api/messages/tokens

app.get("/tokens/list", async (c) => {
  return c.json(
    await all(c.env.DB, "SELECT id, name, token_hint, created_at, last_used_at FROM api_tokens ORDER BY id DESC"),
  );
});

app.post("/tokens", async (c) => {
  const { name } = await body(c, z.object({ name: z.string().min(1).max(60) }));
  const token = `wlt_${randomToken(24)}`;
  const id = await insert(
    c.env.DB,
    "INSERT INTO api_tokens (name, token_hash, token_hint, created_at) VALUES (?, ?, ?, ?)",
    name,
    await sha256Hex(token),
    token.slice(-4),
    nowIso(),
  );
  // The full token is shown once; only its hash is stored.
  return c.json({ id, token });
});

app.delete("/tokens/:id", async (c) => {
  await run(c.env.DB, "DELETE FROM api_tokens WHERE id = ?", intParam(c, "id"));
  return c.json({ ok: true });
});

export default app;
