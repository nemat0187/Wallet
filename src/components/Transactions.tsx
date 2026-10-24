import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Sparkles, MessageSquareText, Trash2, EyeOff, Check, ArrowLeftRight, ListFilter } from "lucide-react";
import type { Transaction, TxKind } from "@shared/types";
import { formatDay, formatMoney } from "@shared/money";
import { del, get, patch } from "../lib/api";
import { useAccounts, useCategories, useRefresh } from "../lib/data";
import { Button, ErrorNote, Label, Segmented, Sheet, Spinner, Toggle, clsx, errorText, useToast } from "../lib/ui";
import { CategoryPicker } from "./CategoryPicker";
import { PairSummary, usePairActions } from "./Transfers";
import { RuleEditor, ruleFromTransaction } from "./RuleEditor";

export function CategoryIcon({ id, size = 40 }: { id: number | null; size?: number }) {
  const cats = useCategories();
  const info = cats.info(id);
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full"
      style={{ width: size, height: size, background: `${info?.color ?? "#94a3b8"}24`, fontSize: size * 0.48 }}
      aria-hidden
    >
      {info?.icon ?? "❔"}
    </span>
  );
}

export function txTitle(t: Transaction): string {
  return t.merchant_name ?? t.merchant_raw ?? t.description ?? (t.amount >= 0 ? "Money in" : "Payment");
}

