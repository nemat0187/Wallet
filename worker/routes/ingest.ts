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

/**
 * Parse whatever the forwarder app sent. Phone automation apps paste the notification
 * into a JSON template as-is, so line breaks inside strings (invalid JSON) are common;
 * those are repaired, and anything else unreadable is treated as the message text itself.
 */
export function readPayload(rawText: string, contentType: string): Record<string, unknown> {
  if (contentType.includes("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(rawText));
  const asObject = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
  for (const candidate of [rawText, escapeControlCharsInStrings(rawText)]) {
    try {
      const parsed = asObject(JSON.parse(candidate));
      if (parsed) return parsed;
    } catch {
      // try the next form
    }
  }
  return { text: rawText };
}

function escapeControlCharsInStrings(json: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (inString && ch === "\\") {
      out += ch + (json[i + 1] ?? "");
      i++;
    } else if (ch === '"') {
      inString = !inString;
      out += ch;
    } else if (inString && (ch === "\n" || ch === "\r" || ch === "\t")) {
      out += ch === "\n" ? "\\n" : ch === "\r" ? "\\r" : "\\t";
    } else out += ch;
  }
  return out;
}

publicIngest.post("/", async (c) => {
  const contentType = c.req.header("content-type") ?? "";
  const payload = contentType.includes("multipart/form-data")
    ? (Object.fromEntries((await c.req.formData()).entries()) as Record<string, unknown>)
    : readPayload(await c.req.text(), contentType);

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
  let text = pick("text", "message", "body", "msg", "content", "sms", "notification", "big_text", "data");
  // Notifications have a title (for ABB: "💸 Ödəniş: -5.86₼") that carries the amount — keep it.
  const title = pick("title", "notification_title", "not_title");
  if (title && !text?.includes(title.trim())) text = text ? `${title}\n${text}` : title;
  if (!text) throw new HTTPException(400, { message: "No message text found (send it as 'text')" });
  const sender = pick("from", "sender", "address", "phone", "app", "package") ?? null;
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
