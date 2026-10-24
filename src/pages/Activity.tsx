import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useInfiniteQuery, useMutation } from "@tanstack/react-query";
import { Search, X, Download, CheckSquare, ArrowLeftRight, Tag, EyeOff, Trash2 } from "lucide-react";
import type { Transaction } from "@shared/types";
import { addDays, formatDay, formatMoney, localDate, shiftPeriod } from "@shared/money";
import { get, post } from "../lib/api";
import { useAccounts, useBootstrap, useCategories, useRefresh } from "../lib/data";
import { Button, Chip, Empty, Sheet, Spinner, clsx, errorText, useToast } from "../lib/ui";
import { PageHeader, useQuickAdd } from "../components/Layout";
import { TxEditor, TxList } from "../components/Transactions";
import { TransferPairsBanner } from "../components/Transfers";
import { CategoryPicker } from "../components/CategoryPicker";

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
  const [pickDates, setPickDates] = useState(false);
  const [selected, setSelected] = useState<Set<number> | null>(null);

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
            <Button size="sm" variant="ghost" onClick={() => setSelected(selected ? null : new Set())} aria-pressed={Boolean(selected)}>
              {selected ? "Cancel" : (
                <>
                  <CheckSquare size={16} /> Select
                </>
              )}
            </Button>
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

      <TransferPairsBanner className="mt-4" />

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
              setPickDates(false);
            }}
          >
            {p.label}
          </Chip>
        ))}
        <Chip
          active={activePreset === "custom" || pickDates}
          onClick={() => {
            if (!pickDates && !from && !to) {
              const next = new URLSearchParams(params);
              next.set("from", addDays(today, -6));
              next.set("to", today);
              setParams(next, { replace: true });
            }
            setPickDates(!pickDates || activePreset !== "custom");
          }}
        >
          {activePreset === "custom" ? `${from ? formatDay(from) : "…"} – ${to ? formatDay(to) : "…"}` : "Custom dates"}
        </Chip>
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

      {pickDates && (
        <div className="mt-2 flex max-w-md items-center gap-2">
          <input type="date" className="field min-h-10 py-1.5" value={from} max={to || undefined} onChange={(e) => set("from", e.target.value || null)} aria-label="From" />
          <span className="text-ink-3">–</span>
          <input type="date" className="field min-h-10 py-1.5" value={to} min={from || undefined} onChange={(e) => set("to", e.target.value || null)} aria-label="To" />
          <Button size="sm" variant="ghost" onClick={() => setPickDates(false)}>
            Done
          </Button>
        </div>
      )}

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
            {selected && (
              <p className="mb-3 px-1 text-sm text-ink-2">
                Tap transactions to select them.{" "}
                <button className="font-medium text-accent" onClick={() => setSelected(new Set(items.map((t) => t.id)))}>
                  Select all {items.length}
                </button>
              </p>
            )}
            <TxList
              items={items}
              tz={tz}
              selected={selected ?? undefined}
              onOpen={(t) => {
                if (!selected) return setOpen(t);
                const next = new Set(selected);
                if (next.has(t.id)) next.delete(t.id);
                else next.add(t.id);
                setSelected(next);
              }}
            />
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
      {selected && <div className="h-36" aria-hidden />}
      {selected && selected.size > 0 && (
        <BulkBar items={items.filter((t) => selected.has(t.id))} onDone={() => setSelected(null)} onClear={() => setSelected(new Set())} />
      )}
    </div>
  );
}

/** Actions for several selected transactions at once. */
function BulkBar({ items, onDone, onClear }: { items: Transaction[]; onDone: () => void; onClear: () => void }) {
  const refresh = useRefresh();
  const toast = useToast();
  const [picking, setPicking] = useState(false);
  const ids = items.map((t) => t.id);
  const run = useMutation({
    mutationFn: (body: Record<string, unknown>) => post("/transactions/bulk", { ids, ...body }),
    onSuccess: (_r, body) => {
      const n = ids.length;
      const what = n === 1 ? "1 transaction" : `${n} transactions`;
      toast(
        body.delete
          ? `Deleted ${what}`
          : body.kind === "transfer"
            ? `Marked ${what} as between your cards`
            : body.kind
              ? `${what} count as spending and income again`
              : body.category_id
                ? `Changed the category of ${what}`
                : body.excluded
                  ? `${what} left out of statistics`
                  : `${what} counted in statistics again`,
      );
      refresh();
      onDone();
    },
    onError: (e) => toast(errorText(e), "error"),
  });
  const anyTransfer = items.some((t) => t.kind === "transfer");
  const allTransfer = items.every((t) => t.kind === "transfer");
  const allExcluded = items.every((t) => t.excluded);
  const net = items.reduce((s, t) => s + t.amount_base, 0);
  return (
    <>
      <div className="fixed inset-x-0 bottom-20 z-40 px-3 lg:bottom-6 lg:left-64">
        <div className="sheet-in mx-auto max-w-3xl rounded-2xl border border-line bg-surface p-2 shadow-sheet">
          <div className="flex items-center justify-between gap-2 px-2 pb-1.5 pt-0.5 text-sm">
            <span>
              <strong className="font-semibold">{ids.length}</strong> selected
              <span className="num ml-2 text-ink-3">{formatMoney(net, "AZN", { sign: net > 0 })}</span>
            </span>
            <button className="font-medium text-ink-3 hover:text-ink" onClick={onClear}>
              Clear
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {!allTransfer && (
              <Button size="sm" variant="primary" className="shrink-0" disabled={run.isPending} onClick={() => run.mutate({ kind: "transfer" })}>
                <ArrowLeftRight size={16} /> Between my cards
              </Button>
            )}
            {anyTransfer && (
              <Button size="sm" className="shrink-0" disabled={run.isPending} onClick={() => run.mutate({ kind: "expense" })}>
                Not a transfer
              </Button>
            )}
            <Button size="sm" className="shrink-0" disabled={run.isPending} onClick={() => setPicking(true)}>
              <Tag size={16} /> Category
            </Button>
            <Button size="sm" className="shrink-0" disabled={run.isPending} onClick={() => run.mutate({ excluded: !allExcluded })}>
              <EyeOff size={16} /> {allExcluded ? "Count in stats" : "Leave out of stats"}
            </Button>
            <Button
              size="sm"
              variant="danger"
              className="shrink-0"
              disabled={run.isPending}
              onClick={() => window.confirm(`Delete ${ids.length} ${ids.length === 1 ? "transaction" : "transactions"}? This can't be undone.`) && run.mutate({ delete: true })}
            >
              <Trash2 size={16} /> Delete
            </Button>
          </div>
        </div>
      </div>
      <Sheet open={picking} onClose={() => setPicking(false)} title={`Category for ${ids.length} ${ids.length === 1 ? "transaction" : "transactions"}`}>
        <CategoryPicker
          value={null}
          onChange={(id) => {
            setPicking(false);
            run.mutate({ category_id: id });
          }}
        />
      </Sheet>
    </>
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