function localTime(iso: string, offsetMin: number): string {
  const d = new Date(Date.parse(iso) + offsetMin * 60_000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

export function TxRow({
  t,
  onClick,
  tz = 240,
  showDate,
  selected,
}: {
  t: Transaction;
  onClick: () => void;
  tz?: number;
  showDate?: boolean;
  /** undefined = not in selection mode */
  selected?: boolean;
}) {
  const cats = useCategories();
  const accounts = useAccounts();
  const cat = cats.info(t.category_id);
  const account = t.account_id ? accounts.byId.get(t.account_id) : null;
  const possibleTransfer = Boolean(t.pair_id) && t.kind !== "transfer";
  return (
    <button
      onClick={onClick}
      aria-pressed={selected}
      className={clsx("flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-surface-2 sm:px-4", selected && "bg-accent-soft hover:bg-accent-soft")}
    >
      {selected !== undefined && (
        <span
          className={clsx(
            "flex h-5 w-5 shrink-0 items-center justify-center rounded-md border",
            selected ? "border-accent bg-accent text-accent-ink" : "border-line bg-surface",
          )}
          aria-hidden
        >
          {selected && <Check size={14} strokeWidth={3} />}
        </span>
      )}
      <CategoryIcon id={t.category_id} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className={clsx("truncate font-medium", t.excluded && "text-ink-3 line-through")}>{txTitle(t)}</span>
          {t.needs_review ? (
            <Sparkles size={14} className="shrink-0 text-warn" aria-label="Category guessed by AI — please check" />
          ) : null}
          {t.excluded ? <EyeOff size={14} className="shrink-0 text-ink-3" aria-label="Not counted in statistics" /> : null}
          {possibleTransfer && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-accent-soft px-1.5 text-[12px] font-medium leading-5 text-accent" title="Looks like a transfer between your own cards">
              <ArrowLeftRight size={11} aria-hidden /> own transfer?
            </span>
          )}
        </span>
        <span className="block truncate text-[13px] text-ink-3">
          {cat?.name ?? "Uncategorized"}
          {account ? ` · ${account.name.replace(/^ABB card /, "")}` : ""}
          {` · ${showDate ? `${formatDay(t.local_date)}, ` : ""}${localTime(t.occurred_at, tz)}`}
        </span>
      </span>
      <span className="text-right">
        <span className={clsx("num block font-semibold", t.amount > 0 && t.kind !== "transfer" && "text-good", t.kind === "transfer" && "text-ink-3")}>
          {formatMoney(t.amount, t.currency, { sign: t.amount > 0 })}
        </span>
        {t.orig_currency && t.orig_amount ? (
          <span className="num block text-[12px] text-ink-3">{formatMoney(t.orig_amount, t.orig_currency)}</span>
        ) : null}
      </span>
    </button>
  );
}

/** Day-grouped transaction list with a daily total. */
export function TxList({
  items,
  onOpen,
  tz,
  selected,
}: {
  items: Transaction[];
  onOpen: (t: Transaction) => void;
  tz: number;
  /** When set, rows show a checkbox and clicking toggles instead of opening. */
  selected?: Set<number>;
}) {
  const groups: { date: string; items: Transaction[]; spent: number }[] = [];
  for (const t of items) {
    let g = groups[groups.length - 1];
    if (!g || g.date !== t.local_date) groups.push((g = { date: t.local_date, items: [], spent: 0 }));
    g.items.push(t);
    if (t.kind === "expense" && !t.excluded) g.spent -= t.amount_base;
  }
  return (
    <div className="flex flex-col gap-4">
      {groups.map((g) => (
        <div key={g.date}>
          <div className="flex items-baseline justify-between px-1 pb-1.5 text-sm">
            <span className="font-medium text-ink-2">{dayLabel(g.date)}</span>
            {g.spent !== 0 && <span className="num text-ink-3">{formatMoney(g.spent)}</span>}
          </div>
          <div className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
            {g.items.map((t) => (
              <TxRow key={t.id} t={t} tz={tz} onClick={() => onOpen(t)} selected={selected ? selected.has(t.id) : undefined} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function dayLabel(ymd: string): string {
  const today = new Date();
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  if (ymd === iso(today)) return "Today";
  const y = new Date(today);
  y.setDate(y.getDate() - 1);
  if (ymd === iso(y)) return "Yesterday";
  const weekday = new Date(`${ymd}T12:00:00`).toLocaleDateString("en-GB", { weekday: "long" });
  return `${weekday}, ${formatDay(ymd, ymd.slice(0, 4) !== String(today.getFullYear()))}`;
}

type Detail = Transaction & { message: { id: number; body: string; received_at: string; parse_method: string } | null; pair: Transaction | null };

export function TxEditor({ tx, onClose }: { tx: Transaction | null; onClose: () => void }) {
  const [ruleFrom, setRuleFrom] = useState<Transaction | null>(null);
  return (
    <>
      <Sheet open={Boolean(tx)} onClose={onClose} title="Transaction">
        {tx && (
          <EditorBody
            key={tx.id}
            tx={tx}
            onClose={onClose}
            onMakeRule={() => {
              setRuleFrom(tx);
              onClose();
            }}
          />
        )}
      </Sheet>
      {ruleFrom && <RuleEditor initial={ruleFromTransaction(ruleFrom)} onClose={() => setRuleFrom(null)} />}
    </>
  );
}

function EditorBody({ tx, onClose, onMakeRule }: { tx: Transaction; onClose: () => void; onMakeRule: () => void }) {
  const cats = useCategories();
  const accounts = useAccounts();
  const refresh = useRefresh();
  const toast = useToast();
  const detail = useQuery({ queryKey: ["tx", tx.id], queryFn: () => get<Detail>(`/transactions/${tx.id}`) });
  const [categoryId, setCategoryId] = useState<number | null>(tx.category_id);
  const [picking, setPicking] = useState(false);
  const [applyAll, setApplyAll] = useState(true);
  const [kind, setKind] = useState<TxKind>(tx.kind);
  const [note, setNote] = useState(tx.note ?? "");
  const [tags, setTags] = useState(tx.tags ?? "");
  const [excluded, setExcluded] = useState(Boolean(tx.excluded));
  const [name, setName] = useState(txTitle(tx));
  const [accountId, setAccountId] = useState<number | null>(tx.account_id);
  const [showMessage, setShowMessage] = useState(false);
  const [withPair, setWithPair] = useState(true);
  const { mark, dismiss } = usePairActions();
  useEffect(() => setPicking(false), [categoryId]);
  const pair = detail.data?.pair ?? null;
  // The counterpart follows along only while both sides are in the same state.
  const pairFollows = pair !== null && (pair.kind === "transfer") === (tx.kind === "transfer");

  const save = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {};
      if (categoryId !== tx.category_id && categoryId && kind !== "transfer") {
        body.category_id = categoryId;
        body.apply_to_merchant = Boolean(tx.merchant_id) && applyAll;
      }
      if (kind !== tx.kind) {
        body.kind = kind;
        if (pairFollows && withPair && (kind === "transfer" || tx.kind === "transfer")) body.include_pair = true;
      }
      if (note !== (tx.note ?? "")) body.note = note || null;
      if (tags !== (tx.tags ?? "")) body.tags = tags || null;
      if (excluded !== Boolean(tx.excluded)) body.excluded = excluded;
      if (name.trim() && name.trim() !== txTitle(tx)) body.merchant_name = name.trim();
      if (accountId !== tx.account_id) body.account_id = accountId;
      if (tx.needs_review) body.reviewed = true;
      if (Object.keys(body).length === 0) return { applied_to_others: 0 };
      return patch<{ applied_to_others: number }>(`/transactions/${tx.id}`, body);
    },
    onSuccess: (r) => {
      const both = pairFollows && withPair && kind !== tx.kind && (kind === "transfer" || tx.kind === "transfer");
      toast(r.applied_to_others > 1 ? `Saved · updated ${r.applied_to_others} transactions from this merchant` : both ? "Saved both sides of the transfer" : "Saved");
      refresh();
      onClose();
    },
  });
  const remove = useMutation({
    mutationFn: () => del(`/transactions/${tx.id}`),
    onSuccess: () => {
      toast("Transaction deleted");
      refresh();
      onClose();
    },
    onError: (e) => toast(errorText(e), "error"),
  });
  const cat = cats.info(categoryId);
  const account = tx.account_id ? accounts.byId.get(tx.account_id) : null;
  const source = { sms: "Bank message", push: "Bank notification", import: "Imported statement", manual: "Added by hand", telegram: "Telegram" }[tx.source];

  return (
    <div className="flex flex-col gap-5">
      <div className="text-center">
        <div className={clsx("text-4xl font-semibold tracking-tight num", tx.amount > 0 && "text-good")}>
          {formatMoney(tx.amount, tx.currency, { sign: tx.amount > 0 })}
        </div>
        {tx.orig_amount && tx.orig_currency ? (
          <div className="mt-1 text-sm text-ink-3 num">Paid {formatMoney(tx.orig_amount, tx.orig_currency)}</div>
        ) : null}
        <div className="mt-1 text-sm text-ink-2">
          {dayLabel(tx.local_date)}
          {account ? ` · ${account.name}` : ""}
          {tx.balance_after !== null ? ` · balance after ${formatMoney(tx.balance_after, tx.currency)}` : ""}
        </div>
      </div>

      {tx.needs_review ? (
        <p className="flex items-start gap-2 rounded-xl bg-warn-soft px-3 py-2 text-sm text-ink">
          <Sparkles size={16} className="mt-0.5 shrink-0 text-warn" aria-hidden />
          AI wasn't fully sure about this category. Fix it or just press Save to confirm.
        </p>
      ) : null}

      {pair && tx.kind !== "transfer" && pair.kind !== "transfer" && (
        <div className="rounded-xl bg-accent-soft px-3 py-3">
          <p className="flex items-start gap-2 text-sm">
            <ArrowLeftRight size={16} className="mt-0.5 shrink-0 text-accent" aria-hidden />
            <span>
              {tx.amount < 0 ? "The same amount arrived on your other card" : "The same amount left your other card"} right then. Was this money moved between your
              own cards?
            </span>
          </p>
          <div className="mt-2 rounded-lg bg-surface px-3 py-2">
            <PairSummary out={tx.amount < 0 ? tx : pair} into={tx.amount < 0 ? pair : tx} />
          </div>
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              variant="primary"
              className="flex-1"
              loading={mark.isPending}
              onClick={() => mark.mutate([tx.id, pair.id], { onSuccess: onClose })}
            >
              Yes, my transfer
            </Button>
            <Button size="sm" className="flex-1" loading={dismiss.isPending} onClick={() => dismiss.mutate(tx.id)}>
              Not a transfer
            </Button>
          </div>
        </div>
      )}

      <label className="block">
        <Label>Merchant</Label>
        <input className="field" value={name} onChange={(e) => setName(e.target.value)} />
      </label>

      {kind === "transfer" ? (
        <div>
          <Label>Category</Label>
          <p className="field flex items-center gap-3 text-ink-2">
            <ArrowLeftRight size={18} className="text-accent" aria-hidden /> Between my accounts
          </p>
        </div>
      ) : (
      <div>
        <Label
          hint={
            tx.category_source === "ai"
              ? "(chosen by AI)"
              : tx.category_source === "pending"
                ? "(AI will suggest one shortly)"
                : tx.category_source === "rule"
                  ? "(set by a rule)"
                  : undefined
          }
        >
          Category
        </Label>
        <button
          type="button"
          onClick={() => setPicking((p) => !p)}
          className="field flex items-center gap-3 text-left"
          aria-expanded={picking}
        >
          <CategoryIcon id={categoryId} size={28} />
          <span className="flex-1">{cat?.path ?? "Choose a category"}</span>
          <span className="text-sm font-medium text-accent">{picking ? "Close" : "Change"}</span>
        </button>
        {picking && (
          <div className="mt-2">
            <CategoryPicker value={categoryId} onChange={setCategoryId} />
          </div>
        )}
        {categoryId !== tx.category_id && tx.merchant_id ? (
          <Toggle
            checked={applyAll}
            onChange={setApplyAll}
            label={`Use for every “${txTitle(tx)}” transaction`}
            hint="Past ones are updated and future ones are categorized automatically."
          />
        ) : null}
      </div>
      )}

      <div>
        <Label>Type</Label>
        <Segmented
          value={kind}
          onChange={setKind}
          options={[
            { value: "expense", label: "Expense" },
            { value: "income", label: "Income" },
            { value: "transfer", label: "Between my cards" },
          ]}
        />
        {kind === "transfer" ? (
          <p className="mt-1.5 text-sm text-ink-3">Money moved between your own cards or accounts. It doesn't count as spending, income or against budgets.</p>
        ) : tx.kind === "transfer" ? (
          <p className="mt-1.5 text-sm text-ink-3">It will count as {kind === "income" ? "income" : "spending"} again.</p>
        ) : null}
        {pairFollows && kind !== tx.kind && (kind === "transfer" || tx.kind === "transfer") && (
          <Toggle
            checked={withPair}
            onChange={setWithPair}
            label={`Also change the other side (${formatMoney(pair.amount, pair.currency, { sign: pair.amount > 0 })})`}
            hint="The matching transaction on your other card."
          />
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <Label>Card / account</Label>
          <select className="field" value={accountId ?? ""} onChange={(e) => setAccountId(e.target.value ? Number(e.target.value) : null)}>
            <option value="">None</option>
            {accounts.active.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <Label hint="(comma separated)">Tags</Label>
          <input className="field" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="e.g. trip, work" />
        </label>
      </div>

      <label className="block">
        <Label>Note</Label>
        <textarea className="field min-h-20" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Anything to remember" />
      </label>

      <Toggle checked={excluded} onChange={setExcluded} label="Leave out of statistics" hint="For one-off things you don't want in your averages, like a loan to a friend." />

      <div className="rounded-xl bg-surface-2 px-3 py-2.5 text-sm text-ink-2">
        <button type="button" className="flex w-full items-center gap-2 text-left" onClick={() => setShowMessage((s) => !s)}>
          <MessageSquareText size={16} aria-hidden />
          <span className="flex-1">Source: {source}</span>
          {detail.data?.message && <span className="font-medium text-accent">{showMessage ? "Hide" : "Show message"}</span>}
        </button>
        {showMessage && detail.data?.message && (
          <pre className="mt-2 whitespace-pre-wrap break-words font-sans text-[13px] text-ink">{detail.data.message.body}</pre>
        )}
        {detail.isLoading && <Spinner />}
      </div>

      <button type="button" onClick={onMakeRule} className="flex items-center gap-2 self-start text-sm font-medium text-accent">
        <ListFilter size={16} aria-hidden /> Create a rule from this transaction
      </button>

      <ErrorNote error={save.error} />
      <div className="flex gap-2">
        <Button variant="primary" className="flex-1" loading={save.isPending} onClick={() => save.mutate()}>
          Save
        </Button>
        <Button
          variant="danger"
          aria-label="Delete transaction"
          loading={remove.isPending}
          onClick={() => window.confirm("Delete this transaction?") && remove.mutate()}
        >
          <Trash2 size={18} />
        </Button>
      </div>
    </div>
  );
}
