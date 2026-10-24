// Statistics computed from transactions. Heavy lifting is done in SQL so the
// worker stays well inside Cloudflare's CPU limits.

import type { Env } from "../env";
import type { Account, Settings, Transaction } from "@shared/types";
import { addDays, daysBetween, localDate, periodFor, shiftPeriod } from "@shared/money";
import { all, first } from "../lib/db";
import { loadCategories, type CategoryIndex } from "./categorize";
import { budgetStatus, rollUp, spendingByCategory } from "./budgets";
import { getSettings } from "./settings";
import { sqlOffset } from "./ai";

export const TX_SELECT = `SELECT t.*, m.name AS merchant_name FROM transactions t LEFT JOIN merchants m ON m.id = t.merchant_id`;

export function today(settings: Settings): string {
  return localDate(new Date(), settings.tz_offset_minutes);
}

interface Totals {
  spent: number;
  income: number;
  count: number;
}

async function totals(db: D1Database, start: string, end: string): Promise<Totals> {
  const row = await first<{ spent: number | null; income: number | null; count: number }>(
    db,
    `SELECT -SUM(CASE WHEN kind = 'expense' THEN amount_base END) AS spent,
            SUM(CASE WHEN kind = 'income' THEN amount_base END) AS income,
            COUNT(*) AS count
       FROM transactions WHERE excluded = 0 AND local_date BETWEEN ? AND ?`,
    start,
    end,
  );
  return { spent: row?.spent ?? 0, income: row?.income ?? 0, count: row?.count ?? 0 };
}

/** Parent-level category breakdown with children, sorted by spending. */
export function breakdown(idx: CategoryIndex, byCategory: Map<number, number>) {
  const rolled = rollUp(idx, byCategory);
  const parents = idx.list.filter((c) => c.parent_id === null && c.kind === "expense");
  return parents
    .map((p) => ({
      category_id: p.id,
      spent: rolled.get(p.id) ?? 0,
      children: idx.list
        .filter((c) => c.parent_id === p.id)
        .map((c) => ({ category_id: c.id, spent: byCategory.get(c.id) ?? 0 }))
        .filter((c) => c.spent !== 0)
        .sort((a, b) => b.spent - a.spent),
    }))
    .filter((p) => p.spent !== 0)
    .sort((a, b) => b.spent - a.spent);
}

