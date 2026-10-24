// Budget status: how much of each monthly budget is used, and where the
// current pace of spending will land by the end of the period.

import type { BudgetStatus, Settings } from "@shared/types";
import { daysBetween } from "@shared/money";
import { all } from "../lib/db";
import type { CategoryIndex } from "./categorize";

export interface BudgetRow {
  id: number;
  category_id: number;
  amount: number;
  alert_pct: number;
}

/** Spending (positive minor units) per category id in a date range, excluding transfers and excluded rows. */
export async function spendingByCategory(db: D1Database, start: string, end: string): Promise<Map<number, number>> {
  const rows = await all<{ category_id: number | null; spent: number }>(
    db,
    `SELECT category_id, -SUM(amount_base) AS spent FROM transactions
      WHERE kind = 'expense' AND excluded = 0 AND local_date BETWEEN ? AND ?
      GROUP BY category_id`,
    start,
    end,
  );
  return new Map(rows.map((r) => [r.category_id ?? 0, r.spent]));
}

/** Adds each child's spending into its parent so parent budgets include subcategories. */
export function rollUp(idx: CategoryIndex, byCategory: Map<number, number>): Map<number, number> {
  const out = new Map<number, number>();
  for (const [id, spent] of byCategory) {
    out.set(id, (out.get(id) ?? 0) + spent);
    const parent = idx.byId.get(id)?.parent_id;
    if (parent) out.set(parent, (out.get(parent) ?? 0) + spent);
  }
  return out;
}

export function makeStatus(
  id: number | null,
  categoryId: number | null,
  amount: number,
  spent: number,
  alertPct: number,
  period: { start: string; end: string },
  today: string,
): BudgetStatus {
  const totalDays = daysBetween(period.start, period.end) + 1;
  const elapsed = today < period.start ? 0 : today > period.end ? totalDays : daysBetween(period.start, today) + 1;
  const projected = elapsed > 0 && elapsed < totalDays ? Math.round((spent / elapsed) * totalDays) : spent;
  const pct = amount > 0 ? Math.round((spent / amount) * 1000) / 10 : 0;
  const status: BudgetStatus["status"] =
    spent > amount ? "over" : pct >= alertPct || (elapsed >= 5 && projected > amount * 1.05) ? "warning" : "ok";
  return { id, category_id: categoryId, amount, spent, remaining: amount - spent, pct, projected, alert_pct: alertPct, status };
}

export async function budgetStatus(
  db: D1Database,
  idx: CategoryIndex,
  settings: Settings,
  period: { start: string; end: string },
  today: string,
): Promise<{ overall: BudgetStatus | null; categories: BudgetStatus[]; total_spent: number }> {
  const [budgets, byCategory] = await Promise.all([
    all<BudgetRow>(db, "SELECT id, category_id, amount, alert_pct FROM budgets"),
    spendingByCategory(db, period.start, period.end),
  ]);
  const rolled = rollUp(idx, byCategory);
  let total = 0;
  for (const v of byCategory.values()) total += v;
  const categories = budgets
    .filter((b) => idx.byId.has(b.category_id))
    .map((b) => makeStatus(b.id, b.category_id, b.amount, rolled.get(b.category_id) ?? 0, b.alert_pct, period, today))
    .sort((a, b) => b.pct - a.pct);
  const overall = settings.overall_budget
    ? makeStatus(null, null, settings.overall_budget, total, 90, period, today)
    : null;
  return { overall, categories, total_spent: total };
}
