// Flexible analytics query behind custom dashboard widgets: one metric, grouped
// one way, over a date range, with optional filters. Aggregation runs in SQL.

import type { Env } from "../env";
import type { QueryRequest, QueryResult, QueryRow } from "@shared/widgets";
import { TIME_GROUPS } from "@shared/widgets";
import { TX_TYPES, WEEKDAYS } from "@shared/rules";
import { addDays, daysBetween, formatDay } from "@shared/money";
import { all, first, placeholders, type SqlValue } from "../lib/db";
import { categoryPath, loadCategories } from "./categorize";
import { getSettings } from "./settings";
import { sqlOffset } from "./ai";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function metricSql(metric: QueryRequest["metric"]): { value: string; where: string } {
  switch (metric) {
    case "spent":
      return { value: "-SUM(t.amount_base)", where: "t.kind = 'expense'" };
    case "income":
      return { value: "SUM(t.amount_base)", where: "t.kind = 'income'" };
    case "net":
      return { value: "SUM(t.amount_base)", where: "t.kind IN ('expense', 'income')" };
    case "count":
      return { value: "COUNT(*)", where: "t.kind = 'expense'" };
    case "average":
      return { value: "-AVG(t.amount_base)", where: "t.kind = 'expense' AND t.amount_base < 0" };
    case "flow_in":
      return { value: "SUM(t.amount_base)", where: "t.amount_base > 0" };
    case "flow_out":
      return { value: "-SUM(t.amount_base)", where: "t.amount_base < 0" };
  }
}

function groupSql(group: QueryRequest["group_by"], offset: string): string {
  switch (group) {
    case "none":
      return "'total'";
    case "category":
      return "COALESCE(c.parent_id, c.id)";
    case "subcategory":
      return "t.category_id";
    case "merchant":
      return "COALESCE(m.name, t.merchant_raw, t.description, '—')";
    case "account":
      return "t.account_id";
    case "day":
      return "t.local_date";
    case "week":
      return "date(t.local_date, '-6 days', 'weekday 1')";
    case "month":
      return "substr(t.local_date, 1, 7)";
    case "weekday":
      return "CAST(strftime('%w', t.local_date) AS INTEGER)";
    case "hour":
      return `CAST(strftime('%H', t.occurred_at, '${offset}') AS INTEGER)`;
    case "type":
      return "COALESCE(t.tx_type, 'other')";
    case "tag":
      return "t.tags";
    case "weekday_hour":
      return `CAST(strftime('%w', t.local_date) AS INTEGER) || '-' || CAST(strftime('%H', t.occurred_at, '${offset}') AS INTEGER)`;
  }
}

