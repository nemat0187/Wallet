// Exchange rates into AZN, cached in D1 (global, shared by every user).
//
// Sources, in order: the Central Bank of Azerbaijan (cbar.az, official, one file per day) and, for today and
// yesterday only, open.er-api.com (free, includes AZN) when the bank's site cannot be reached. A day without a
// published rate (weekend, holiday) gets the nearest earlier rate copied to it ("carried") so it is not re-fetched
// for every transaction. Fixed numbers are only a last resort and are reported as approximate.

import { all, first } from "../lib/db";
import { addDays } from "@shared/money";
import { ScopedD1 } from "../lib/scoped";

/** Exchange rates are shared by everyone (no user_id), and the per-user database refuses REPLACE, so use the real one. */
const shared = (db: D1Database): D1Database => (db instanceof ScopedD1 ? db.raw : db);

// The manat is pegged to the US dollar; these are only last-resort fallbacks.
export const FALLBACK: Record<string, number> = { USD: 1.7, EUR: 1.85, GBP: 2.2, RUB: 0.02, TRY: 0.05, GEL: 0.63, AED: 0.463 };

const CARRIED_RETRY_MS = 3_600_000;

/** Local testing only: point the sources at mock servers (see scripts/fx-check.mjs). */
let urls: { cbarBase?: string; erUrl?: string } = {};
export function configureFx(env: { FX_TEST_CBAR_URL?: string; FX_TEST_ER_URL?: string }): void {
  urls = { cbarBase: env.FX_TEST_CBAR_URL, erUrl: env.FX_TEST_ER_URL };
}

/** CBAR's daily XML -> AZN per ONE unit of each currency (their file lists rates per "Nominal" units). */
export function parseCbarXml(xml: string): Record<string, number> {
  const rates: Record<string, number> = {};
  for (const m of xml.matchAll(/<Valute Code="([A-Z]{3})">[\s\S]*?<Nominal>([\d.]+)[^<]*<\/Nominal>[\s\S]*?<Value>([\d.]+)<\/Value>/g)) {
    const nominal = parseFloat(m[2]) || 1;
    const value = parseFloat(m[3]);
    if (value > 0) rates[m[1]] = value / nominal;
  }
  return rates;
}

/** open.er-api.com's USD table -> AZN per ONE unit of each currency. */
export function parseErApi(json: unknown): Record<string, number> {
  const j = json as { result?: string; rates?: Record<string, number> } | null;
  const table = j?.rates;
  const azn = table?.AZN;
  if (!table || azn === undefined || !(azn > 0) || (j?.result && j.result !== "success")) return {};
  const rates: Record<string, number> = {};
  for (const [cur, perUsd] of Object.entries(table)) if (/^[A-Z]{3}$/.test(cur) && perUsd > 0) rates[cur] = azn / perUsd;
  rates.AZN = 1;
  return rates;
}

async function getText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (personal wallet app)" }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`${new URL(url).host} responded ${res.status}`);
  return res.text();
}

async function store(db: D1Database, ymd: string, rates: Record<string, number>, source: "cbar" | "er-api"): Promise<void> {
  const now = new Date().toISOString();
  const entries = Object.entries(rates).filter(([cur]) => cur !== "AZN");
  if (!entries.length) return;
  await db.batch(
    entries.map(([cur, rate]) => db.prepare("INSERT OR REPLACE INTO fx_rates (date, currency, rate, source, fetched_at) VALUES (?, ?, ?, ?, ?)").bind(ymd, cur, rate, source, now)),
  );
}

/** Fetch and store the rates for one day. Throws when no source has them. */
export async function refreshRates(dbIn: D1Database, ymd: string, now = new Date()): Promise<{ rates: Record<string, number>; source: "cbar" | "er-api" }> {
  const db = shared(dbIn);
  const [y, m, d] = ymd.split("-");
  let failure: unknown;
  try {
    const base = urls.cbarBase ?? "https://www.cbar.az/currencies";
    const rates = parseCbarXml(await getText(`${base}/${d}.${m}.${y}.xml`));
    if (Object.keys(rates).length) {
      await store(db, ymd, rates, "cbar");
      return { rates, source: "cbar" };
    }
    failure = new Error("No rates in the CBAR file");
  } catch (e) {
    failure = e;
  }
  // The backup source only knows today's market rates, so it is only used for today and yesterday.
  if (ymd >= addDays(now.toISOString().slice(0, 10), -1)) {
    try {
      const rates = parseErApi(JSON.parse(await getText(urls.erUrl ?? "https://open.er-api.com/v6/latest/USD")));
      if (Object.keys(rates).length > 1) {
        await store(db, ymd, rates, "er-api");
        return { rates, source: "er-api" };
      }
    } catch (e) {
      failure = e;
    }
  }
  throw failure instanceof Error ? failure : new Error("Exchange rates unavailable");
}

