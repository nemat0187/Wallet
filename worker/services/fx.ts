// Exchange rates from the Central Bank of Azerbaijan (cbar.az), cached in D1.
// Used to convert foreign-currency purchases and non-AZN accounts into AZN for statistics.

import { all, first } from "../lib/db";
import { addDays } from "@shared/money";

// The manat is pegged to the US dollar; these are only last-resort fallbacks.
const FALLBACK: Record<string, number> = { USD: 1.7, EUR: 1.85, GBP: 2.2, RUB: 0.02, TRY: 0.05, GEL: 0.63, AED: 0.463 };

export async function fetchCbarRates(db: D1Database, ymd: string): Promise<Record<string, number>> {
  const [y, m, d] = ymd.split("-");
  const res = await fetch(`https://www.cbar.az/currencies/${d}.${m}.${y}.xml`, {
    headers: { "user-agent": "Mozilla/5.0 (personal wallet app)" },
    cf: { cacheTtl: 3600 },
  });
  if (!res.ok) throw new Error(`CBAR responded ${res.status}`);
  const xml = await res.text();
  const rates: Record<string, number> = {};
  for (const m2 of xml.matchAll(/<Valute Code="([A-Z]{3})">[\s\S]*?<Nominal>([\d.]+)[^<]*<\/Nominal>[\s\S]*?<Value>([\d.]+)<\/Value>/g)) {
    const nominal = parseFloat(m2[2]) || 1;
    rates[m2[1]] = parseFloat(m2[3]) / nominal;
  }
  if (Object.keys(rates).length === 0) throw new Error("No rates in CBAR response");
  const stmts = Object.entries(rates).map(([cur, rate]) =>
    db.prepare("INSERT OR REPLACE INTO fx_rates (date, currency, rate) VALUES (?, ?, ?)").bind(ymd, cur, rate),
  );
  await db.batch(stmts);
  return rates;
}

/** AZN value of one unit of `currency` on `ymd` (or the closest earlier day we know). */
export async function rateToAzn(db: D1Database, currency: string, ymd: string): Promise<number> {
  if (currency === "AZN") return 1;
  const exact = await first<{ rate: number }>(db, "SELECT rate FROM fx_rates WHERE currency = ? AND date = ?", currency, ymd);
  if (exact) return exact.rate;
  try {
    const rates = await fetchCbarRates(db, ymd);
    if (rates[currency]) return rates[currency];
  } catch {
    // fall through to the nearest known rate
  }
  const near = await first<{ rate: number }>(
    db,
    "SELECT rate FROM fx_rates WHERE currency = ? AND date <= ? ORDER BY date DESC LIMIT 1",
    currency,
    ymd,
  );
  return near?.rate ?? FALLBACK[currency] ?? 1;
}

/** Convert minor units between currencies via AZN. */
export async function convert(db: D1Database, minor: number, from: string, to: string, ymd: string): Promise<number> {
  if (from === to) return minor;
  const fromRate = await rateToAzn(db, from, ymd);
  const toRate = await rateToAzn(db, to, ymd);
  return Math.round((minor * fromRate) / toRate);
}

export async function knownRates(db: D1Database, ymd: string): Promise<{ currency: string; rate: number }[]> {
  return all(db, "SELECT currency, rate FROM fx_rates WHERE date = (SELECT MAX(date) FROM fx_rates WHERE date <= ?)", addDays(ymd, 0));
}
