// Lightweight SVG/HTML charts that follow one set of specs: thin marks with
// rounded data-ends, hairline recessive grid, labels in text colours, and a
// hover/focus tooltip on every mark.

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { formatDay, formatMoney } from "@shared/money";
import { clsx } from "../lib/ui";

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(ref.current);
    setWidth(ref.current.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/** Compact axis label: 0 / 80 / 1.2K */
function compact(minor: number): string {
  const v = minor / 100;
  if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(v >= 10000 ? 0 : 1).replace(/\.0$/, "")}K`;
  return String(Math.round(v));
}

/** Round a maximum up to a clean axis value. */
function niceMax(v: number): number {
  if (v <= 0) return 1000;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

/** Column with a 4px rounded top, square at the baseline. */
function colPath(x: number, y: number, w: number, h: number): string {
  if (h <= 0) return "";
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

interface Tip {
  x: number;
  y: number;
  content: ReactNode;
}

function Tooltip({ tip, width }: { tip: Tip | null; width: number }) {
  if (!tip) return null;
  const left = Math.min(Math.max(tip.x, 70), Math.max(70, width - 70));
  return (
    <div
      className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[13px] shadow-sheet"
      style={{ left, top: tip.y - 8 }}
      role="tooltip"
    >
      {tip.content}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Daily spending for the budget period, with the daily allowance as a threshold.

export function PaceChart({
  days,
  dailyBudget,
  today,
  height = 132,
}: {
  days: { date: string; spent: number }[];
  dailyBudget: number | null;
  today: string;
  height?: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<Tip | null>(null);
  const top = 14;
  const bottom = 20;
  const plotH = height - top - bottom;
  const max = niceMax(Math.max(dailyBudget ?? 0, ...days.map((d) => d.spent)) * 1.05);
  const slot = width / Math.max(1, days.length);
  const colW = Math.max(2, Math.min(24, slot - 2));
  const y = (v: number) => top + plotH - (v / max) * plotH;
  const labelIdx = new Set([0, Math.floor(days.length / 2), days.length - 1]);

  return (
    <div ref={ref} className="relative select-none" onPointerLeave={() => setTip(null)}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label="Daily spending this period">
          <line x1={0} x2={width} y1={y(0)} y2={y(0)} stroke="var(--line)" strokeWidth={1} />
          <text x={0} y={top - 4} className="fill-ink-3 text-[11px]">
            {compact(max)} ₼
          </text>
          {days.map((d, i) => {
            const x = i * slot + (slot - colW) / 2;
            const isFuture = d.date > today;
            const isToday = d.date === today;
            const h = Math.max(0, y(0) - y(d.spent));
            return (
              <g key={d.date}>
                {isFuture ? (
                  <rect x={x} y={y(0) - 2} width={colW} height={2} rx={1} fill="var(--series-1-track)" />
                ) : (
                  <path d={colPath(x, y(d.spent), colW, h)} fill="var(--series-1)" opacity={isToday || tip?.x === i * slot + slot / 2 ? 1 : 0.85} />
                )}
                {labelIdx.has(i) && (
                  <text
                    x={i * slot + slot / 2}
                    y={height - 4}
                    textAnchor={i === 0 ? "start" : i === days.length - 1 ? "end" : "middle"}
                    className={clsx("text-[11px]", isToday ? "fill-ink font-medium" : "fill-ink-3")}
                  >
                    {formatDay(d.date)}
                  </text>
                )}
                {/* Hit target: the whole slot, not just the painted pixels */}
                <rect
                  x={i * slot}
                  y={0}
                  width={slot}
                  height={height - bottom}
                  fill="transparent"
                  tabIndex={isFuture ? -1 : 0}
                  aria-label={`${formatDay(d.date)}: ${formatMoney(d.spent)}`}
                  onPointerMove={() =>
                    !isFuture &&
                    setTip({
                      x: i * slot + slot / 2,
                      y: Math.min(y(d.spent), y(0) - 10),
                      content: (
                        <>
                          <strong className="num">{formatMoney(d.spent)}</strong> <span className="text-ink-3">{formatDay(d.date)}</span>
                        </>
                      ),
                    })
                  }
                  onFocus={() =>
                    setTip({
                      x: i * slot + slot / 2,
                      y: Math.min(y(d.spent), y(0) - 10),
                      content: <strong className="num">{formatMoney(d.spent)}</strong>,
                    })
                  }
                  onBlur={() => setTip(null)}
                />
              </g>
            );
          })}
          {dailyBudget !== null && dailyBudget > 0 && (
            <g>
              <line x1={0} x2={width} y1={y(dailyBudget)} y2={y(dailyBudget)} stroke="var(--ink-2)" strokeWidth={1} strokeDasharray="4 4" />
              <text x={width} y={y(dailyBudget) - 5} textAnchor="end" className="fill-ink-2 text-[11px]">
                Daily budget {formatMoney(dailyBudget, "AZN", { decimals: false })}
              </text>
            </g>
          )}
        </svg>
      )}
      <Tooltip tip={tip} width={width} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Horizontal bars (one series → one colour; identity comes from the label).

export function BarList({
  rows,
  total,
  onSelect,
  format = (v) => formatMoney(v, "AZN", { decimals: v < 100000 }),
}: {
  rows: { key: string | number; icon?: ReactNode; label: string; value: number; sub?: string }[];
  total?: number;
  onSelect?: (key: string | number) => void;
  format?: (v: number) => string;
}) {
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.value)));
  return (
    <ul className="flex flex-col">
      {rows.map((r) => {
        const pct = total ? Math.round((r.value / total) * 100) : null;
        const content = (
          <>
            <span className="flex items-center gap-2.5">
              {r.icon && <span className="w-6 text-center text-lg" aria-hidden>{r.icon}</span>}
              <span className="min-w-0 flex-1 truncate">{r.label}</span>
              <span className="num font-medium">{format(r.value)}</span>
              {pct !== null && <span className="num w-10 text-right text-sm text-ink-3">{pct}%</span>}
            </span>
            <span className="mt-1.5 flex items-center gap-2.5">
              {r.icon && <span className="w-6" />}
              <span className="h-2 flex-1 rounded-full bg-surface-2">
                <span
                  className={clsx("block h-2 rounded-full", r.value < 0 ? "bg-series-2" : "bg-series-1")}
                  style={{ width: `${Math.max(1.5, (Math.abs(r.value) / max) * 100)}%` }}
                />
              </span>
              {pct !== null && <span className="w-10" />}
            </span>
            {r.sub && <span className="mt-0.5 block pl-8.5 text-[13px] text-ink-3">{r.sub}</span>}
          </>
        );
        return (
          <li key={r.key}>
            {onSelect ? (
              <button className="block w-full rounded-xl px-2 py-2 text-left hover:bg-surface-2" onClick={() => onSelect(r.key)}>
                {content}
              </button>
            ) : (
              <div className="px-2 py-2">{content}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Spending vs income per period (two series, one axis, legend + tooltip).

export function TrendColumns({ periods, height = 200 }: { periods: { label: string; spent: number; income: number }[]; height?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<Tip | null>(null);
  const top = 16;
  const bottom = 22;
  const left = 34;
  const plotW = Math.max(0, width - left);
  const plotH = height - top - bottom;
  const max = niceMax(Math.max(...periods.flatMap((p) => [p.spent, p.income]), 1));
  const slot = plotW / Math.max(1, periods.length);
  const colW = Math.max(3, Math.min(20, (slot - 8) / 2));
  const y = (v: number) => top + plotH - (v / max) * plotH;
  const short = (label: string) => label.replace(/ \d{4}$/, "").replace(/^(\d+ \w+) – .*/, "$1");

  return (
    <div>
      <div className="mb-2 flex gap-4 text-[13px] text-ink-2">
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm bg-series-1" /> Spending
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm bg-series-2" /> Income
        </span>
      </div>
      <div ref={ref} className="relative select-none" onPointerLeave={() => setTip(null)}>
        {width > 0 && (
          <svg width={width} height={height} role="img" aria-label="Spending and income by month">
            {[0, 0.5, 1].map((f) => (
              <g key={f}>
                <line x1={left} x2={width} y1={y(max * f)} y2={y(max * f)} stroke="var(--line)" strokeWidth={1} />
                <text x={left - 6} y={y(max * f) + 4} textAnchor="end" className="num fill-ink-3 text-[11px]">
                  {compact(max * f)}
                </text>
              </g>
            ))}
            {periods.map((p, i) => {
              const cx = left + i * slot + slot / 2;
              return (
                <g key={p.label}>
                  <path d={colPath(cx - colW - 1, y(p.spent), colW, y(0) - y(p.spent))} fill="var(--series-1)" />
                  <path d={colPath(cx + 1, y(p.income), colW, y(0) - y(p.income))} fill="var(--series-2)" />
                  <text x={cx} y={height - 6} textAnchor="middle" className="fill-ink-3 text-[11px]">
                    {short(p.label)}
                  </text>
                  <rect
                    x={left + i * slot}
                    y={0}
                    width={slot}
                    height={height - bottom}
                    fill="transparent"
                    tabIndex={0}
                    aria-label={`${p.label}: spent ${formatMoney(p.spent)}, income ${formatMoney(p.income)}`}
                    onPointerMove={() => setTip({ x: cx, y: y(Math.max(p.spent, p.income)), content: <TrendTip p={p} /> })}
                    onFocus={() => setTip({ x: cx, y: y(Math.max(p.spent, p.income)), content: <TrendTip p={p} /> })}
                    onBlur={() => setTip(null)}
                  />
                </g>
              );
            })}
          </svg>
        )}
        <Tooltip tip={tip} width={width} />
      </div>
    </div>
  );
}

function TrendTip({ p }: { p: { label: string; spent: number; income: number } }) {
  const net = p.income - p.spent;
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-ink-3">{p.label}</span>
      <span className="flex items-center gap-2">
        <span className="h-0.5 w-3 bg-series-1" />
        <strong className="num">{formatMoney(p.spent)}</strong> <span className="text-ink-3">spent</span>
      </span>
      <span className="flex items-center gap-2">
        <span className="h-0.5 w-3 bg-series-2" />
        <strong className="num">{formatMoney(p.income)}</strong> <span className="text-ink-3">income</span>
      </span>
      <span className="text-ink-2 num">
        {net >= 0 ? "Saved" : "Overspent"} {formatMoney(Math.abs(net))}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// When you spend: weekday × time-of-day heatmap (sequential, one hue).

const SEQ = ["var(--seq-1)", "var(--seq-2)", "var(--seq-3)", "var(--seq-4)", "var(--seq-5)", "var(--seq-6)"];
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function Heatmap({ cells }: { cells: { weekday: number; hour: number; spent: number; count: number }[] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<Tip | null>(null);
  const bins = 12; // 2-hour blocks
  const grid = Array.from({ length: 7 }, () => Array.from({ length: bins }, () => ({ spent: 0, count: 0 })));
  for (const c of cells) {
    const row = (c.weekday + 6) % 7; // Monday first
    const cell = grid[row][Math.floor(c.hour / 2)];
    cell.spent += c.spent;
    cell.count += c.count;
  }
  const max = Math.max(1, ...grid.flat().map((c) => c.spent));
  const left = 34;
  const gap = 2;
  const cellW = Math.max(8, (width - left - gap * (bins - 1)) / bins);
  const cellH = Math.min(30, Math.max(18, cellW * 0.75));
  const height = 7 * (cellH + gap) + 18;
  const level = (v: number) => (v <= 0 ? -1 : Math.min(SEQ.length - 1, Math.floor((v / max) * SEQ.length)));

  return (
    <div>
      <div ref={ref} className="relative select-none" onPointerLeave={() => setTip(null)}>
        {width > 0 && (
          <svg width={width} height={height} role="img" aria-label="Spending by weekday and time of day">
            {grid.map((row, r) => (
              <g key={r}>
                <text x={0} y={r * (cellH + gap) + cellH / 2 + 4} className="fill-ink-3 text-[11px]">
                  {WEEKDAYS[r]}
                </text>
                {row.map((cell, b) => {
                  const lv = level(cell.spent);
                  const x = left + b * (cellW + gap);
                  const yy = r * (cellH + gap);
                  const label = `${WEEKDAYS[r]} ${String(b * 2).padStart(2, "0")}:00–${String(b * 2 + 2).padStart(2, "0")}:00`;
                  const show = () =>
                    setTip({
                      x: x + cellW / 2,
                      y: yy,
                      content: (
                        <>
                          <strong className="num">{formatMoney(cell.spent)}</strong>{" "}
                          <span className="text-ink-3">
                            {label} · {cell.count} purchases
                          </span>
                        </>
                      ),
                    });
                  return (
                    <rect
                      key={b}
                      x={x}
                      y={yy}
                      width={cellW}
                      height={cellH}
                      rx={4}
                      fill={lv < 0 ? "var(--surface-2)" : SEQ[lv]}
                      tabIndex={0}
                      aria-label={`${label}: ${formatMoney(cell.spent)}`}
                      onPointerMove={show}
                      onFocus={show}
                      onBlur={() => setTip(null)}
                    />
                  );
                })}
              </g>
            ))}
            {[0, 3, 6, 9].map((b) => (
              <text key={b} x={left + b * (cellW + gap)} y={height - 3} className="fill-ink-3 text-[11px]">
                {String(b * 2).padStart(2, "0")}:00
              </text>
            ))}
          </svg>
        )}
        <Tooltip tip={tip} width={width} />
      </div>
      <div className="mt-2 flex items-center gap-1.5 text-[12px] text-ink-3">
        <span>Less</span>
        {SEQ.map((c) => (
          <span key={c} className="h-3 w-5 rounded-[3px]" style={{ background: c }} />
        ))}
        <span>More</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sparkline: de-emphasised history with the current period in the accent.

export function Sparkline({ values, width = 96, height = 28 }: { values: number[]; width?: number; height?: number }) {
  if (values.length < 2) return null;
  const max = Math.max(1, ...values);
  const step = width / (values.length - 1);
  const pts = values.map((v, i) => [i * step, height - 3 - (v / max) * (height - 6)] as const);
  const last = pts[pts.length - 1];
  return (
    <svg width={width} height={height} aria-hidden>
      <polyline
        points={pts.map((p) => p.join(",")).join(" ")}
        fill="none"
        stroke="var(--ink-3)"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        opacity={0.6}
      />
      <circle cx={last[0]} cy={last[1]} r={4} fill="var(--series-1)" stroke="var(--surface)" strokeWidth={2} />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Budget meter: the fill carries severity; a tick marks where today's pace should be.

export function Meter({
  spent,
  amount,
  status,
  paceFraction,
}: {
  spent: number;
  amount: number;
  status: "ok" | "warning" | "over";
  paceFraction?: number | null;
}) {
  const pct = amount > 0 ? Math.min(100, (spent / amount) * 100) : 0;
  const fill = status === "over" ? "var(--bad)" : status === "warning" ? "var(--warn)" : "var(--series-1)";
  const track = status === "over" ? "var(--bad-soft)" : status === "warning" ? "var(--warn-soft)" : "var(--series-1-track)";
  return (
    <div className="relative h-2.5 rounded-full" style={{ background: track }}>
      <div className="h-2.5 rounded-full transition-[width] duration-500" style={{ width: `${pct}%`, background: fill }} />
      {paceFraction != null && paceFraction > 0 && paceFraction < 1 && (
        <div
          className="absolute -top-1 h-[18px] w-0.5 rounded-full bg-ink-2"
          style={{ left: `calc(${paceFraction * 100}% - 1px)` }}
          title="Where you'd be if you spent evenly"
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Generic single-series charts for custom dashboards.

export type Fmt = (v: number) => string;
export const moneyFmt: Fmt = (v) => formatMoney(v, "AZN", { decimals: Math.abs(v) < 100000 });
export const countFmt: Fmt = (v) => String(Math.round(v));

/** Which x labels to print so they never collide (first, last and evenly spaced ones). */
function labelIndexes(n: number, width: number, minGap = 64): Set<number> {
  const maxLabels = Math.max(2, Math.floor(width / minGap));
  const step = Math.max(1, Math.ceil(n / maxLabels));
  const out = new Set<number>();
  for (let i = 0; i < n; i += step) out.add(i);
  // The last label is always shown; drop an evenly spaced one that would sit on top of it.
  const lastRegular = Math.floor((n - 1) / step) * step;
  if (lastRegular !== n - 1 && lastRegular !== 0 && (n - 1 - lastRegular) / step < 0.75) out.delete(lastRegular);
  out.add(n - 1);
  return out;
}

export function ColumnChart({ rows, format = moneyFmt, height = 200 }: { rows: { key: string; label: string; value: number }[]; format?: Fmt; height?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<Tip | null>(null);
  const top = 16;
  const bottom = 22;
  const left = 38;
  const plotW = Math.max(0, width - left);
  const plotH = height - top - bottom;
  const maxV = niceMax(Math.max(1, ...rows.map((r) => r.value)));
  const minV = Math.min(0, ...rows.map((r) => r.value));
  const range = maxV - minV || 1;
  const y = (v: number) => top + ((maxV - v) / range) * plotH;
  const slot = plotW / Math.max(1, rows.length);
  const colW = Math.max(2, Math.min(24, slot - 2));
  const labels = labelIndexes(rows.length, plotW);
  return (
    <div ref={ref} className="relative select-none" onPointerLeave={() => setTip(null)}>
      {width > 0 && (
        <svg width={width} height={height} role="img">
          {[maxV, maxV / 2, 0].map((v) => (
            <g key={v}>
              <line x1={left} x2={width} y1={y(v)} y2={y(v)} stroke="var(--line)" strokeWidth={1} />
              <text x={left - 6} y={y(v) + 4} textAnchor="end" className="num fill-ink-3 text-[11px]">
                {compactValue(v, format)}
              </text>
            </g>
          ))}
          {rows.map((r, i) => {
            const x = left + i * slot + (slot - colW) / 2;
            const y0 = y(0);
            const yv = y(r.value);
            const show = () => setTip({ x: left + i * slot + slot / 2, y: Math.min(yv, y0), content: <TipBody label={r.label} value={format(r.value)} /> });
            return (
              <g key={r.key}>
                {r.value >= 0 ? (
                  <path d={colPath(x, yv, colW, y0 - yv)} fill="var(--series-1)" />
                ) : (
                  <rect x={x} y={y0} width={colW} height={yv - y0} rx={2} fill="var(--series-2)" />
                )}
                {labels.has(i) && (
                  <text
                    x={left + i * slot + slot / 2}
                    y={height - 6}
                    textAnchor={i === 0 && rows.length > 1 ? "start" : i === rows.length - 1 && rows.length > 1 ? "end" : "middle"}
                    className="fill-ink-3 text-[11px]"
                  >
                    {shortLabel(r.label)}
                  </text>
                )}
                <rect x={left + i * slot} y={0} width={slot} height={height - bottom} fill="transparent" tabIndex={0} aria-label={`${r.label}: ${format(r.value)}`} onPointerMove={show} onFocus={show} onBlur={() => setTip(null)} />
              </g>
            );
          })}
        </svg>
      )}
      <Tooltip tip={tip} width={width} />
    </div>
  );
}

export function LineChart({
  rows,
  format = moneyFmt,
  height = 200,
  area = false,
}: {
  rows: { key: string; label: string; value: number }[];
  format?: Fmt;
  height?: number;
  area?: boolean;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const top = 16;
  const bottom = 22;
  const left = 38;
  const right = 8;
  const plotW = Math.max(0, width - left - right);
  const plotH = height - top - bottom;
  const maxV = niceMax(Math.max(1, ...rows.map((r) => r.value)));
  const minV = Math.min(0, ...rows.map((r) => r.value));
  const range = maxV - minV || 1;
  const x = (i: number) => left + (rows.length <= 1 ? plotW / 2 : (i / (rows.length - 1)) * plotW);
  const y = (v: number) => top + ((maxV - v) / range) * plotH;
  const pts = rows.map((r, i) => `${x(i)},${y(r.value)}`).join(" ");
  const labels = labelIndexes(rows.length, plotW);
  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const rect = (e.currentTarget as SVGRectElement).getBoundingClientRect();
    const rel = (e.clientX - rect.left) / Math.max(1, rect.width);
    setHover(Math.max(0, Math.min(rows.length - 1, Math.round(rel * (rows.length - 1)))));
  };
  const last = rows.length - 1;
  return (
    <div ref={ref} className="relative select-none" onPointerLeave={() => setHover(null)}>
      {width > 0 && rows.length > 0 && (
        <svg width={width} height={height} role="img">
          {[maxV, maxV / 2, 0].map((v) => (
            <g key={v}>
              <line x1={left} x2={width - right} y1={y(v)} y2={y(v)} stroke="var(--line)" strokeWidth={1} />
              <text x={left - 6} y={y(v) + 4} textAnchor="end" className="num fill-ink-3 text-[11px]">
                {compactValue(v, format)}
              </text>
            </g>
          ))}
          {area && <polygon points={`${x(0)},${y(0)} ${pts} ${x(last)},${y(0)}`} fill="var(--series-1)" opacity={0.1} />}
          <polyline points={pts} fill="none" stroke="var(--series-1)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {rows.map((r, i) =>
            labels.has(i) ? (
              <text key={r.key} x={x(i)} y={height - 6} textAnchor={i === 0 ? "start" : i === last ? "end" : "middle"} className="fill-ink-3 text-[11px]">
                {shortLabel(r.label)}
              </text>
            ) : null,
          )}
          <circle cx={x(last)} cy={y(rows[last].value)} r={4} fill="var(--series-1)" stroke="var(--surface)" strokeWidth={2} />
          {hover !== null && (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1={top} y2={y(minV)} stroke="var(--ink-3)" strokeWidth={1} />
              <circle cx={x(hover)} cy={y(rows[hover].value)} r={4} fill="var(--series-1)" stroke="var(--surface)" strokeWidth={2} />
            </g>
          )}
          <rect x={left} y={0} width={plotW} height={height - bottom} fill="transparent" onPointerMove={onMove} />
        </svg>
      )}
      {hover !== null && rows[hover] && <Tooltip tip={{ x: x(hover), y: y(rows[hover].value), content: <TipBody label={rows[hover].label} value={format(rows[hover].value)} /> }} width={width} />}
    </div>
  );
}

// Categorical colours (validated for colour-blind separation), used for donut segments.
const CATEGORICAL = ["var(--cat-1)", "var(--cat-2)", "var(--cat-3)", "var(--cat-4)", "var(--cat-5)", "var(--cat-6)"];

export function DonutChart({ rows, format = moneyFmt, centerLabel }: { rows: { key: string; label: string; value: number }[]; format?: Fmt; centerLabel?: string }) {
  // At most 5 named segments plus "Other", so each colour stays distinguishable.
  const positive = rows.filter((r) => r.value > 0);
  const named = positive.filter((r) => r.key !== "__other").slice(0, 5);
  const restValue = positive.filter((r) => !named.includes(r)).reduce((s, r) => s + r.value, 0);
  const segments = [...named.map((r, i) => ({ ...r, color: CATEGORICAL[i] })), ...(restValue > 0 ? [{ key: "__rest", label: "Other", value: restValue, color: "var(--ink-3)" }] : [])];
  const total = segments.reduce((s, r) => s + r.value, 0);
  const [active, setActive] = useState<string | null>(null);
  const R = 70;
  const r = 48;
  let angle = -Math.PI / 2;
  const gap = segments.length > 1 ? 0.025 : 0;
  const arcs = segments.map((seg) => {
    const sweep = total > 0 ? (seg.value / total) * Math.PI * 2 : 0;
    const a0 = angle + gap / 2;
    const a1 = angle + Math.max(sweep - gap / 2, gap / 2);
    angle += sweep;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const p = (rad: number, radius: number) => `${80 + radius * Math.cos(rad)},${80 + radius * Math.sin(rad)}`;
    const d = sweep >= Math.PI * 2 - 0.001
      ? `M${p(-Math.PI / 2, R)} A${R},${R} 0 1 1 ${p(Math.PI * 1.5 - 0.001, R)} L${p(Math.PI * 1.5 - 0.001, r)} A${r},${r} 0 1 0 ${p(-Math.PI / 2, r)} Z`
      : `M${p(a0, R)} A${R},${R} 0 ${large} 1 ${p(a1, R)} L${p(a1, r)} A${r},${r} 0 ${large} 0 ${p(a0, r)} Z`;
    return { ...seg, d };
  });
  const shown = arcs.find((a) => a.key === active);
  return (
    <div className="flex flex-wrap items-center gap-5">
      <svg width={160} height={160} viewBox="0 0 160 160" role="img" aria-label="Donut chart">
        {arcs.map((a) => (
          <path
            key={a.key}
            d={a.d}
            fill={a.color}
            opacity={active && active !== a.key ? 0.35 : 1}
            tabIndex={0}
            aria-label={`${a.label}: ${format(a.value)}`}
            onPointerEnter={() => setActive(a.key)}
            onPointerLeave={() => setActive(null)}
            onFocus={() => setActive(a.key)}
            onBlur={() => setActive(null)}
          />
        ))}
        <text x={80} y={78} textAnchor="middle" className="num fill-ink text-[15px] font-semibold">
          {format(shown ? shown.value : total)}
        </text>
        <text x={80} y={96} textAnchor="middle" className="fill-ink-3 text-[11px]">
          {shown ? `${total ? Math.round((shown.value / total) * 100) : 0}%` : (centerLabel ?? "total")}
        </text>
      </svg>
      <ul className="min-w-40 flex-1 text-sm">
        {arcs.map((a) => (
          <li key={a.key} className="flex items-center gap-2 py-1" onPointerEnter={() => setActive(a.key)} onPointerLeave={() => setActive(null)}>
            <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: a.color }} />
            <span className="min-w-0 flex-1 truncate">{a.label}</span>
            <span className="num font-medium">{format(a.value)}</span>
            <span className="num w-9 text-right text-ink-3">{total ? Math.round((a.value / total) * 100) : 0}%</span>
          </li>
        ))}
        {arcs.length === 0 && <li className="text-ink-3">No data</li>}
      </ul>
    </div>
  );
}

function TipBody({ label, value }: { label: string; value: string }) {
  return (
    <>
      <strong className="num">{value}</strong> <span className="text-ink-3">{label}</span>
    </>
  );
}

function compactValue(v: number, format: Fmt): string {
  if (format === countFmt) return String(Math.round(v));
  return compact(v);
}

function shortLabel(label: string): string {
  return label.replace(/^Week of /, "").replace(/ \d{4}$/, "");
}
