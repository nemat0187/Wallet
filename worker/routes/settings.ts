import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import type { AppEnv } from "../env";
import type { Account, Category, Transaction } from "@shared/types";
import { badRequest } from "../lib/http";
import { all, first } from "../lib/db";
import { EDITABLE, getSettings, setSetting } from "../services/settings";
import { disconnectTelegram, handleTelegramUpdate, notifyOwner, startTelegramLink } from "../services/telegram";
import { categoryPath, loadCategories } from "../services/categorize";
import { TX_SELECT } from "../services/analytics";

// Public: Telegram calls this (verified with the secret token header).
export const telegramWebhook = new Hono<AppEnv>();
telegramWebhook.post("/webhook", async (c) => {
  const update = await c.req.json().catch(() => ({}));
  // Answer Telegram immediately; do the work in the background.
  c.executionCtx.waitUntil(
    handleTelegramUpdate(c.env, c.req.header("x-telegram-bot-api-secret-token"), update).catch((e) => console.error("telegram", e)),
  );
  return c.json({ ok: true });
});

const app = new Hono<AppEnv>();

/** Everything the web app needs on start-up in one request. */
app.get("/bootstrap", async (c) => {
  const [settings, categories, accounts, counts] = await Promise.all([
    getSettings(c.env),
    all<Category>(c.env.DB, "SELECT * FROM categories ORDER BY kind, sort_order, id"),
    all<Account>(c.env.DB, "SELECT * FROM accounts ORDER BY archived, sort_order, id"),
    first<{ review: number; failed: number; tokens: number; transactions: number }>(
      c.env.DB,
      `SELECT (SELECT COUNT(*) FROM transactions WHERE needs_review = 1) AS review,
              (SELECT COUNT(*) FROM raw_messages WHERE status = 'failed') AS failed,
              (SELECT COUNT(*) FROM api_tokens) AS tokens,
              (SELECT COUNT(*) FROM transactions) AS transactions`,
    ),
  ]);
  return c.json({ settings, categories, accounts, counts, origin: new URL(c.req.url).origin });
});

app.get("/settings", async (c) => c.json(await getSettings(c.env)));

app.patch("/settings", async (c) => {
  const input = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!input || typeof input !== "object") badRequest("Expected an object");
  for (const [key, value] of Object.entries(input)) {
    const validate = EDITABLE[key];
    if (!validate) badRequest(`Unknown setting: ${key}`);
    const stored = validate(value);
    if (stored === null) badRequest(`Invalid value for ${key}`);
    await setSetting(c.env.DB, key, stored === "" ? null : stored);
  }
  return c.json(await getSettings(c.env));
});

// ---------------------------------------------------------------------------
// Telegram linking

app.post("/telegram/connect", async (c) => {
  if (!c.env.TELEGRAM_BOT_TOKEN) throw new HTTPException(400, { message: "Add the TELEGRAM_BOT_TOKEN secret first (see Settings → Telegram)." });
  const origin = new URL(c.req.url).origin;
  if (!origin.startsWith("https://")) throw new HTTPException(400, { message: "Telegram needs the deployed (https) address of the app." });
  return c.json(await startTelegramLink(c.env, origin));
});

app.post("/telegram/disconnect", async (c) => {
  await disconnectTelegram(c.env);
  return c.json({ ok: true });
});

app.post("/telegram/test", async (c) => {
  const ok = await notifyOwner(c.env, "👋 Test message from your Wallet app.");
  if (!ok) throw new HTTPException(400, { message: "Couldn't send. Is Telegram connected?" });
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Export

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  // Prevent spreadsheet formula injection and quote when needed.
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

app.get("/export/transactions.csv", async (c) => {
  const idx = await loadCategories(c.env.DB);
  const accounts = new Map((await all<Account>(c.env.DB, "SELECT * FROM accounts")).map((a) => [a.id, a.name]));
  const rows = await all<Transaction>(c.env.DB, `${TX_SELECT} ORDER BY t.occurred_at DESC`);
  const header = ["date", "time_utc", "account", "kind", "amount", "currency", "amount_azn", "merchant", "category", "note", "tags", "source", "excluded"];
  const lines = [header.join(",")];
  for (const t of rows) {
    lines.push(
      [
        t.local_date,
        t.occurred_at.slice(11, 16),
        t.account_id ? accounts.get(t.account_id) : "",
        t.kind,
        (t.amount / 100).toFixed(2),
        t.currency,
        (t.amount_base / 100).toFixed(2),
        t.merchant_name ?? t.merchant_raw ?? t.description ?? "",
        t.category_id ? categoryPath(idx, t.category_id) : "",
        t.note ?? "",
        t.tags ?? "",
        t.source,
        t.excluded ? "yes" : "",
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return new Response("﻿" + lines.join("\n"), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="wallet-transactions-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
});

const BACKUP_TABLES = ["accounts", "categories", "merchants", "rules", "transactions", "budgets", "insights", "raw_messages", "ai_usage"];

app.get("/export/backup.json", async (c) => {
  const data: Record<string, unknown[]> = {};
  for (const table of BACKUP_TABLES) data[table] = await all(c.env.DB, `SELECT * FROM ${table}`);
  // Settings without secrets.
  data.settings = (await all<{ key: string; value: string }>(c.env.DB, "SELECT key, value FROM settings")).filter(
    (s) => !/secret|telegram_chat|link_code/.test(s.key),
  );
  return new Response(JSON.stringify({ version: 1, exported_at: new Date().toISOString(), data }, null, 1), {
    headers: {
      "content-type": "application/json",
      "content-disposition": `attachment; filename="wallet-backup-${new Date().toISOString().slice(0, 10)}.json"`,
    },
  });
});

/** Danger zone: wipe all financial data (keeps settings, categories and login). */
app.post("/data/reset", async (c) => {
  const { confirm } = (await c.req.json().catch(() => ({}))) as { confirm?: string };
  if (confirm !== "DELETE EVERYTHING") badRequest('Type "DELETE EVERYTHING" to confirm');
  await c.env.DB.batch(
    ["raw_messages", "transactions", "merchants", "insights", "notifications_sent"].map((t) => c.env.DB.prepare(`DELETE FROM ${t}`)),
  );
  await c.env.DB.prepare("UPDATE accounts SET balance = NULL, balance_at = NULL").run();
  return c.json({ ok: true });
});

export default app;

