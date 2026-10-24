import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Search, Plus, ChevronRight, ChevronUp, ChevronDown } from "lucide-react";
import type { Merchant, Rule } from "@shared/types";
import { formatMoney } from "@shared/money";
import { get, patch, post } from "../lib/api";
import { useAccounts, useCategories, useRefresh } from "../lib/data";
import { Button, Empty, ErrorNote, Label, Segmented, Sheet, Spinner, Toggle, clsx, errorText, useToast } from "../lib/ui";
import { RuleEditor, describeActions, describeConditions, draftFromRule, emptyRule, type RuleDraft } from "../components/RuleEditor";
import { PageHeader } from "../components/Layout";
import { CategoryPicker } from "../components/CategoryPicker";
import { CategoryIcon } from "../components/Transactions";

export default function Merchants() {
  const [tab, setTab] = useState<"merchants" | "rules">("merchants");
  return (
    <div>
      <PageHeader title="Merchants & rules" subtitle="The app remembers each merchant's category. Rules handle the special cases." />
      <Segmented
        className="mt-4"
        value={tab}
        onChange={setTab}
        options={[
          { value: "merchants", label: "Merchants" },
          { value: "rules", label: "Rules" },
        ]}
      />
      <div className="mt-5">{tab === "merchants" ? <MerchantList /> : <RuleList />}</div>
    </div>
  );
}

const SOURCE: Record<string, string> = { user: "set by you", ai: "AI", builtin: "built-in", rule: "rule", ai_failed: "AI unsure" };