export async function runQuery(env: Env, req: QueryRequest): Promise<QueryResult> {
  const db = env.DB;
  const settings = await getSettings(env);
  const offset = sqlOffset(settings.tz_offset_minutes);
  const f = req.filters ?? {};
  const { value, where: metricWhere } = metricSql(req.metric);

  const where: string[] = [metricWhere];
  const params: SqlValue[] = [];
  if (!f.include_excluded) where.push("t.excluded = 0");
  if (f.category_ids?.length) {
    const ids = f.category_ids.map(Number).filter(Number.isInteger);
    where.push(`(t.category_id IN (${placeholders(ids.length)}) OR c.parent_id IN (${placeholders(ids.length)}))`);
    params.push(...ids, ...ids);
  }
  if (f.account_ids?.length) {
    const ids = f.account_ids.map(Number).filter(Number.isInteger);
    where.push(`t.account_id IN (${placeholders(ids.length)})`);
    params.push(...ids);
  }
  if (f.merchant?.trim()) {
    where.push("(m.name LIKE ? OR t.merchant_raw LIKE ?)");
    params.push(`%${f.merchant.trim()}%`, `%${f.merchant.trim()}%`);
  }
  if (f.tag?.trim()) {
    where.push("t.tags LIKE ?");
    params.push(`%${f.tag.trim()}%`);
  }
  if (f.min_amount != null) {
    where.push("ABS(t.amount_base) >= ?");
    params.push(f.min_amount);
  }
  if (f.max_amount != null) {
    where.push("ABS(t.amount_base) <= ?");
    params.push(f.max_amount);
  }

  const from = req.from;
  const to = req.to;
  const baseFrom = `FROM transactions t LEFT JOIN categories c ON c.id = t.category_id LEFT JOIN merchants m ON m.id = t.merchant_id`;
  const whereSql = `WHERE t.local_date BETWEEN ? AND ? AND ${where.join(" AND ")}`;
  const g = groupSql(req.group_by, offset);

  const [raw, totals, prev] = await Promise.all([
    all<{ g: string | number | null; v: number | null; n: number }>(
      db,
      `SELECT ${g} AS g, ${value} AS v, COUNT(*) AS n ${baseFrom} ${whereSql} GROUP BY g`,
      from,
      to,
      ...params,
    ),
    first<{ v: number | null; n: number }>(db, `SELECT ${value} AS v, COUNT(*) AS n ${baseFrom} ${whereSql}`, from, to, ...params),
    req.compare
      ? first<{ v: number | null }>(
          db,
          `SELECT ${value} AS v ${baseFrom} ${whereSql}`,
          addDays(from, -(daysBetween(from, to) + 1)),
          addDays(from, -1),
          ...params,
        )
      : Promise.resolve(null),
  ]);

  const idx = req.group_by === "category" || req.group_by === "subcategory" ? await loadCategories(db) : null;
  const accounts =
    req.group_by === "account" ? new Map((await all<{ id: number; name: string }>(db, "SELECT id, name FROM accounts")).map((a) => [a.id, a.name])) : null;

  let rows: QueryRow[];
  if (req.group_by === "tag") {
    // Tags are a comma-separated list: split and add up per tag.
    const byTag = new Map<string, QueryRow>();
    for (const r of raw) {
      const tags = String(r.g ?? "").split(",").map((t) => t.trim()).filter(Boolean);
      for (const tag of tags.length ? tags : ["(no tag)"]) {
        const row = byTag.get(tag) ?? { key: tag, label: tag, value: 0, count: 0 };
        row.value += r.v ?? 0;
        row.count += r.n;
        byTag.set(tag, row);
      }
    }
    rows = [...byTag.values()];
  } else {
    rows = raw.map((r) => {
      const key = String(r.g ?? "");
      const row: QueryRow = { key, label: labelFor(req.group_by, r.g, idx, accounts), value: Math.round(r.v ?? 0), count: r.n };
      if (req.group_by === "weekday_hour") {
        const [wd, h] = key.split("-").map(Number);
        row.weekday = wd;
        row.hour = h;
      }
      return row;
    });
  }

  // Ordering, gap filling and "Other".
  if (TIME_GROUPS.includes(req.group_by)) {
    rows = fillTimeGaps(rows, req.group_by as "day" | "week" | "month", from, to);
  } else if (req.group_by === "weekday") {
    const order = [1, 2, 3, 4, 5, 6, 0];
    rows = order.map((d) => rows.find((r) => r.key === String(d)) ?? { key: String(d), label: WEEKDAYS[d], value: 0, count: 0 });
  } else if (req.group_by === "hour") {
    rows = Array.from({ length: 24 }, (_, h) => rows.find((r) => r.key === String(h)) ?? { key: String(h), label: `${String(h).padStart(2, "0")}:00`, value: 0, count: 0 });
  } else if (req.group_by !== "none" && req.group_by !== "weekday_hour") {
    rows.sort((a, b) => b.value - a.value);
    const limit = Math.max(1, Math.min(req.limit ?? 10, 100));
    if (rows.length > limit) {
      const rest = rows.slice(limit);
      rows = [
        ...rows.slice(0, limit),
        { key: "__other", label: `Other (${rest.length})`, value: rest.reduce((s, r) => s + r.value, 0), count: rest.reduce((s, r) => s + r.count, 0) },
      ];
    }
  }

  return {
    rows,
    total: Math.round(totals?.v ?? 0),
    count: totals?.n ?? 0,
    previous_total: prev ? Math.round(prev.v ?? 0) : null,
    from,
    to,
  };
}

function labelFor(
  group: QueryRequest["group_by"],
  g: string | number | null,
  idx: Awaited<ReturnType<typeof loadCategories>> | null,
  accounts: Map<number, string> | null,
): string {
  switch (group) {
    case "none":
      return "Total";
    case "category":
    case "subcategory":
      return g && idx ? categoryPath(idx, Number(g)).replace(" > ", " › ") || "Uncategorized" : "Uncategorized";
    case "account":
      return g ? (accounts?.get(Number(g)) ?? "Unknown card") : "No card";
    case "day":
      return formatDay(String(g));
    case "week":
      return `Week of ${formatDay(String(g))}`;
    case "month": {
      const [y, m] = String(g).split("-").map(Number);
      return `${MONTHS[m - 1]} ${y}`;
    }
    case "weekday":
      return WEEKDAYS[Number(g)] ?? String(g);
    case "hour":
      return `${String(g).padStart(2, "0")}:00`;
    case "type":
      return TX_TYPES.find((t) => t.value === g)?.label ?? "Other";
    default:
      return String(g ?? "—");
  }
}

function fillTimeGaps(rows: QueryRow[], group: "day" | "week" | "month", from: string, to: string): QueryRow[] {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  // "All time" starts at the first transaction, not in the year 2000.
  const firstKey = rows.map((r) => r.key).sort()[0];
  let start = from < "2001-01-01" && firstKey ? (group === "month" ? `${firstKey}-01` : firstKey) : from;
  const keys: string[] = [];
  if (group === "day") {
    if (daysBetween(start, to) > 800) start = addDays(to, -800);
    for (let d = start; d <= to; d = addDays(d, 1)) keys.push(d);
  } else if (group === "week") {
    const monday = (ymd: string) => {
      const day = new Date(`${ymd}T00:00:00Z`).getUTCDay();
      return addDays(ymd, -((day + 6) % 7));
    };
    for (let d = monday(start); d <= to && keys.length < 400; d = addDays(d, 7)) keys.push(d);
  } else {
    let [y, m] = start.split("-").map(Number);
    const [ty, tm] = to.split("-").map(Number);
    while ((y < ty || (y === ty && m <= tm)) && keys.length < 400) {
      keys.push(`${y}-${String(m).padStart(2, "0")}`);
      m++;
      if (m === 13) {
        m = 1;
        y++;
      }
    }
  }
  return keys.map((k) => byKey.get(k) ?? { key: k, label: labelFor(group, k, null, null), value: 0, count: 0 });
}
