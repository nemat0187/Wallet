// Hourly background job (Cloudflare Cron Trigger).

import type { Env } from "../env";
import { localDate, localHour, periodFor, formatMoney } from "@shared/money";
import { first, nowIso } from "../lib/db";
import { categorizeAllPending } from "./categorize";
import { fetchCbarRates } from "./fx";
import { generateReport } from "./insights";
import { getSettings } from "./settings";
import { checkBudgetAlerts } from "./alerts";
import { notifyOwner, escapeHtml } from "./telegram";
import { ensureSeeded } from "./seed";

const REPORT_HOUR = 9; // local time

export async function runScheduled(env: Env, when = new Date()): Promise<void> {
  await ensureSeeded(env.DB);
  const settings = await getSettings(env);
  const hour = localHour(when, settings.tz_offset_minutes);
  const ymd = localDate(when, settings.tz_offset_minutes);

  // 1. Categorize anything still waiting for AI (e.g. after an outage or cap reset).
  await categorizeAllPending(env, 3);

  if (hour !== REPORT_HOUR) return;

  // 2. Daily: exchange rates, budget alerts, housekeeping.
  try {
    await fetchCbarRates(env.DB, ymd);
  } catch (e) {
    console.error("cron: fx", e);
  }
  try {
    await checkBudgetAlerts(env);
  } catch (e) {
    console.error("cron: budget alerts", e);
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(nowIso()),
    env.DB.prepare("DELETE FROM login_attempts WHERE window_start < ? AND (locked_until IS NULL OR locked_until < ?)").bind(
      new Date(Date.now() - 86_400_000).toISOString(),
      nowIso(),
    ),
    env.DB.prepare("DELETE FROM raw_messages WHERE status IN ('ignored', 'duplicate') AND received_at < ?").bind(
      new Date(Date.now() - 90 * 86_400_000).toISOString(),
    ),
  ]);

  if (!settings.ai_auto_reports) return;
  // 3. Monthly report on the first day of a new budget period, weekly report on Mondays.
  const isPeriodStart = periodFor(ymd, settings.month_start_day).start === ymd;
  const isMonday = new Date(`${ymd}T00:00:00Z`).getUTCDay() === 1;
  const kind = isPeriodStart ? "monthly" : isMonday ? "weekly" : null;
  if (!kind) return;
  const already = await first<{ id: number }>(
    env.DB,
    "SELECT id FROM insights WHERE kind = ? AND substr(created_at, 1, 10) >= ?",
    kind,
    new Date(when.getTime() - 20 * 3600_000).toISOString().slice(0, 10),
  );
  if (already) return;
  try {
    const result = await generateReport(env, kind);
    if ("id" in result && settings.notify_reports) {
      const row = await first<{ title: string; data: string }>(env.DB, "SELECT title, data FROM insights WHERE id = ?", result.id);
      if (row) {
        const data = JSON.parse(row.data) as { headline: string; recommendations: { title: string; potential_monthly_savings: number | null }[] };
        const tips = data.recommendations
          .slice(0, 3)
          .map((r) => `• ${escapeHtml(r.title)}${r.potential_monthly_savings ? ` (save ~${formatMoney(Math.round(r.potential_monthly_savings * 100))}/mo)` : ""}`);
        await notifyOwner(env, [`🧠 <b>${escapeHtml(row.title)}</b>`, escapeHtml(data.headline), ...tips].join("\n"));
      }
    }
  } catch (e) {
    console.error("cron: report", e);
  }
}
