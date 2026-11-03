import type { Env } from "../env";
import type { Settings } from "@shared/types";
import type { HomeItem } from "@shared/home";
import { HomeLayoutSchema } from "../routes/dashboards";
import { all, run } from "../lib/db";
import { ScopedD1, userIdOfDb } from "../lib/scoped";

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
  home_layout: "",
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
  // null = back to the default layout
  home_layout: (v) => {
    if (v === null) return "";
    const parsed = HomeLayoutSchema.safeParse(v);
    return parsed.success ? JSON.stringify(parsed.data) : null;
  },
};

function bool(v: unknown): string | null {
  return typeof v === "boolean" ? (v ? "1" : "0") : null;
}

/** Settings that belong to the installation, not to a user (the Telegram bot has one webhook secret). */
const GLOBAL_KEYS = new Set(["telegram_webhook_secret"]);

function owner(db: D1Database): { raw: D1Database; userId: number } {
  return { raw: db instanceof ScopedD1 ? db.raw : db, userId: userIdOfDb(db) };
}

export async function getRawSettings(db: D1Database): Promise<Record<string, string>> {
  const { raw, userId } = owner(db);
  const rows = await all<{ key: string; value: string }>(raw, "SELECT key, value FROM user_settings WHERE user_id = ?", userId);
  const map: Record<string, string> = { ...DEFAULTS };
  for (const r of rows) map[r.key] = r.value;
  return map;
}

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  if (GLOBAL_KEYS.has(key)) {
    const row = await rawOf(db).prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
    return row?.value ?? null;
  }
  const { raw, userId } = owner(db);
  const row = await raw.prepare("SELECT value FROM user_settings WHERE user_id = ? AND key = ?").bind(userId, key).first<{ value: string }>();
  return row?.value ?? DEFAULTS[key] ?? null;
}

export async function setSetting(db: D1Database, key: string, value: string | null): Promise<void> {
  if (GLOBAL_KEYS.has(key)) {
    const raw = rawOf(db);
    if (value === null) await run(raw, "DELETE FROM settings WHERE key = ?", key);
    else await run(raw, "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
    return;
  }
  const { raw, userId } = owner(db);
  if (value === null) await run(raw, "DELETE FROM user_settings WHERE user_id = ? AND key = ?", userId, key);
  else
    await run(
      raw,
      "INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value",
      userId,
      key,
      value,
    );
}

function rawOf(db: D1Database): D1Database {
  return db instanceof ScopedD1 ? db.raw : db;
}

function parseLayout(raw: string | undefined): HomeItem[] | null {
  if (!raw) return null;
  try {
    const parsed = HomeLayoutSchema.safeParse(JSON.parse(raw));
    return parsed.success ? (parsed.data as HomeItem[]) : null;
  } catch {
    return null;
  }
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
    home_layout: parseLayout(raw.home_layout),
    totp_enabled: Boolean(raw.totp_secret),
    last_message_at: raw.last_message_at || null,
  };
}

export async function getSettings(env: Env): Promise<Settings> {
  return toSettings(await getRawSettings(env.DB), env);
}