export async function dashboard(env: Env, anchor?: string) {
  const db = env.DB;
  const settings = await getSettings(env);
  const idx = await loadCategories(db);
  const now = today(settings);
  const period = periodFor(anchor ?? now, settings.month_start_day);
  const prev = shiftPeriod(period.start, settings.month_start_day, -1);
  const isCurrent = now >= period.start && now <= period.end;
  const elapsedDays = isCurrent ? daysBetween(period.start, now) + 1 : daysBetween(period.start, period.end) + 1;
  const totalDays = daysBetween(period.start, period.end) + 1;
  // Compare with the same number of days into the previous period.
  const prevSameEnd = addDays(prev.start, Math.min(elapsedDays, daysBetween(prev.start, prev.end) + 1) - 1);

  const [cur, prevSame, prevFull, byCategory, daily, topMerchants, recent, accounts, budgets, counts, insight] = await Promise.all([
    totals(db, period.start, period.end),
    totals(db, prev.start, prevSameEnd),
    totals(db, prev.start, prev.end),
    spendingByCategory(db, period.start, period.end),
    all<{ date: string; spent: number; income: number }>(
      db,
      `SELECT local_date AS date,
              -SUM(CASE WHEN kind = 'expense' THEN amount_base ELSE 0 END) AS spent,
              SUM(CASE WHEN kind = 'income' THEN amount_base ELSE 0 END) AS income
         FROM transactions WHERE excluded = 0 AND local_date BETWEEN ? AND ?
        GROUP BY local_date ORDER BY local_date`,
      period.start,
      period.end,
    ),
    all<{ merchant_id: number; name: string; spent: number; count: number; category_id: number | null }>(
      db,
      `SELECT m.id AS merchant_id, m.name, -SUM(t.amount_base) AS spent, COUNT(*) AS count, m.category_id
         FROM transactions t JOIN merchants m ON m.id = t.merchant_id
        WHERE t.kind = 'expense' AND t.excluded = 0 AND t.local_date BETWEEN ? AND ?
        GROUP BY m.id ORDER BY spent DESC LIMIT 6`,
      period.start,
      period.end,
    ),
    all<Transaction>(db, `${TX_SELECT} ORDER BY t.occurred_at DESC, t.id DESC LIMIT 8`),
    all<Account>(db, "SELECT * FROM accounts WHERE archived = 0 ORDER BY sort_order, id"),
    budgetStatus(db, idx, settings, period, now),
    first<{ review: number; failed: number; uncategorized: number }>(
      db,
      `SELECT (SELECT COUNT(*) FROM transactions WHERE needs_review = 1) AS review,
              (SELECT COUNT(*) FROM raw_messages WHERE status = 'failed') AS failed,
              (SELECT COUNT(*) FROM transactions t JOIN categories c ON c.id = t.category_id WHERE c.slug = 'uncategorized') AS uncategorized`,
    ),
    first<{ id: number; title: string; data: string; created_at: string }>(
      db,
      "SELECT id, title, data, created_at FROM insights ORDER BY created_at DESC LIMIT 1",
    ),
  ]);

  const budgetAmount = budgets.overall?.amount ?? null;
  const remainingDays = isCurrent ? totalDays - elapsedDays + 1 : 0;
  const safeToSpendPerDay =
    budgetAmount !== null && isCurrent ? Math.max(0, Math.floor((budgetAmount - cur.spent) / Math.max(1, remainingDays))) : null;

  let insightTeaser = null;
  if (insight) {
    try {
      const data = JSON.parse(insight.data);
      insightTeaser = { id: insight.id, title: insight.title, headline: data.headline, created_at: insight.created_at, tips: (data.recommendations ?? []).slice(0, 2) };
    } catch {
      insightTeaser = null;
    }
  }

  return {
    period: { ...period, is_current: isCurrent, elapsed_days: elapsedDays, total_days: totalDays },
    prev_period: prev,
    totals: cur,
    prev_same_point: prevSame,
    prev_full: prevFull,
    avg_daily_spent: Math.round(cur.spent / Math.max(1, elapsedDays)),
    safe_to_spend_per_day: safeToSpendPerDay,
    categories: breakdown(idx, byCategory),
    daily,
    top_merchants: topMerchants,
    recent,
    accounts,
    budgets,
    counts: counts ?? { review: 0, failed: 0, uncategorized: 0 },
    insight: insightTeaser,
  };
}

/** Income, spending and savings for each of the last `count` periods. */
export async function trends(env: Env, count = 12) {
  const db = env.DB;
  const settings = await getSettings(env);
  const idx = await loadCategories(db);
  const now = today(settings);
  const periods = Array.from({ length: count }, (_, i) => shiftPeriod(now, settings.month_start_day, -(count - 1 - i)));
  const start = periods[0].start;
  const end = periods[periods.length - 1].end;
  const rows = await all<{ local_date: string; kind: string; category_id: number | null; amount: number }>(
    db,
    `SELECT local_date, kind, category_id, SUM(amount_base) AS amount FROM transactions
      WHERE excluded = 0 AND kind <> 'transfer' AND local_date BETWEEN ? AND ?
      GROUP BY local_date, kind, category_id`,
    start,
    end,
  );
  const out = periods.map((p) => ({ ...p, income: 0, spent: 0, net: 0, by_category: {} as Record<number, number> }));
  for (const r of rows) {
    const bucket = out.find((p) => r.local_date >= p.start && r.local_date <= p.end);
    if (!bucket) continue;
    if (r.kind === "income") bucket.income += r.amount;
    else {
      bucket.spent -= r.amount;
      const cat = r.category_id ? idx.byId.get(r.category_id) : undefined;
      const parentId = cat?.parent_id ?? cat?.id ?? 0;
      bucket.by_category[parentId] = (bucket.by_category[parentId] ?? 0) - r.amount;
    }
  }
  for (const p of out) p.net = p.income - p.spent;
  return out;
}

