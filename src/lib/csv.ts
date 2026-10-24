// Minimal CSV reader for bank exports (handles quotes, ; or , or tab separators, BOM).

import { parseAmount } from "@shared/money";

export function parseCsv(text: string): string[][] {
  const clean = text.replace(/^﻿/, "");
  const firstLine = clean.split(/\r?\n/, 1)[0] ?? "";
  const counts = { ",": 0, ";": 0, "\t": 0 } as Record<string, number>;
  for (const ch of firstLine) if (ch in counts) counts[ch]++;
  const sep = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][1] > 0 ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (quoted) {
      if (ch === '"' && clean[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) {
      row.push(cell.trim());
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && clean[i + 1] === "\n") i++;
      row.push(cell.trim());
      if (row.some((c) => c !== "")) rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  row.push(cell.trim());
  if (row.some((c) => c !== "")) rows.push(row);
  return rows;
}

export type DateFormat = "dmy" | "ymd" | "mdy";

/** Returns YYYY-MM-DD and optional HH:MM, or null. */
export function parseDateCell(value: string, format: DateFormat): { date: string; time: string | null } | null {
  const v = value.trim();
  const time = v.match(/(\d{1,2}):(\d{2})/);
  const t = time ? `${time[1].padStart(2, "0")}:${time[2]}` : null;
  let y: number, m: number, d: number;
  const iso = v.match(/(\d{4})[-./](\d{1,2})[-./](\d{1,2})/);
  const other = v.match(/(\d{1,2})[-./](\d{1,2})[-./](\d{2,4})/);
  if (format === "ymd" && iso) [y, m, d] = [+iso[1], +iso[2], +iso[3]];
  else if (other) {
    const a = +other[1];
    const b = +other[2];
    y = +other[3] < 100 ? 2000 + +other[3] : +other[3];
    [d, m] = format === "mdy" ? [b, a] : [a, b];
  } else if (iso) [y, m, d] = [+iso[1], +iso[2], +iso[3]];
  else return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return { date: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`, time: t };
}

export function guessDateFormat(samples: string[]): DateFormat {
  if (samples.some((s) => /^\s*\d{4}[-./]/.test(s))) return "ymd";
  if (samples.some((s) => /^\s*\d{1,2}[-./](1[3-9]|2\d|3[01])[-./]/.test(s))) return "mdy";
  return "dmy";
}

export function amountCell(value: string): number | null {
  if (!value) return null;
  const negative = /^\s*-|\(.*\)|−/.test(value);
  const n = parseAmount(value.replace(/[^\d.,\s'-]/g, "").replace(/^-/, ""));
  if (n === null) return null;
  return negative ? -n : n;
}
