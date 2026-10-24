import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Search, X, Download } from "lucide-react";
import type { Transaction } from "@shared/types";
import { addDays, formatMoney, localDate, shiftPeriod } from "@shared/money";
import { get } from "../lib/api";
import { useAccounts, useBootstrap, useCategories } from "../lib/data";
import { Button, Empty, Spinner, clsx } from "../lib/ui";
import { PageHeader, useQuickAdd } from "../components/Layout";
import { TxEditor, TxList } from "../components/Transactions";

type Page = { items: Transaction[]; next_cursor: string | null };

export default function Activity() {
  const [params, setParams] = useSearchParams();
  const boot = useBootstrap();
  const cats = useCategories();
  const accounts = useAccounts();
  const quickAdd = useQuickAdd();
  const settings = boot.data?.settings;
  const tz = settings?.tz_offset_minutes ?? 240;
  const today = localDate(new Date(), tz);
  const [search, setSearch] = useState(params.get("q") ?? "");
  const [open, setOpen] = useState<Transaction | null>(null);

  const set = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const presets = useMemo(() => {
    const startDay = settings?.month_start_day ?? 1;
    const cur = shiftPeriod(today, startDay, 0);
    const prev = shiftPeriod(today, startDay, -1);
    return [
      { id: "period", label: "This month", from: cur.start, to: cur.end },
      { id: "last", label: "Last month", from: prev.start, to: prev.end },
      { id: "30", label: "30 days", from: addDays(today, -29), to: today },
      { id: "all", label: "All time", from: "", to: "" },
    ];
  }, [settings, today]);

  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  const activePreset = presets.find((p) => p.from === from && p.to === to)?.id ?? (from || to ? "custom" : "all");
  const query = new URLSearchParams(params);
  query.set("limit", "60");

  const list = useInfiniteQuery({
    queryKey: ["transactions", query.toString()],
    queryFn: ({ pageParam }) => get<Page>(`/transactions?${query.toString()}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`),
    initialPageParam: "",
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const spent = items.filter((t) => t.kind === "expense" && !t.excluded).reduce((s, t) => s - t.amount_base, 0);
  const category = params.get("category");
  const merchant = params.get("merchant");
  const review = params.get("review") === "1";

  return (
    <div>
      <PageHeader
        title="Activity"
        subtitle={
          items.length
            ? `${items.length}${list.hasNextPage ? "+" : ""} ${items.length === 1 ? "transaction" : "transactions"} · ${formatMoney(spent)} spent`
            : undefined
        }
        actions={
          <>
            <a href="/api/export/transactions.csv" className="hidden sm:block">
              <Button size="sm" variant="ghost">
                <Download size={16} /> Export
              </Button>
            </a>
            <Button size="sm" variant="primary" onClick={quickAdd}>
              Add
            </Button>
          </>
        }
      />

      <form
        className="relative mt-4"
        onSubmit={(e) => {
          e.preventDefault();
          set("q", search.trim() || null);
        }}
      >
        <Search size={18} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-3" aria-hidden />
        <input
          className="field pl-10"
          placeholder="Search merchant, note or tag"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onBlur={() => set("q", search.trim() || null)}
          aria-label="Search transactions"
        />
      </form>

      <div className="scroll-x -mx-4 mt-3 flex gap-2 overflow-x-auto px-4 pb-1">
        {presets.map((p) => (
          <Chip
            key={p.id}
            active={activePreset === p.id}
            onClick={() => {
              const next = new URLSearchParams(params);
              if (p.from) next.set("from", p.from);
              else next.delete("from");
              if (p.to) next.set("to", p.to);
              else next.delete("to");
              setParams(next, { replace: true });
            }}
          >
            {p.label}
          </Chip>
        ))}
        <Chip active={review} onClick={() => set("review", review ? null : "1")}>
          Needs a check
        </Chip>
        <select
          className={clsx("h-9 shrink-0 rounded-full border border-line bg-surface px-3 text-sm", params.get("account") && "border-accent bg-accent-soft")}
          value={params.get("account") ?? ""}
          onChange={(e) => set("account", e.target.value || null)}
          aria-label="Card"
        >
          <option value="">All cards</option>
          {accounts.list.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <select
          className={clsx("h-9 shrink-0 rounded-full border border-line bg-surface px-3 text-sm", params.get("kind") && "border-accent bg-accent-soft")}
          value={params.get("kind") ?? ""}
          onChange={(e) => set("kind", e.target.value || null)}
          aria-label="Type"
        >
          <option value="">All types</option>
          <option value="expense">Expenses</option>
          <option value="income">Income</option>
          <option value="transfer">Transfers</option>
        </select>
      </div>

      {(category || merchant || params.get("q")) && (
        <div className="mt-2 flex flex-wrap gap-2">
          {category && (
            <ActiveFilter onClear={() => set("category", null)}>
              {cats.info(Number(category))?.icon} {cats.info(Number(category))?.path}
            </ActiveFilter>
          )}
          {merchant && <ActiveFilter onClear={() => set("merchant", null)}>{items[0]?.merchant_name ?? "Merchant"}</ActiveFilter>}
          {params.get("q") && (
            <ActiveFilter
              onClear={() => {
                setSearch("");
                set("q", null);
              }}
            >
              “{params.get("q")}”
            </ActiveFilter>
          )}
        </div>
      )}

      <div className="mt-5">
        {list.isLoading ? (
          <Spinner />
        ) : items.length === 0 ? (
          <Empty title={review ? "Nothing to check" : "No transactions match"}>
            {review ? "All AI guesses have been confirmed. Nice." : "Try a different period or clear the filters."}
          </Empty>
        ) : (
          <>
            <TxList items={items} onOpen={setOpen} tz={tz} />
            {list.hasNextPage && (
              <div className="mt-4 flex justify-center">
                <Button onClick={() => list.fetchNextPage()} loading={list.isFetchingNextPage}>
                  Show more
                </Button>
              </div>
            )}
          </>
        )}
      </div>
      <TxEditor tx={open} onClose={() => setOpen(null)} />
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={clsx(
        "h-9 shrink-0 rounded-full border px-3.5 text-sm font-medium transition-colors",
        active ? "border-accent bg-accent-soft text-ink" : "border-line bg-surface text-ink-2 hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}

function ActiveFilter({ children, onClear }: { children: React.ReactNode; onClear: () => void }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 py-1 pl-3 pr-1.5 text-sm">
      {children}
      <button onClick={onClear} className="rounded-full p-0.5 text-ink-3 hover:bg-line hover:text-ink" aria-label="Remove filter">
        <X size={14} />
      </button>
    </span>
  );
}