export async function categoryReport(env: Env, from: string, to: string) {
  const idx = await loadCategories(env.DB);
  return breakdown(idx, await spendingByCategory(env.DB, from, to));
}

export async function merchantReport(env: Env, from: string, to: string, limit = 50) {
  return all<{ merchant_id: number; name: string; category_id: number | null; spent: number; count: number; avg: number; last_date: string }>(
    env.DB,
    `SELECT m.id AS merchant_id, m.name, m.category_id, -SUM(t.amount_base) AS spent, COUNT(*) AS count,
            -CAST(AVG(t.amount_base) AS INTEGER) AS avg, MAX(t.local_date) AS last_date
       FROM transactions t JOIN merchants m ON m.id = t.merchant_id
      WHERE t.kind = 'expense' AND t.excluded = 0 AND t.local_date BETWEEN ? AND ?
      GROUP BY m.id ORDER BY spent DESC LIMIT ?`,
    from,
    to,
    limit,
  );
}

/** Spending by weekday (0 = Sunday) and local hour. */
export async function heatmap(env: Env, from: string, to: string) {
  const settings = await getSettings(env);
  const offset = sqlOffset(settings.tz_offset_minutes);
  return all<{ weekday: number; hour: number; spent: number; count: number }>(
    env.DB,
    `SELECT CAST(strftime('%w', local_date) AS INTEGER) AS weekday,
            CAST(strftime('%H', occurred_at, ?) AS INTEGER) AS hour,
            -SUM(amount_base) AS spent, COUNT(*) AS count
       FROM transactions WHERE kind = 'expense' AND excluded = 0 AND amount_base < 0 AND local_date BETWEEN ? AND ?
      GROUP BY weekday, hour`,
    offset,
    from,
    to,
  );
}

export interface Recurring {
  merchant_id: number;
  name: string;
  category_id: number | null;
  cadence: "weekly" | "biweekly" | "monthly" | "quarterly" | "yearly";
  amount: number;
  variable: boolean;
  count: number;
  last_date: string;
  next_date: string;
  monthly_cost: number;
  active: boolean;
}

