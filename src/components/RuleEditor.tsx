import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import type { Rule, Transaction, TxKind } from "@shared/types";
import type { Condition, ListField, NumberOp, TextField, TextOp } from "@shared/rules";
import { TX_TYPES, WEEKDAYS, ruleConditions } from "@shared/rules";
import { formatDay, formatMoney, parseAmount } from "@shared/money";
import { del, post, put } from "../lib/api";
import { useAccounts, useCategories, useRefresh } from "../lib/data";
import { Button, Chip, ErrorNote, Label, Segmented, Sheet, Toggle, clsx, errorText, useToast } from "../lib/ui";
import { CategoryMultiPicker, CategoryPicker } from "./CategoryPicker";

export interface RuleDraft {
  id?: number;
  name: string;
  conditions: Condition[];
  match_mode: "all" | "any";
  set_category_id: number | null;
  set_kind: TxKind | null;
  set_merchant_name: string;
  set_excluded: boolean | null;
  set_tags: string;
  set_note: string;
  continue_after: boolean;
  enabled: boolean;
}

type Field = Condition["field"];

const FIELDS: { value: Field; label: string; group: string }[] = [
  { value: "merchant", label: "Merchant name", group: "Text" },
  { value: "description", label: "Bank's description", group: "Text" },
  { value: "message", label: "Full bank message", group: "Text" },
  { value: "any_text", label: "Any text", group: "Text" },
  { value: "amount", label: "Amount", group: "Money" },
  { value: "direction", label: "Money in or out", group: "Money" },
  { value: "currency", label: "Currency", group: "Money" },
  { value: "account", label: "Card", group: "Details" },
  { value: "type", label: "Transaction type", group: "Details" },
  { value: "category", label: "Category (as the app chose it)", group: "Details" },
  { value: "weekday", label: "Day of week", group: "Time" },
  { value: "hour", label: "Time of day", group: "Time" },
];

const TEXT_OPS: { value: TextOp; label: string }[] = [
  { value: "contains", label: "contains" },
  { value: "not_contains", label: "doesn't contain" },
  { value: "equals", label: "is exactly" },
  { value: "starts_with", label: "starts with" },
  { value: "ends_with", label: "ends with" },
  { value: "regex", label: "matches pattern (regex)" },
];

const NUMBER_OPS: { value: NumberOp; label: string; symbol: string }[] = [
  { value: "eq", label: "is exactly", symbol: "=" },
  { value: "ne", label: "is not", symbol: "≠" },
  { value: "gt", label: "is more than", symbol: ">" },
  { value: "gte", label: "is at least", symbol: "≥" },
  { value: "lt", label: "is less than", symbol: "<" },
  { value: "lte", label: "is at most", symbol: "≤" },
  { value: "between", label: "is between", symbol: "between" },
];

const CURRENCIES = ["AZN", "USD", "EUR", "RUB", "TRY", "GBP", "GEL", "AED"];
const TEXT_FIELDS: Field[] = ["merchant", "description", "message", "any_text"];
const LIST_FIELDS: Field[] = ["account", "type", "weekday", "currency", "category"];

function defaultCondition(field: Field): Condition {
  if (TEXT_FIELDS.includes(field)) return { field: field as TextField, op: "contains", value: "" };
  if (field === "amount") return { field, op: "gt", value: 0 };
  if (field === "direction") return { field, op: "is", value: "out" };
  if (field === "hour") return { field, op: "between", value: 22, value2: 5 };
  return { field: field as ListField, op: "is", value: [] };
}

/** A condition that can actually match something (used to decide whether to preview or save). */
function complete(c: Condition): boolean {
  if (TEXT_FIELDS.includes(c.field)) return String(c.value).trim() !== "" || c.op === "equals";
  if (LIST_FIELDS.includes(c.field)) return (c.value as unknown[]).length > 0;
  if (c.field === "amount") return c.op !== "between" || (c.value2 !== null && c.value2 !== undefined);
  return true;
}

export const emptyRule = (): RuleDraft => ({
  name: "",
  conditions: [defaultCondition("merchant")],
  match_mode: "all",
  set_category_id: null,
  set_kind: null,
  set_merchant_name: "",
  set_excluded: null,
  set_tags: "",
  set_note: "",
  continue_after: false,
  enabled: true,
});

