// "Cash after bills": what is left of the money on your cards once the bills that usually repeat have been paid,
// spread over the days until the end of the budget month. Pure functions so they can be tested.

import { addDays, daysBetween } from "./money";

export interface RecurringBill {
  name: string;
  amount: number; // minor units, positive
  cadence: "weekly" | "biweekly" | "monthly" | "quarterly" | "yearly";
  next_date: string;
  active: boolean;
}

export interface DueBill {
  name: string;
  amount: number;
  date: string;
}

const STEP_DAYS: Record<RecurringBill["cadence"], number> = { weekly: 7, biweekly: 14, monthly: 30, quarterly: 91, yearly: 365 };

/** Every payment of the active recurring bills that falls between `from` and `to` (inclusive), earliest first. */
export function billsBetween(bills: RecurringBill[], from: string, to: string): DueBill[] {
  const out: DueBill[] = [];
  for (const b of bills) {
    if (!b.active) continue;
    const step = STEP_DAYS[b.cadence];
    let date = b.next_date;
    // A payment expected earlier that has not shown up yet is not due "today": jump to its next occurrence.
    for (let guard = 0; date < from && guard < 400; guard++) date = addDays(date, step);
    for (let guard = 0; date <= to && guard < 60; guard++) {
      out.push({ name: b.name, amount: b.amount, date });
      date = addDays(date, step);
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount);
}

export interface Forecast {
  /** Money on the counted cards now, or null when no balance is known. */
  balance: number | null;
  period_end: string;
  days_left: number;
  bills: DueBill[];
  bills_total: number;
  /** Balance minus the bills still to come; negative means the bills are more than the balance. */
  after_bills: number | null;
  /** What can be spent per day until the end of the period (never below zero). */
  per_day: number | null;
  /** Average daily spending over the last 30 days, for comparison. */
  typical_daily: number;
}

export function buildForecast(input: { balance: number | null; bills: RecurringBill[]; today: string; periodEnd: string; spentLast30: number }): Forecast {
  const daysLeft = Math.max(1, daysBetween(input.today, input.periodEnd) + 1);
  const due = billsBetween(input.bills, input.today, input.periodEnd);
  const total = due.reduce((s, b) => s + b.amount, 0);
  const after = input.balance === null ? null : input.balance - total;
  return {
    balance: input.balance,
    period_end: input.periodEnd,
    days_left: daysLeft,
    bills: due,
    bills_total: total,
    after_bills: after,
    per_day: after === null ? null : Math.max(0, Math.floor(after / daysLeft)),
    typical_daily: Math.round(input.spentLast30 / 30),
  };
}
