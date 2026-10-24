import type { Env } from "../env";
import type { Settings } from "@shared/types";
import { all, run } from "../lib/db";

export const MODEL_OPTIONS = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"] as const;

/** Defaults for user-editable settings (stored as strings in the `settings` table). */
const DEFAULTS: Record<string, string> = {
  month_start_day: "1",
  base_currency: "AZN",
  tz_offset_minutes: "240", // Asia/Baku, UTC+4 (no daylight saving)
  overall_budget: "",
  ai_enabled: "1",
  ai_monthly_cap_usd: "3",
  ai_fast_model: "claude-haiku-5-5",
  ai_smart_model: "claude-opus-5-5",
  ai_auto_reports: "1",
  notify_each_transaction: "1",
  notify_budget_alerts: "1",
  notify_reports: "1",
  atm_as_transfer: "0",
};

/** Keys the web app may change through PATCH /api/settings, with validation. */
export const EDITABLE: Record<string, (v: unknown) => string | null> = {
  month_start_day: (v) => (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 28 ? String(v) : null),
  tz_offset_minutes: (v) => (Number.isInteger(v) && Math.abs(v as number) <= 14 * 60 ? String(v) : null),
  overall_budget: (v) => (v === null ? "" : Number.isInteger(v) && (v as number) >= 0 ? String(v) : null),
  ai_enabled: bool,
  ai_monthly_cap_usd: (v) => (typeof v === "number" && v >= 0 && v <= 1000 ? String(v) : null),
  ai_fast_model: (v) => ((MODEL_OPTIONS as readonly string[]).includes(v as string) ? (v as string) : null),
  ai_smart_model: (v) => ((MODEL_OPTIONS as readonly string[]).includes(v as string) ? (v as string) : null),
  ai_auto_reports: bool,
  notify_each_transaction: bool,
  notify_budget_alerts: bool,
  notify_reports: bool,
  atm_as_transfer: bool,
};

function bool(v: unknown): string | null {
  return typeof v === "boolean" ? (v ? "1" : "0") : null;
}

export async function getRawSettings(db: D1Database): Promise<Record<string, string>> {
  const rows = await all<{ key: string; value: string }>(db, "SELECT key, value FROM settings");
  const map: Record<string, string> = { ...DEFAULTS };
  for (const r of rows) map[r.key] = r.value;
  return map;
}

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? DEFAULTS[key] ?? null;
}

export async function setSetting(db: D1Database, key: string, value: string | null): Promise<void> {
  if (value === null) await run(db, "DELETE FROM settings WHERE key = ?", key);
  else
    await run(
      db,
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
}

export function toSettings(raw: Record<string, string>, env: Env): Settings {
  return {
    month_start_day: Number(raw.month_start_day) || 1,
    base_currency: raw.base_currency || "AZN",
    tz_offset_minutes: Number(raw.tz_offset_minutes ?? 240),
    overall_budget: raw.overall_budget ? Number(raw.overall_budget) : null,
    ai_enabled: raw.ai_enabled === "1",
    ai_monthly_cap_usd: Number(raw.ai_monthly_cap_usd ?? 3),
    ai_fast_model: raw.ai_fast_model,
    ai_smart_model: raw.ai_smart_model,
    ai_auto_reports: raw.ai_auto_reports === "1",
    ai_configured: Boolean(env.ANTHROPIC_API_KEY),
    telegram_configured: Boolean(env.TELEGRAM_BOT_TOKEN),
    telegram_connected: Boolean(raw.telegram_chat_id),
    notify_each_transaction: raw.notify_each_transaction === "1",
    notify_budget_alerts: raw.notify_budget_alerts === "1",
    notify_reports: raw.notify_reports === "1",
    atm_as_transfer: raw.atm_as_transfer === "1",
    totp_enabled: Boolean(raw.totp_secret),
    last_message_at: raw.last_message_at || null,
  };
}

export async function getSettings(env: Env): Promise<Settings> {
  return toSettings(await getRawSettings(env.DB), env);
}