export function draftFromRule(r: Rule): RuleDraft {
  return {
    id: r.id,
    name: r.name ?? "",
    conditions: ruleConditions(r),
    match_mode: r.match_mode ?? "all",
    set_category_id: r.set_category_id,
    set_kind: r.set_kind,
    set_merchant_name: r.set_merchant_name ?? "",
    set_excluded: r.set_excluded === null || r.set_excluded === undefined ? null : r.set_excluded === 1,
    set_tags: r.set_tags ?? "",
    set_note: r.set_note ?? "",
    continue_after: Boolean(r.continue_after),
    enabled: r.enabled !== 0,
  };
}

/** Prefill a rule that would catch transactions like this one. */
export function ruleFromTransaction(tx: Transaction): RuleDraft {
  const isTransfer = tx.tx_type === "transfer_in" || tx.tx_type === "transfer_out";
  const conditions: Condition[] = [];
  const name = tx.merchant_name ?? tx.merchant_raw;
  if (isTransfer || !name) {
    // Transfers have no merchant: recognise them by card, type and amount instead.
    if (tx.tx_type) conditions.push({ field: "type", op: "is", value: [tx.tx_type] });
    if (tx.account_id) conditions.push({ field: "account", op: "is", value: [tx.account_id] });
    conditions.push({ field: "amount", op: "eq", value: Math.abs(tx.amount) });
  } else {
    conditions.push({ field: "merchant", op: "contains", value: name });
    conditions.push({ field: "direction", op: "is", value: tx.amount < 0 ? "out" : "in" });
  }
  return { ...emptyRule(), name: name ?? "", conditions, set_category_id: tx.kind === "transfer" ? null : tx.category_id, set_kind: tx.kind === "transfer" ? "transfer" : null };
}

const money = (v: number) => formatMoney(v, "AZN", { decimals: v % 100 !== 0 });

/** "Merchant contains “BOLT” and amount > 20 ₼" */
export function describeConditions(
  conditions: Condition[],
  mode: "all" | "any",
  names: { account: (id: number) => string; category: (id: number) => string },
): string {
  const parts = conditions.map((c) => {
    const field = FIELDS.find((f) => f.value === c.field)?.label.replace(/ \(.*\)$/, "").toLowerCase() ?? c.field;
    if (TEXT_FIELDS.includes(c.field)) return `${field} ${TEXT_OPS.find((o) => o.value === c.op)?.label} “${c.value}”`;
    if (c.field === "amount") {
      if (c.op === "between") return `amount ${money(c.value)}–${money(c.value2 ?? c.value)}`;
      return `amount ${NUMBER_OPS.find((o) => o.value === c.op)?.symbol} ${money(c.value)}`;
    }
    if (c.field === "direction") return c.value === "out" ? "money out" : "money in";
    if (c.field === "hour") return `between ${String(c.value).padStart(2, "0")}:00 and ${String(c.value2).padStart(2, "0")}:59`;
    const values = (c.value as (string | number)[]).map((v) => {
      if (c.field === "account") return names.account(Number(v));
      if (c.field === "category") return names.category(Number(v));
      if (c.field === "type") return TX_TYPES.find((t) => t.value === v)?.label.toLowerCase() ?? String(v);
      if (c.field === "weekday") return WEEKDAYS[Number(v)];
      return String(v);
    });
    return `${field} ${c.op === "is_not" ? "is not" : "is"} ${values.join(" or ")}`;
  });
  return parts.join(mode === "any" ? " or " : " and ");
}

