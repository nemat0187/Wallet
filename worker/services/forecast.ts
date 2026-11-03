import type { Env } from "../env";
import type { Account } from "@shared/types";
import { addDays, periodFor } from "@shared/money";
import { buildForecast, type Forecast } from "@shared/forecast";
import { all, first } from "../lib/db";
import { getSettings } from "./settings";
import { recurring, today } from "./analytics";

export async function forecast(env: Env): Promise<Forecast> {
  const settings = await getSettings(env);
  const now = today(settings);
  const period = periodFor(now, settings.month_start_day);
  const accounts = await all<Account>(env.DB, "SELECT * FROM accounts WHERE archived = 0 AND include_in_totals = 1 AND currency = 'AZN' AND balance IS NOT NULL");
  const spent = await first<{ v: number | null }>(
    env.DB,
    "SELECT -SUM(amount_base) AS v FROM transactions WHERE kind = 'expense' AND excluded = 0 AND amount_base < 0 AND local_date BETWEEN ? AND ?",
    addDays(now, -29),
    now,
  );
  // Cash withdrawals repeat too, but they are spending money, not bills.
  const bills = (await recurring(env)).filter((r) => !/cash|withdraw|atm|nağd/i.test(r.name)).map((r) => ({ name: r.name, amount: r.amount, cadence: r.cadence, next_date: r.next_date, active: r.active }));
  return buildForecast({
    balance: accounts.length ? accounts.reduce((s, a) => s + (a.balance ?? 0), 0) : null,
    bills,
    today: now,
    periodEnd: period.end,
    spentLast30: spent?.v ?? 0,
  });
}