/** AZN value of one unit of `currency` on `ymd` (or the closest earlier day we know). */
export async function rateToAzn(dbIn: D1Database, currency: string, ymd: string): Promise<number> {
  if (currency === "AZN") return 1;
  const db = shared(dbIn);
  const exact = await first<{ rate: number; source: string; fetched_at: string | null }>(db, "SELECT rate, source, fetched_at FROM fx_rates WHERE currency = ? AND date = ?", currency, ymd);
  if (exact && (exact.source !== "carried" || Date.now() - Date.parse(exact.fetched_at ?? "") < CARRIED_RETRY_MS)) return exact.rate;
  try {
    const { rates } = await refreshRates(db, ymd);
    if (rates[currency]) return rates[currency];
  } catch {
    // fall through to the nearest known rate
  }
  const near = await first<{ rate: number }>(db, "SELECT rate FROM fx_rates WHERE currency = ? AND date <= ? ORDER BY date DESC LIMIT 1", currency, ymd);
  if (near) {
    await db
      .prepare("INSERT OR REPLACE INTO fx_rates (date, currency, rate, source, fetched_at) VALUES (?, ?, ?, 'carried', ?)")
      .bind(ymd, currency, near.rate, new Date().toISOString())
      .run();
    return near.rate;
  }
  return FALLBACK[currency] ?? 1;
}

/** Convert minor units between currencies via AZN. */
export async function convert(db: D1Database, minor: number, from: string, to: string, ymd: string): Promise<number> {
  if (from === to) return minor;
  const fromRate = await rateToAzn(db, from, ymd);
  const toRate = await rateToAzn(db, to, ymd);
  return Math.round((minor * fromRate) / toRate);
}

export interface RateInfo {
  currency: string;
  rate: number; // AZN per 1 unit
  date: string | null;
  source: string; // cbar | er-api | carried | fallback
  approximate: boolean;
}

/** The newest known rate for each currency as of `ymd`, for showing to the owner. */
export async function rateInfo(dbIn: D1Database, ymd: string, currencies: string[]): Promise<RateInfo[]> {
  const db = shared(dbIn);
  const out: RateInfo[] = [];
  for (const currency of [...new Set(currencies)].filter((c) => c !== "AZN")) {
    const row = await first<{ rate: number; date: string; source: string }>(db, "SELECT rate, date, source FROM fx_rates WHERE currency = ? AND date <= ? ORDER BY date DESC LIMIT 1", currency, ymd);
    out.push(
      row
        ? { currency, rate: row.rate, date: row.date, source: row.source, approximate: false }
        : { currency, rate: FALLBACK[currency] ?? 1, date: null, source: "fallback", approximate: true },
    );
  }
  return out;
}

/** Adds `balance_base` (AZN at today's rate) to accounts held in another currency. */
export async function withBaseBalances<T extends { currency: string; balance: number | null }>(db: D1Database, rows: T[], ymd: string): Promise<(T & { balance_base?: number | null })[]> {
  const out: (T & { balance_base?: number | null })[] = [];
  for (const r of rows) {
    if (r.currency === "AZN" || r.balance === null) out.push(r);
    else out.push({ ...r, balance_base: Math.round(r.balance * (await rateToAzn(db, r.currency, ymd))) });
  }
  return out;
}

export async function knownRates(db: D1Database, ymd: string): Promise<{ currency: string; rate: number }[]> {
  return all(db, "SELECT currency, rate FROM fx_rates WHERE date = (SELECT MAX(date) FROM fx_rates WHERE date <= ?)", ymd);
}
