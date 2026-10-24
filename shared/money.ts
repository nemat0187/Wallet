// Money and date helpers shared by the API and the web app.

const CURRENCY_SYMBOL: Record<string, string> = {
  AZN: "₼",
  USD: "$",
  EUR: "€",
  GBP: "£",
  RUB: "₽",
  TRY: "₺",
};

/** Format minor units as a human readable amount, e.g. 123456 -> "1 234.56 ₼". */
export function formatMoney(
  minor: number,
  currency = "AZN",
  opts: { sign?: boolean; decimals?: boolean } = {},
): string {
  const { sign = false, decimals = true } = opts;
  const negative = minor < 0;
  const abs = Math.abs(minor) / 100;
  const fixed = decimals ? abs.toFixed(2) : Math.round(abs).toString();
  const [int, frac] = fixed.split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  const body = frac ? `${grouped}.${frac}` : grouped;
  const symbol = CURRENCY_SYMBOL[currency] ?? currency;
  const prefix = negative ? "−" : sign && minor > 0 ? "+" : "";
  return `${prefix}${body}\u00a0${symbol}`;
}

/** Parse a decimal string ("12,50", "1 234.5") into minor units. Returns null if invalid. */
export function parseAmount(input: string | number): number | null {
  if (typeof input === "number") return Number.isFinite(input) ? Math.round(input * 100) : null;
  let s = input.trim().replace(/[\s  ']/g, "");
  if (!s) return null;
  // "1.234,56" -> "1234.56"; "1,234.56" -> "1234.56"; "12,5" -> "12.5"
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma > -1 && lastDot > -1) {
    if (lastComma > lastDot) s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
  } else if (lastComma > -1) {
    const decimals = s.length - lastComma - 1;
    s = decimals === 3 && s.indexOf(",") === lastComma && s.length > 4 ? s.replace(",", "") : s.replace(",", ".");
  }
  if (!/^[-+]?\d+(\.\d+)?$/.test(s)) return null;
  return Math.round(parseFloat(s) * 100);
}

export function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** YYYY-MM-DD for a Date, shifted to the user's timezone (offset in minutes east of UTC). */
export function localDate(d: Date, tzOffsetMinutes: number): string {
  const shifted = new Date(d.getTime() + tzOffsetMinutes * 60_000);
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
}

/** Hour (0-23) in the user's timezone. */
export function localHour(d: Date, tzOffsetMinutes: number): number {
  return new Date(d.getTime() + tzOffsetMinutes * 60_000).getUTCHours();
}

export function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

export function daysBetween(a: string, b: string): number {
  const [y1, m1, d1] = a.split("-").map(Number);
  const [y2, m2, d2] = b.split("-").map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatDay(ymd: string, withYear = false): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return withYear ? `${d} ${MONTHS[m - 1]} ${y}` : `${d} ${MONTHS[m - 1]}`;
}

/**
 * Budget period containing `ymd`. With startDay = 1 this is the calendar month;
 * with e.g. startDay = 25 (salary day) a period runs from the 25th to the 24th.
 * Days past the end of a short month clamp to its last day.
 */
export function periodFor(ymd: string, startDay = 1): { start: string; end: string; label: string } {
  const [y, m, d] = ymd.split("-").map(Number);
  const clampDay = (yy: number, mm: number) => Math.min(startDay, daysInMonth(yy, mm));
  let sy = y;
  let sm = m;
  if (d < clampDay(y, m)) {
    sm -= 1;
    if (sm === 0) {
      sm = 12;
      sy -= 1;
    }
  }
  const start = `${sy}-${pad2(sm)}-${pad2(clampDay(sy, sm))}`;
  let ny = sy;
  let nm = sm + 1;
  if (nm === 13) {
    nm = 1;
    ny += 1;
  }
  const end = addDays(`${ny}-${pad2(nm)}-${pad2(clampDay(ny, nm))}`, -1);
  const label = startDay === 1 ? `${MONTHS[sm - 1]} ${sy}` : `${formatDay(start)} – ${formatDay(end, true)}`;
  return { start, end, label };
}

export function shiftPeriod(ymd: string, startDay: number, delta: number): { start: string; end: string; label: string } {
  let p = periodFor(ymd, startDay);
  for (let i = 0; i < Math.abs(delta); i++) {
    p = periodFor(delta > 0 ? addDays(p.end, 1) : addDays(p.start, -1), startDay);
  }
  return p;
}

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
