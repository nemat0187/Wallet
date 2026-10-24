// Optional Telegram bot: instant notifications, budget alerts, quick cash
// entries ("12.5 taxi") and forwarding bank SMS by hand.

import type { Env } from "../env";
import { formatMoney, parseAmount, shiftPeriod } from "@shared/money";
import { first } from "../lib/db";
import { randomToken, safeEqual } from "../lib/crypto";
import { getRawSettings, getSettings, setSetting } from "./settings";
import { createContext, createTransaction } from "./transactions";
import { ingestMessage } from "./ingest";
import { categorizePendingWithAI, categoryPath, loadCategories } from "./categorize";
import { budgetStatus } from "./budgets";
import { today } from "./analytics";

const API = "https://api.telegram.org";

async function tg(env: Env, method: string, payload: Record<string, unknown>): Promise<any> {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("Telegram is not configured");
  const res = await fetch(`${API}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = (await res.json()) as { ok: boolean; result?: unknown; description?: string };
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description ?? res.status}`);
  return data.result;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Send a message to the owner's linked chat. Silently does nothing when Telegram isn't set up. */
export async function notifyOwner(env: Env, html: string): Promise<boolean> {
  if (!env.TELEGRAM_BOT_TOKEN) return false;
  const raw = await getRawSettings(env.DB);
  if (!raw.telegram_chat_id) return false;
  try {
    await tg(env, "sendMessage", { chat_id: raw.telegram_chat_id, text: html, parse_mode: "HTML", disable_web_page_preview: true });
    return true;
  } catch (e) {
    console.error("Telegram send failed", e);
    return false;
  }
}

/** Registers the webhook and returns a one-time link the owner opens to link their chat. */
export async function startTelegramLink(env: Env, origin: string): Promise<{ bot_username: string; link: string; code: string }> {
  const me = (await tg(env, "getMe", {})) as { username: string };
  const secret = randomToken(24);
  const code = randomToken(9).replace(/[^A-Za-z0-9]/g, "").slice(0, 10);
  await tg(env, "setWebhook", {
    url: `${origin}/api/telegram/webhook`,
    secret_token: secret,
    allowed_updates: ["message"],
    drop_pending_updates: true,
  });
  await setSetting(env.DB, "telegram_webhook_secret", secret);
  await setSetting(env.DB, "telegram_link_code", `${code}:${Date.now() + 15 * 60_000}`);
  return { bot_username: me.username, code, link: `https://t.me/${me.username}?start=${code}` };
}

export async function disconnectTelegram(env: Env): Promise<void> {
  try {
    await tg(env, "deleteWebhook", {});
  } catch {
    // token may already be gone
  }
  for (const key of ["telegram_chat_id", "telegram_webhook_secret", "telegram_link_code"]) await setSetting(env.DB, key, null);
}

interface TgUpdate {
  message?: { chat: { id: number }; text?: string; caption?: string };
}

export async function handleTelegramUpdate(env: Env, secretHeader: string | undefined, update: TgUpdate): Promise<void> {
  const raw = await getRawSettings(env.DB);
  if (!raw.telegram_webhook_secret || !secretHeader || !(await safeEqual(secretHeader, raw.telegram_webhook_secret))) return;
  const msg = update.message;
  const text = (msg?.text ?? msg?.caption ?? "").trim();
  if (!msg || !text) return;
  const chatId = String(msg.chat.id);
  const reply = (html: string) => tg(env, "sendMessage", { chat_id: chatId, text: html, parse_mode: "HTML" });

  // Linking: /start <code>
  if (text.startsWith("/start")) {
    const code = text.split(/\s+/)[1] ?? "";
    const [expected, expires] = (raw.telegram_link_code ?? "").split(":");
    if (expected && code === expected && Number(expires) > Date.now()) {
      await setSetting(env.DB, "telegram_chat_id", chatId);
      await setSetting(env.DB, "telegram_link_code", null);
      await reply("✅ <b>Connected!</b> You'll get spending notifications here.\n\nSend <code>12.5 taxi</code> to add a cash expense, or /help for more.");
    } else if (raw.telegram_chat_id !== chatId) {
      await reply("This is a private bot.");
    } else {
      await reply("Already connected. Send /help to see what I can do.");
    }
    return;
  }
  if (raw.telegram_chat_id !== chatId) return; // ignore strangers completely

  if (text === "/help") {
    await reply(
      [
        "<b>What I can do</b>",
        "• <code>12.5 taxi</code> or <code>lunch 8</code> — add a cash expense",
        "• <code>+200 gift from mom</code> — add cash income",
        "• Forward or paste a bank SMS — I'll record it",
        "• /today — today's spending",
        "• /month — this period's spending and budgets",
      ].join("\n"),
    );
    return;
  }
  if (text === "/today" || text === "/month") {
    await reply(await summaryText(env, text === "/today" ? "today" : "month"));
    return;
  }

  // A forwarded bank notification (has a currency and looks like a card message).
  if (/(AZN|USD|EUR|₼)/i.test(text) && /(kart|card|карт|balans|balance|\*\d{4})/i.test(text)) {
    const r = await ingestMessage(env, { body: text, source: "sms" });
    await reply(
      r.status === "parsed"
        ? "✅ Bank message recorded."
        : r.status === "duplicate"
          ? "Already recorded."
          : `⚠️ Couldn't read that message (${escapeHtml(r.error ?? r.status)}). You can fix it in the app's Inbox.`,
    );
    return;
  }

  // Quick add: "12.5 taxi", "taxi 12.5", "+200 salary"
  const m = text.match(/^([+-]?\d+(?:[.,]\d{1,2})?)\s+(.+)$/) ?? text.match(/^(.+?)\s+([+-]?\d+(?:[.,]\d{1,2})?)$/);
  if (!m) {
    await reply("I didn't understand. Try <code>12.5 taxi</code> or /help.");
    return;
  }
  const [amountText, label] = /^[+-]?\d/.test(m[1]) ? [m[1], m[2]] : [m[2], m[1]];
  const value = parseAmount(amountText.replace(/^[+-]/, ""));
  if (!value) {
    await reply("That amount doesn't look right.");
    return;
  }
  const income = amountText.startsWith("+");
  const ctx = await createContext(env);
  const cash = await first<{ id: number; name: string }>(env.DB, "SELECT id, name FROM accounts WHERE type = 'cash' AND archived = 0 ORDER BY id LIMIT 1");
  const created = await createTransaction(
    env,
    {
      account_id: cash?.id ?? null,
      occurred_at: new Date().toISOString(),
      amount: income ? value : -value,
      currency: ctx.settings.base_currency,
      merchant_raw: label.slice(0, 80),
      description: "Added via Telegram",
      source: "telegram",
      type: income ? "income" : "purchase",
      external_ref: `tg:${chatId}:${Date.now()}`,
    },
    ctx,
  );
  const tx = await first<{ category_id: number | null }>(env.DB, "SELECT category_id FROM transactions WHERE id = ?", created.id);
  await reply(
    `✅ ${income ? "Income" : "Expense"} <b>${formatMoney(value)}</b> · ${escapeHtml(label)}\n` +
      `Category: ${escapeHtml(tx?.category_id ? categoryPath(ctx.idx, tx.category_id) : "Uncategorized")}${created.needs_ai ? " (AI will refine)" : ""}` +
      `${cash ? ` · ${escapeHtml(cash.name)}` : ""}`,
  );
  if (created.needs_ai) await categorizePendingWithAI(env, 5);
}

async function summaryText(env: Env, scope: "today" | "month"): Promise<string> {
  const settings = await getSettings(env);
  const now = today(settings);
  const period = shiftPeriod(now, settings.month_start_day, 0);
  const start = scope === "today" ? now : period.start;
  const row = await first<{ spent: number | null; n: number }>(
    env.DB,
    "SELECT -SUM(amount_base) AS spent, COUNT(*) AS n FROM transactions WHERE kind = 'expense' AND excluded = 0 AND local_date BETWEEN ? AND ?",
    start,
    now,
  );
  const lines = [`<b>${scope === "today" ? "Today" : period.label}</b>: spent ${formatMoney(row?.spent ?? 0)} in ${row?.n ?? 0} transactions`];
  if (scope === "month") {
    const idx = await loadCategories(env.DB);
    const b = await budgetStatus(env.DB, idx, settings, period, now);
    if (b.overall) lines.push(`Overall budget: ${formatMoney(b.overall.spent)} / ${formatMoney(b.overall.amount)} (${Math.round(b.overall.pct)}%)`);
    for (const x of b.categories.slice(0, 8)) {
      const icon = x.status === "over" ? "🔴" : x.status === "warning" ? "🟠" : "🟢";
      lines.push(`${icon} ${escapeHtml(categoryPath(idx, x.category_id!))}: ${formatMoney(x.spent)} / ${formatMoney(x.amount)}`);
    }
  }
  return lines.join("\n");
}