const CADENCES: { name: Recurring["cadence"]; min: number; max: number; days: number }[] = [
  { name: "weekly", min: 6, max: 8, days: 7 },
  { name: "biweekly", min: 13, max: 16, days: 14 },
  { name: "monthly", min: 26, max: 35, days: 30.44 },
  { name: "quarterly", min: 84, max: 98, days: 91.3 },
  { name: "yearly", min: 350, max: 380, days: 365.25 },
];

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Detect subscriptions and regular bills: same merchant, similar amount, regular interval. */
export function detectRecurring(
  rows: { merchant_id: number; name: string; category_id: number | null; local_date: string; amount: number }[],
  todayYmd: string,
): Recurring[] {
  const byMerchant = new Map<number, typeof rows>();
  for (const r of rows) {
    const list = byMerchant.get(r.merchant_id) ?? [];
    list.push(r);
    byMerchant.set(r.merchant_id, list);
  }
  const out: Recurring[] = [];
  for (const list of byMerchant.values()) {
    // One charge per day at most (several same-day purchases are not a subscription pattern).
    const perDay = new Map<string, number>();
    for (const r of list) perDay.set(r.local_date, (perDay.get(r.local_date) ?? 0) + r.amount);
    const dates = [...perDay.keys()].sort();
    if (dates.length < 2) continue;
    const intervals = dates.slice(1).map((d, i) => daysBetween(dates[i], d));
    const med = median(intervals);
    const cadence = CADENCES.find((c) => med >= c.min && med <= c.max);
    if (!cadence) continue;
    if (cadence.name !== "yearly" && dates.length < 3) continue;
    const regular = intervals.filter((x) => x >= cadence.min * 0.8 && x <= cadence.max * 1.2).length / intervals.length;
    if (regular < 0.7) continue;
    const amounts = dates.map((d) => perDay.get(d)!);
    const medAmount = median(amounts);
    const spread = Math.max(...amounts.map((a) => Math.abs(a - medAmount))) / Math.max(1, medAmount);
    if (spread > 0.35) continue;
    const last = dates[dates.length - 1];
    const next = addDays(last, Math.round(cadence.days));
    out.push({
      merchant_id: list[0].merchant_id,
      name: list[0].name,
      category_id: list[0].category_id,
      cadence: cadence.name,
      amount: Math.round(medAmount),
      variable: spread > 0.15,
      count: dates.length,
      last_date: last,
      next_date: next,
      monthly_cost: Math.round((medAmount * 30.44) / cadence.days),
      active: daysBetween(last, todayYmd) <= cadence.days * 1.6,
    });
  }
  return out.sort((a, b) => Number(b.active) - Number(a.active) || b.monthly_cost - a.monthly_cost);
}

export async function recurring(env: Env): Promise<Recurring[]> {
  const settings = await getSettings(env);
  const now = today(settings);
  const rows = await all<{ merchant_id: number; name: string; category_id: number | null; local_date: string; amount: number }>(
    env.DB,
    `SELECT t.merchant_id, m.name, COALESCE(m.category_id, t.category_id) AS category_id, t.local_date, -t.amount_base AS amount
       FROM transactions t JOIN merchants m ON m.id = t.merchant_id
      WHERE t.kind = 'expense' AND t.excluded = 0 AND t.amount_base < 0 AND t.local_date >= ?
      ORDER BY t.local_date`,
    addDays(now, -400),
  );
  return detectRecurring(rows, now);
}

/** Unusually large transactions compared with the merchant's (or category's) usual amount. */
export async function anomalies(env: Env, from: string, to: string) {
  const rows = await all<Transaction & { typical: number | null; samples: number }>(
    env.DB,
    `WITH hist AS (
       SELECT merchant_id, AVG(-amount_base) AS typical, COUNT(*) AS samples FROM transactions
        WHERE kind = 'expense' AND amount_base < 0 AND merchant_id IS NOT NULL AND local_date < ?
        GROUP BY merchant_id
     )
     SELECT t.*, m.name AS merchant_name, h.typical, COALESCE(h.samples, 0) AS samples
       FROM transactions t LEFT JOIN merchants m ON m.id = t.merchant_id LEFT JOIN hist h ON h.merchant_id = t.merchant_id
      WHERE t.kind = 'expense' AND t.excluded = 0 AND t.amount_base < 0 AND t.merchant_id IS NOT NULL
        AND t.local_date BETWEEN ? AND ?
      ORDER BY t.amount_base ASC LIMIT 200`,
    from,
    from,
    to,
  );
  const overall = await first<{ avg: number | null }>(
    env.DB,
    "SELECT AVG(-amount_base) AS avg FROM transactions WHERE kind = 'expense' AND amount_base < 0 AND local_date >= ?",
    addDays(from, -180),
  );
  const avgTx = overall?.avg ?? 0;
  return rows
    .filter((t) => {
      const amount = -t.amount_base;
      if (t.samples >= 3 && t.typical) return amount > t.typical * 2.5 && amount > 2000;
      return avgTx > 0 && amount > avgTx * 4 && amount > 10000;
    })
    .slice(0, 10)
    .map((t) => ({ ...t, typical: t.typical ? Math.round(t.typical) : null }));
}