function MerchantList() {
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const cats = useCategories();
  const list = useQuery({ queryKey: ["merchants", search], queryFn: () => get<Merchant[]>(`/merchants${search ? `?q=${encodeURIComponent(search)}` : ""}`), placeholderData: (p) => p });
  const [editing, setEditing] = useState<Merchant | null>(null);
  return (
    <div>
      <form
        className="relative"
        onSubmit={(e) => {
          e.preventDefault();
          setSearch(q.trim());
        }}
      >
        <Search size={18} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-3" aria-hidden />
        <input className="field pl-10" placeholder="Search merchants" value={q} onChange={(e) => setQ(e.target.value)} onBlur={() => setSearch(q.trim())} aria-label="Search merchants" />
      </form>
      <div className="mt-4">
        {!list.data ? (
          <Spinner />
        ) : list.data.length === 0 ? (
          <Empty title="No merchants yet">Merchants appear automatically as transactions come in.</Empty>
        ) : (
          <ul className="divide-y divide-line rounded-2xl border border-line bg-surface">
            {list.data.map((m) => (
              <li key={m.id}>
                <button onClick={() => setEditing(m)} className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-surface-2">
                  <CategoryIcon id={m.category_id} size={36} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{m.name}</span>
                    <span className="block truncate text-[13px] text-ink-3">
                      {cats.info(m.category_id)?.path ?? "Not categorized yet"}
                      {m.category_source ? ` · ${SOURCE[m.category_source] ?? m.category_source}` : ""}
                    </span>
                  </span>
                  <span className="text-right">
                    <span className="num block text-sm font-medium">{formatMoney(m.total_spent ?? 0, "AZN", { decimals: false })}</span>
                    <span className="block text-[12px] text-ink-3">{m.tx_count}×</span>
                  </span>
                  <ChevronRight size={16} className="text-ink-3" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <Sheet open={Boolean(editing)} onClose={() => setEditing(null)} title="Merchant">
        {editing && <MerchantForm key={editing.id} m={editing} onClose={() => setEditing(null)} />}
      </Sheet>
    </div>
  );
}

function MerchantForm({ m, onClose }: { m: Merchant; onClose: () => void }) {
  const refresh = useRefresh();
  const toast = useToast();
  const [name, setName] = useState(m.name);
  const [categoryId, setCategoryId] = useState<number | null>(m.category_id);
  const [applyPast, setApplyPast] = useState(true);
  const save = useMutation({
    mutationFn: () =>
      patch<{ applied: number }>(`/merchants/${m.id}`, {
        name: name.trim() !== m.name ? name.trim() : undefined,
        category_id: categoryId !== m.category_id && categoryId ? categoryId : undefined,
        apply_to_past: applyPast,
      }),
    onSuccess: (r) => {
      toast(r.applied ? `Saved · updated ${r.applied} transactions` : "Saved");
      refresh();
      onClose();
    },
  });
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-ink-3">
        Appears in bank messages as <code className="rounded bg-surface-2 px-1">{m.key}</code>
      </p>
      <label className="block">
        <Label>Display name</Label>
        <input className="field" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <div>
        <Label>Category</Label>
        <CategoryPicker value={categoryId} onChange={setCategoryId} />
      </div>
      {categoryId !== m.category_id && <Toggle checked={applyPast} onChange={setApplyPast} label="Also update past transactions" />}
      <ErrorNote error={save.error} />
      <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
        Save
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------

const EXAMPLES: { title: string; text: string; draft: () => RuleDraft }[] = [
  {
    title: "Rent to my landlord",
    text: "Transfers of exactly 800 ₼ from one card → Rent",
    draft: () => ({ ...emptyRule(), name: "Rent", conditions: [{ field: "type", op: "is", value: ["transfer_out"] }, { field: "amount", op: "eq", value: 80000 }] }),
  },
  {
    title: "Late-night taxis",
    text: "Taxi rides between 23:00 and 05:59 → tag “late night”",
    draft: () => ({
      ...emptyRule(),
      name: "Late-night taxis",
      conditions: [
        { field: "any_text", op: "contains", value: "bolt" },
        { field: "hour", op: "between", value: 23, value2: 5 },
      ],
      set_tags: "late night",
    }),
  },
  {
    title: "Savings card top-ups",
    text: "Money arriving on your savings card → between my cards",
    draft: () => ({ ...emptyRule(), name: "Savings top-ups", conditions: [{ field: "type", op: "is", value: ["transfer_in"] }, { field: "account", op: "is", value: [] }], set_kind: "transfer" }),
  },
];

function RuleList() {
  const cats = useCategories();
  const accounts = useAccounts();
  const qc = useQueryClient();
  const toast = useToast();
  const list = useQuery({ queryKey: ["rules"], queryFn: () => get<Rule[]>("/rules") });
  const [editing, setEditing] = useState<RuleDraft | null>(null);
  const names = {
    account: (id: number) => accounts.byId.get(id)?.name ?? "deleted card",
    category: (id: number) => cats.info(id)?.path ?? "deleted category",
  };
  const toggle = useMutation({
    mutationFn: (r: Rule) => patch(`/rules/${r.id}`, { enabled: !r.enabled }),
    onMutate: (r) => qc.setQueryData<Rule[]>(["rules"], (l) => l?.map((x) => (x.id === r.id ? { ...x, enabled: r.enabled ? 0 : 1 } : x))),
    onError: (e) => {
      toast(errorText(e), "error");
      qc.invalidateQueries({ queryKey: ["rules"] });
    },
  });
  const reorder = useMutation({
    mutationFn: (ids: number[]) => post("/rules/reorder", { ids }),
    onMutate: (ids) => qc.setQueryData<Rule[]>(["rules"], (l) => ids.map((id) => l!.find((r) => r.id === id)!)),
    onSettled: () => qc.invalidateQueries({ queryKey: ["rules"] }),
  });
  const move = (i: number, delta: number) => {
    const ids = (list.data ?? []).map((r) => r.id);
    const [id] = ids.splice(i, 1);
    ids.splice(i + delta, 0, id);
    reorder.mutate(ids);
  };

  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <p className="max-w-prose text-sm text-ink-2">
          Rules run on every new transaction after the app has picked a category, top to bottom. The first rule that matches wins. Combine conditions like text,
          amount, card, type, day and time.
        </p>
        <Button size="sm" variant="primary" className="shrink-0" onClick={() => setEditing(emptyRule())}>
          <Plus size={16} /> New rule
        </Button>
      </div>
      <div className="mt-4">
        {!list.data ? (
          <Spinner />
        ) : list.data.length === 0 ? (
          <div>
            <Empty title="No rules yet">Most of the time you won't need any: correcting a transaction's category already teaches the app. Rules are for the special cases.</Empty>
            <p className="mb-2 px-1 text-sm font-medium text-ink-2">Start from an example</p>
            <div className="grid gap-2 sm:grid-cols-3">
              {EXAMPLES.map((ex) => (
                <button key={ex.title} onClick={() => setEditing(ex.draft())} className="rounded-2xl border border-line bg-surface px-4 py-3 text-left hover:bg-surface-2">
                  <span className="block font-medium">{ex.title}</span>
                  <span className="mt-0.5 block text-sm text-ink-2">{ex.text}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <ol className="divide-y divide-line rounded-2xl border border-line bg-surface">
            {list.data.map((r, i) => {
              const d = draftFromRule(r);
              return (
                <li key={r.id} className={clsx("flex items-center gap-2 py-2 pl-2 pr-3", !r.enabled && "opacity-60")}>
                  <div className="flex shrink-0 flex-col">
                    <button className="rounded p-1 text-ink-3 hover:bg-surface-2 hover:text-ink disabled:opacity-30" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Check earlier">
                      <ChevronUp size={16} />
                    </button>
                    <button
                      className="rounded p-1 text-ink-3 hover:bg-surface-2 hover:text-ink disabled:opacity-30"
                      disabled={i === list.data.length - 1}
                      onClick={() => move(i, 1)}
                      aria-label="Check later"
                    >
                      <ChevronDown size={16} />
                    </button>
                  </div>
                  <button onClick={() => setEditing(d)} className="min-w-0 flex-1 rounded-lg px-1 py-1 text-left hover:bg-surface-2">
                    <span className="block font-medium">{r.name || `Rule ${i + 1}`}</span>
                    <span className="block text-sm text-ink-2">
                      If {describeConditions(d.conditions, d.match_mode, names)} → {describeActions(d, names.category) || "nothing"}
                      {d.continue_after && <span className="text-ink-3"> · then keeps checking</span>}
                    </span>
                    <span className="block text-[12px] text-ink-3">{r.hits} {r.hits === 1 ? "use" : "uses"}</span>
                  </button>
                  <label className="relative inline-flex shrink-0 cursor-pointer" title={r.enabled ? "Turn off" : "Turn on"}>
                    <input type="checkbox" className="peer sr-only" checked={Boolean(r.enabled)} onChange={() => toggle.mutate(r)} aria-label={`${r.name || "Rule"} is on`} />
                    <span className="h-7 w-12 rounded-full border border-line bg-surface-2 transition-colors peer-checked:border-accent peer-checked:bg-accent peer-focus-visible:outline-2 peer-focus-visible:outline-accent" />
                    <span className="absolute left-1 top-1 h-5 w-5 rounded-full bg-white shadow transition-transform peer-checked:translate-x-5" />
                  </label>
                </li>
              );
            })}
          </ol>
        )}
      </div>
      {editing && <RuleEditor key={editing.id ?? "new"} initial={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
