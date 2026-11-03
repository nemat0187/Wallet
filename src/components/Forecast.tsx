// Home block: money on the cards after the bills that usually repeat, per day until the end of the budget month.

import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import type { Forecast } from "@shared/forecast";
import { formatDay, formatMoney } from "@shared/money";
import { get } from "../lib/api";
import { clsx } from "../lib/ui";

export function ForecastCard() {
  const q = useQuery({ queryKey: ["forecast"], queryFn: () => get<Forecast>("/analytics/forecast"), staleTime: 60_000 });
  const f = q.data;
  if (!f || (f.balance === null && f.bills.length === 0)) return null;
  const short = f.after_bills !== null && f.after_bills < 0;
  return (
    <section className="rounded-3xl border border-line bg-surface px-5 py-4 sm:px-7">
      <h2 className="text-[17px] font-semibold tracking-tight">Cash after bills</h2>
      {f.per_day !== null && f.after_bills !== null ? (
        <>
          <p className={clsx("mt-2 text-[34px] font-semibold leading-none tracking-tight num", short && "text-bad")}>
            {short ? "−" : ""}
            {formatMoney(short ? -f.after_bills : f.per_day, "AZN", { decimals: false })}
            <span className="ml-1 text-base font-normal text-ink-2">{short ? "short" : "a day"}</span>
          </p>
          <p className="mt-2 text-[14px] text-ink-2">
            {short ? (
              <>The bills due before {formatDay(f.period_end)} are more than what is on your cards.</>
            ) : (
              <>
                {formatMoney(f.after_bills, "AZN", { decimals: false })} left after bills, for {f.days_left} {f.days_left === 1 ? "day" : "days"}
                {f.typical_daily > 0 && (
                  <>
                    {" "}
                    · you usually spend <span className="num">{formatMoney(f.typical_daily, "AZN", { decimals: false })}</span> a day
                  </>
                )}
                .
              </>
            )}
          </p>
        </>
      ) : (
        <p className="mt-2 text-[14px] text-ink-2">
          Add your card balances in <Link to="/accounts" className="font-medium text-accent">Accounts</Link> to see what you can spend per day.
        </p>
      )}
      {f.bills.length > 0 && (
        <ul className="mt-3 divide-y divide-line border-t border-line text-[14px]">
          {f.bills.slice(0, 5).map((b, i) => (
            <li key={`${b.name}-${b.date}-${i}`} className="flex items-center justify-between gap-3 py-2">
              <span className="min-w-0 truncate">
                {b.name} <span className="text-ink-3">· {formatDay(b.date)}</span>
              </span>
              <span className="num text-ink-2">{formatMoney(b.amount, "AZN", { decimals: false })}</span>
            </li>
          ))}
          {f.bills.length > 5 && <li className="py-2 text-ink-3">and {f.bills.length - 5} more · {formatMoney(f.bills_total, "AZN", { decimals: false })} in total</li>}
        </ul>
      )}
    </section>
  );
}