export function describeActions(r: Pick<RuleDraft, "set_category_id" | "set_kind" | "set_merchant_name" | "set_excluded" | "set_tags" | "set_note">, category: (id: number) => string): string {
  const out: string[] = [];
  if (r.set_category_id) out.push(category(r.set_category_id));
  if (r.set_kind === "transfer") out.push("between my cards");
  else if (r.set_kind) out.push(`mark as ${r.set_kind}`);
  if (r.set_merchant_name) out.push(`rename to “${r.set_merchant_name}”`);
  if (r.set_tags?.trim()) out.push(`tag ${r.set_tags.split(",").map((t) => `“${t.trim()}”`).filter((t) => t !== "“”").join(", ")}`);
  if (r.set_note?.trim()) out.push("add a note");
  if (r.set_excluded === true) out.push("leave out of statistics");
  if (r.set_excluded === false) out.push("count in statistics");
  return out.join(", ");
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

interface TestResult {
  matched: number;
  total: number;
  spent: number;
  sample: { id: number; local_date: string; amount: number; currency: string; merchant: string | null; category_id: number | null }[];
}

export function RuleEditor({ initial, onClose }: { initial: RuleDraft; onClose: () => void }) {
  const [r, setR] = useState<RuleDraft>(initial);
  const [pickingCategory, setPickingCategory] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const cats = useCategories();
  const refresh = useRefresh();
  const qc = useQueryClient();
  const toast = useToast();
  const set = (patch: Partial<RuleDraft>) => setR((x) => ({ ...x, ...patch }));
  const setCondition = (i: number, c: Condition) => set({ conditions: r.conditions.map((x, j) => (j === i ? c : x)) });

  const usable = r.conditions.filter(complete);
  const testBody = useDebounced(JSON.stringify({ conditions: usable, match_mode: r.match_mode }), 400);
  const test = useQuery({
    queryKey: ["rule-test", testBody],
    queryFn: () => post<TestResult>("/rules/test", JSON.parse(testBody)),
    enabled: usable.length > 0 && JSON.parse(testBody).conditions.length > 0,
    placeholderData: (p) => p,
  });

  const hasAction =
    Boolean(r.set_category_id || r.set_kind || r.set_merchant_name.trim() || r.set_tags.trim() || r.set_note.trim()) || r.set_excluded !== null;
  const body = () => ({
    name: r.name.trim() || null,
    conditions: usable,
    match_mode: r.match_mode,
    set_category_id: r.set_kind === "transfer" ? null : r.set_category_id,
    set_kind: r.set_kind,
    set_merchant_name: r.set_merchant_name.trim() || null,
    set_excluded: r.set_excluded,
    set_tags: r.set_tags.trim() || null,
    set_note: r.set_note.trim() || null,
    continue_after: r.continue_after,
    enabled: r.enabled,
  });
  const save = useMutation({
    mutationFn: async (applyNow: boolean) => {
      if (usable.length < r.conditions.length) throw new Error("A condition is still empty. Fill it in or remove it with ×.");
      if (!hasAction) throw new Error("Choose at least one thing the rule should do.");
      const id = r.id ? (await put(`/rules/${r.id}`, body()), r.id) : (await post<{ id: number }>("/rules", body())).id;
      return applyNow ? post<{ matched: number }>(`/rules/${id}/apply`) : { matched: -1 };
    },
    onSuccess: (res) => {
      toast(res.matched >= 0 ? `Rule saved and applied to ${res.matched} ${res.matched === 1 ? "transaction" : "transactions"}` : "Rule saved");
      qc.invalidateQueries({ queryKey: ["rules"] });
      if (res.matched > 0) refresh();
      onClose();
    },
  });
  const remove = useMutation({
    mutationFn: () => del(`/rules/${r.id}`),
    onSuccess: () => {
      toast("Rule deleted");
      qc.invalidateQueries({ queryKey: ["rules"] });
      onClose();
    },
    onError: (e) => toast(errorText(e), "error"),
  });

  return (
    <Sheet
      open
      wide
      onClose={onClose}
      title={r.id ? "Edit rule" : "New rule"}
      footer={
        <div className="flex flex-wrap items-center gap-2">
          {r.id &&
            (confirmDelete ? (
              <>
                <Button size="sm" variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>
                  Yes, delete
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
                  Keep
                </Button>
              </>
            ) : (
              <Button size="sm" variant="danger" onClick={() => setConfirmDelete(true)}>
                Delete
              </Button>
            ))}
          <div className="ml-auto flex min-w-0 flex-1 gap-2 sm:flex-none">
            <Button className="flex-1 sm:flex-none" loading={save.isPending && save.variables === false} onClick={() => save.mutate(false)} title="Only new transactions">
              Save
            </Button>
            <Button className="flex-1 sm:flex-none" variant="primary" loading={save.isPending && save.variables === true} onClick={() => save.mutate(true)}>
              Save &amp; apply
            </Button>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        <label className="block">
          <Label hint="(optional)">Name</Label>
          <input className="field" value={r.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Rent to landlord" />
        </label>

        <fieldset className="rounded-2xl border border-line p-4">
          <legend className="px-1 text-sm font-medium text-ink-2">When a transaction matches</legend>
          {r.conditions.length > 1 && (
            <Segmented
              className="mb-3"
              value={r.match_mode}
              onChange={(match_mode) => set({ match_mode })}
              options={[
                { value: "all", label: "All of these" },
                { value: "any", label: "Any of these" },
              ]}
            />
          )}
          <ul className="flex flex-col gap-3">
            {r.conditions.map((c, i) => (
              <li key={i} className="rounded-xl bg-surface-2 p-3">
                {i > 0 && <p className="-mt-1 mb-2 text-[12px] font-semibold uppercase tracking-wide text-ink-3">{r.match_mode === "all" ? "and" : "or"}</p>}
                <ConditionRow
                  condition={c}
                  onChange={(next) => setCondition(i, next)}
                  onRemove={r.conditions.length > 1 ? () => set({ conditions: r.conditions.filter((_, j) => j !== i) }) : undefined}
                />
              </li>
            ))}
          </ul>
          {r.conditions.length < 20 && (
            <button
              type="button"
              onClick={() => set({ conditions: [...r.conditions, defaultCondition("amount")] })}
              className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-accent"
            >
              <Plus size={16} /> Add condition
            </button>
          )}

          <div className="mt-4 border-t border-line pt-3 text-sm" aria-live="polite">
            {usable.length === 0 ? (
              <p className="text-ink-3">Fill in a condition to see which of your transactions it catches.</p>
            ) : test.data ? (
              <>
                <p className={clsx(test.isFetching && "opacity-60")}>
                  Matches <strong className="font-semibold">{test.data.matched}</strong> of your {test.data.total} transactions
                  {test.data.spent > 0 && <span className="text-ink-2"> · {formatMoney(test.data.spent)} spent</span>}
                </p>
                {test.data.sample.length > 0 && (
                  <ul className="mt-2 divide-y divide-line rounded-xl border border-line bg-surface">
                    {test.data.sample.slice(0, showAll ? 25 : 5).map((t) => (
                      <li key={t.id} className="flex items-center gap-2 px-3 py-2">
                        <span aria-hidden>{cats.info(t.category_id)?.icon ?? "•"}</span>
                        <span className="min-w-0 flex-1 truncate">{t.merchant ?? "—"}</span>
                        <span className="text-[13px] text-ink-3">{formatDay(t.local_date)}</span>
                        <span className={clsx("num w-24 text-right font-medium", t.amount > 0 && "text-good")}>
                          {formatMoney(t.amount, t.currency, { sign: t.amount > 0 })}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {test.data.matched > 0 && (
                  <p className="mt-1.5 text-[13px] text-ink-3">“Save &amp; apply” also changes these past transactions. “Save” only affects new ones.</p>
                )}
                {test.data.sample.length > 5 && (
                  <button type="button" className="mt-1.5 text-sm font-medium text-accent" onClick={() => setShowAll((s) => !s)}>
                    {showAll ? "Show fewer" : `Show ${Math.min(25, test.data.matched)} examples`}
                  </button>
                )}
              </>
            ) : test.error ? (
              <ErrorNote error={test.error} />
            ) : (
              <p className="text-ink-3">Checking your transactions…</p>
            )}
          </div>
        </fieldset>

        <fieldset className="flex flex-col gap-4 rounded-2xl border border-line p-4">
          <legend className="px-1 text-sm font-medium text-ink-2">Then</legend>
          <div>
            <Label>Type</Label>
            <Segmented
              value={r.set_kind ?? "keep"}
              onChange={(v) => set({ set_kind: v === "keep" ? null : (v as TxKind) })}
              options={[
                { value: "keep", label: "Don't change" },
                { value: "expense", label: "Expense" },
                { value: "income", label: "Income" },
                { value: "transfer", label: "Between my cards" },
              ]}
              className="flex-wrap"
            />
          </div>
          {r.set_kind !== "transfer" && (
            <div>
              <Label>Set category</Label>
              <button type="button" onClick={() => setPickingCategory((p) => !p)} className="field flex items-center gap-3 text-left" aria-expanded={pickingCategory}>
                <span aria-hidden>{cats.info(r.set_category_id)?.icon ?? "—"}</span>
                <span className={clsx("flex-1", !r.set_category_id && "text-ink-3")}>{cats.info(r.set_category_id)?.path ?? "Don't change"}</span>
                {r.set_category_id ? (
                  <span
                    role="button"
                    tabIndex={0}
                    className="text-sm font-medium text-ink-3 hover:text-ink"
                    onClick={(e) => {
                      e.stopPropagation();
                      set({ set_category_id: null });
                    }}
                  >
                    Clear
                  </span>
                ) : (
                  <span className="text-sm font-medium text-accent">Choose</span>
                )}
              </button>
              {pickingCategory && (
                <div className="mt-2">
                  <CategoryPicker
                    value={r.set_category_id}
                    onChange={(id) => {
                      set({ set_category_id: id });
                      setPickingCategory(false);
                    }}
                  />
                </div>
              )}
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <Label hint="(optional)">Rename merchant to</Label>
              <input className="field" value={r.set_merchant_name} maxLength={80} onChange={(e) => set({ set_merchant_name: e.target.value })} placeholder="e.g. Landlord" />
            </label>
            <label className="block">
              <Label hint="(comma separated)">Add tags</Label>
              <input className="field" value={r.set_tags} maxLength={200} onChange={(e) => set({ set_tags: e.target.value })} placeholder="e.g. work, trip" />
            </label>
          </div>
          <label className="block">
            <Label hint="(only if the transaction has none)">Add a note</Label>
            <input className="field" value={r.set_note} maxLength={300} onChange={(e) => set({ set_note: e.target.value })} />
          </label>
          <div>
            <Label>Statistics</Label>
            <Segmented
              value={r.set_excluded === null ? "keep" : r.set_excluded ? "out" : "in"}
              onChange={(v) => set({ set_excluded: v === "keep" ? null : v === "out" })}
              options={[
                { value: "keep", label: "Don't change" },
                { value: "out", label: "Leave out" },
                { value: "in", label: "Count" },
              ]}
            />
          </div>
        </fieldset>

        <div className="rounded-2xl border border-line px-4">
          <Toggle
            checked={r.continue_after}
            onChange={(continue_after) => set({ continue_after })}
            label="Keep checking the rules below this one"
            hint="Normally the first matching rule wins. With this on, later rules can still add tags or fill in what this one leaves unchanged."
          />
          <div className="border-t border-line" />
          <Toggle checked={r.enabled} onChange={(enabled) => set({ enabled })} label="Rule is on" />
        </div>
        <ErrorNote error={save.error} />
      </div>
    </Sheet>
  );
}

function ConditionRow({ condition: c, onChange, onRemove }: { condition: Condition; onChange: (c: Condition) => void; onRemove?: () => void }) {
  const accounts = useAccounts();
  const changeField = (field: Field) => {
    if (TEXT_FIELDS.includes(field) && TEXT_FIELDS.includes(c.field)) onChange({ ...(c as Extract<Condition, { value: string }>), field: field as TextField } as Condition);
    else onChange(defaultCondition(field));
  };
  const listToggle = (v: string | number) => {
    const cur = (c.value as (string | number)[]) ?? [];
    onChange({ ...c, value: cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v] } as Condition);
  };
  const isOn = (v: string | number) => ((c.value as (string | number)[]) ?? []).includes(v);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <select className="field min-w-0 flex-1" value={c.field} onChange={(e) => changeField(e.target.value as Field)} aria-label="What to check">
          {["Text", "Money", "Details", "Time"].map((g) => (
            <optgroup key={g} label={g}>
              {FIELDS.filter((f) => f.group === g).map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        {onRemove && (
          <button type="button" onClick={onRemove} className="shrink-0 rounded-full p-2.5 text-ink-3 hover:bg-line hover:text-ink" aria-label="Remove condition">
            <X size={18} />
          </button>
        )}
      </div>

      {TEXT_FIELDS.includes(c.field) && (
        <div className="grid gap-2 sm:grid-cols-[minmax(0,12rem)_1fr]">
          <select className="field" value={c.op} onChange={(e) => onChange({ ...c, op: e.target.value } as Condition)} aria-label="How to compare">
            {TEXT_OPS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <input
            className="field"
            value={c.value as string}
            maxLength={200}
            onChange={(e) => onChange({ ...c, value: e.target.value } as Condition)}
            placeholder={c.op === "regex" ? "e.g. ^BOLT|UBER" : c.field === "message" ? "e.g. Köçürmə" : "e.g. BOLT"}
            aria-label="Text"
          />
        </div>
      )}

      {c.field === "amount" && (
        <div className="grid gap-2 sm:grid-cols-[minmax(0,12rem)_1fr]">
          <select className="field" value={c.op} onChange={(e) => onChange({ ...c, op: e.target.value as NumberOp, value2: e.target.value === "between" ? (c.value2 ?? c.value) : null })} aria-label="How to compare">
            {NUMBER_OPS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <div className="flex items-center gap-2">
            <MoneyInput value={c.value} onChange={(value) => onChange({ ...c, value })} label="Amount" />
            {c.op === "between" && (
              <>
                <span className="text-ink-3">and</span>
                <MoneyInput value={c.value2 ?? 0} onChange={(value2) => onChange({ ...c, value2 })} label="Second amount" />
              </>
            )}
          </div>
        </div>
      )}

      {c.field === "direction" && (
        <Segmented
          value={c.value}
          onChange={(value) => onChange({ ...c, value })}
          options={[
            { value: "out", label: "Money out" },
            { value: "in", label: "Money in" },
          ]}
        />
      )}

      {c.field === "hour" && (
        <div className="flex items-center gap-2 text-sm">
          <span className="text-ink-2">from</span>
          <HourSelect value={c.value} onChange={(value) => onChange({ ...c, value })} label="From hour" />
          <span className="text-ink-2">to</span>
          <HourSelect value={c.value2} onChange={(value2) => onChange({ ...c, value2 })} label="To hour" end />
        </div>
      )}

      {LIST_FIELDS.includes(c.field) && (
        <>
          <Segmented
            value={c.op as "is" | "is_not"}
            onChange={(op) => onChange({ ...c, op } as Condition)}
            options={[
              { value: "is", label: "is one of" },
              { value: "is_not", label: "is none of" },
            ]}
          />
          {c.field === "category" ? (
            <>
              <CategoryMultiPicker value={(c.value as number[]) ?? []} onChange={(value) => onChange({ ...c, value } as Condition)} />
              <p className="text-[13px] text-ink-3">The category the app picked before rules run (from the merchant, built-in list or AI).</p>
            </>
          ) : (
            <div className="flex flex-wrap gap-2">
              {c.field === "account" &&
                accounts.list.map((a) => (
                  <Chip key={a.id} active={isOn(a.id)} onClick={() => listToggle(a.id)}>
                    <span className="mr-1.5 inline-block h-2 w-2 rounded-full" style={{ background: a.color ?? "var(--accent)" }} />
                    {a.name}
                  </Chip>
                ))}
              {c.field === "type" &&
                TX_TYPES.map((t) => (
                  <Chip key={t.value} active={isOn(t.value)} onClick={() => listToggle(t.value)}>
                    {t.label}
                  </Chip>
                ))}
              {c.field === "weekday" &&
                [1, 2, 3, 4, 5, 6, 0].map((d) => (
                  <Chip key={d} active={isOn(d)} onClick={() => listToggle(d)}>
                    {WEEKDAYS[d]}
                  </Chip>
                ))}
              {c.field === "currency" &&
                CURRENCIES.map((cur) => (
                  <Chip key={cur} active={isOn(cur)} onClick={() => listToggle(cur)}>
                    {cur}
                  </Chip>
                ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function MoneyInput({ value, onChange, label }: { value: number; onChange: (v: number) => void; label: string }) {
  const [text, setText] = useState(value ? String(value / 100) : "");
  return (
    <div className="relative min-w-0 flex-1">
      <input
        className="field pr-8"
        inputMode="decimal"
        value={text}
        placeholder="0"
        aria-label={label}
        onChange={(e) => {
          setText(e.target.value);
          onChange(Math.abs(parseAmount(e.target.value) ?? 0));
        }}
      />
      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-3">₼</span>
    </div>
  );
}

function HourSelect({ value, onChange, label, end }: { value: number; onChange: (v: number) => void; label: string; end?: boolean }) {
  return (
    <select className="field w-auto" value={value} onChange={(e) => onChange(Number(e.target.value))} aria-label={label}>
      {Array.from({ length: 24 }, (_, h) => (
        <option key={h} value={h}>
          {String(h).padStart(2, "0")}:{end ? "59" : "00"}
        </option>
      ))}
    </select>
  );
}
