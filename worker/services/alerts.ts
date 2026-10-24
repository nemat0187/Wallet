// Work that runs right after new transactions arrive (in the background, after
// the phone already got its response): AI categorization, notifications and
// budget alerts.

import type { Env } from "../env";
import type { Transaction } from "@shared/types";
import { formatMoney, shiftPeriod } from "@shared/money";
import { all, first, nowIso, placeholders, run } from "../lib/db";
import { categorizePendingWithAI, categoryPath, loadCategories } from "./categorize";
import { budgetStatus } from "./budgets";
import { getSettings } from "./settings";
import { escapeHtml, notifyOwner } from "./telegram";
import { today } from "./analytics";

export async function afterTransactions(env: Env, ids: number[], opts: { needsAi: boolean }): Promise<void> {
  if (ids.length === 0) return;
  try {
    if (opts.needsAi) await categorizePendingWithAI(env);
  } catch (e) {
    console.error("AI categorization failed", e);
  }
  const settings = await getSettings(env);
  if (!settings.telegram_connected || !env.TELEGRAM_BOT_TOKEN) return;

  const idx = await loadCategories(env.DB);
  if (settings.notify_each_transaction) {
    const txs = await all<Transaction & { account_name: string | null }>(
      env.DB,
      `SELECT t.*, m.name AS merchant_name, a.name AS account_name FROM transactions t
         LEFT JOIN merchants m ON m.id = t.merchant_id LEFT JOIN accounts a ON a.id = t.account_id
        WHERE t.id IN (${placeholders(ids.length)})`,
      ...ids,
    );
    for (const t of txs) {
      const icon = t.amount < 0 ? "💳" : "💰";
      const who = t.merchant_name ?? t.merchant_raw ?? t.description ?? "Transaction";
      const lines = [
        `${icon} <b>${formatMoney(t.amount, t.currency, { sign: true })}</b> · ${escapeHtml(who)}`,
        `${escapeHtml(t.category_id ? categoryPath(idx, t.category_id) : "Uncategorized")}${t.account_name ? ` · ${escapeHtml(t.account_name)}` : ""}`,
      ];
      if (t.balance_after !== null) lines.push(`Balance: ${formatMoney(t.balance_after, t.currency)}`);
      const unusual = await isUnusual(env.DB, t);
      if (unusual) lines.push(`⚠️ Unusually large — you usually spend about ${formatMoney(unusual)} here.`);
      await notifyOwner(env, lines.join("\n"));
    }
  }
  if (settings.notify_budget_alerts) await checkBudgetAlerts(env);
}

async function isUnusual(db: D1Database, t: Transaction): Promise<number | null> {
  if (t.amount_base >= 0 || !t.merchant_id) return null;
  const row = await first<{ typical: number | null; n: number }>(
    db,
    "SELECT AVG(-amount_base) AS typical, COUNT(*) AS n FROM transactions WHERE merchant_id = ? AND id <> ? AND amount_base < 0",
    t.merchant_id,
    t.id,
  );
  if (!row?.typical || row.n < 3) return null;
  return -t.amount_base > row.typical * 2.5 && -t.amount_base > 2000 ? Math.round(row.typical) : null;
}

/** Sends each budget alert (threshold reached / exceeded) at most once per period. */
export async function checkBudgetAlerts(env: Env): Promise<void> {
  const settings = await getSettings(env);
  const idx = await loadCategories(env.DB);
  const now = today(settings);
  const period = shiftPeriod(now, settings.month_start_day, 0);
  const status = await budgetStatus(env.DB, idx, settings, period, now);
  const budgets = [...(status.overall ? [status.overall] : []), ...status.categories];
  for (const b of budgets) {
    const level = b.spent > b.amount ? 100 : b.pct >= b.alert_pct ? b.alert_pct : 0;
    if (!level) continue;
    const key = `budget:${b.category_id ?? "overall"}:${period.start}:${level}`;
    const sent = await first<{ key: string }>(env.DB, "SELECT key FROM notifications_sent WHERE key = ?", key);
    if (sent) continue;
    const name = b.category_id ? categoryPath(idx, b.category_id) : "Overall budget";
    const text =
      level === 100
        ? `🔴 <b>${escapeHtml(name)}</b> is over budget: ${formatMoney(b.spent)} of ${formatMoney(b.amount)}.`
        : `🟠 <b>${escapeHtml(name)}</b>: ${Math.round(b.pct)}% of the budget used (${formatMoney(b.spent)} of ${formatMoney(b.amount)}). At this pace you'll reach ${formatMoney(b.projected)} by ${period.end}.`;
    if (await notifyOwner(env, text)) await run(env.DB, "INSERT OR IGNORE INTO notifications_sent (key, created_at) VALUES (?, ?)", key, nowIso());
  }
}

