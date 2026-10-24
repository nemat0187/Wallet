import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Search, Plus, ChevronRight } from "lucide-react";
import type { Merchant, Rule } from "@shared/types";
import { formatMoney, parseAmount } from "@shared/money";
import { del, get, patch, post } from "../lib/api";
import { useAccounts, useCategories, useRefresh } from "../lib/data";
import { Button, Empty, ErrorNote, Label, Segmented, Sheet, Spinner, Toggle, clsx, errorText, useToast } from "../lib/ui";
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

function describeRule(r: Rule, catName: (id: number | null) => string | undefined): string {
  const field = r.match_field === "merchant" ? "merchant" : r.match_field === "description" ? "description" : "text";
  const how = { contains: "contains", equals: "is", starts_with: "starts with", regex: "matches" }[r.match_type];
  const parts = [`If ${field} ${how} “${r.pattern}”`];
  if (r.direction) parts.push(r.direction === "out" ? "money out" : "money in");
  if (r.min_amount) parts.push(`≥ ${formatMoney(r.min_amount)}`);
  if (r.max_amount) parts.push(`≤ ${formatMoney(r.max_amount)}`);
  const actions = [];
  if (r.set_category_id) actions.push(catName(r.set_category_id));
  if (r.set_kind) actions.push(`mark as ${r.set_kind}`);
  if (r.set_merchant_name) actions.push(`rename to “${r.set_merchant_name}”`);
  if (r.set_excluded) actions.push("leave out of statistics");
  return `${parts.join(", ")} → ${actions.join(", ")}`;
}

function RuleList() {
  const cats = useCategories();
  const list = useQuery({ queryKey: ["rules"], queryFn: () => get<Rule[]>("/rules") });
  const [editing, setEditing] = useState<Partial<Rule> | null>(null);
  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <p className="max-w-prose text-sm text-ink-2">
          Rules run before anything else. Use them for things the app can't guess, e.g. card transfers to your landlord → Rent.
        </p>
        <Button size="sm" variant="primary" onClick={() => setEditing({ match_field: "any", match_type: "contains", priority: 100, enabled: 1 })}>
          <Plus size={16} /> New rule
        </Button>
      </div>
      <div className="mt-4">
        {!list.data ? (
          <Spinner />
        ) : list.data.length === 0 ? (
          <Empty title="No rules yet">Most of the time you won't need any: correcting a transaction's category already teaches the app.</Empty>
        ) : (
          <ul className="divide-y divide-line rounded-2xl border border-line bg-surface">
            {list.data.map((r) => (
              <li key={r.id}>
                <button onClick={() => setEditing(r)} className={clsx("flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-2", !r.enabled && "opacity-50")}>
                  <span className="min-w-0 flex-1">
                    {r.name && <span className="block font-medium">{r.name}</span>}
                    <span className="block text-sm text-ink-2">{describeRule(r, (id) => cats.info(id)?.path)}</span>
                  </span>
                  <span className="text-[12px] text-ink-3">{r.hits} uses</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <Sheet open={Boolean(editing)} onClose={() => setEditing(null)} title={editing?.id ? "Edit rule" : "New rule"} wide>
        {editing && <RuleForm key={editing.id ?? "new"} rule={editing} onClose={() => setEditing(null)} />}
      </Sheet>
    </div>
  );
}

function RuleForm({ rule, onClose }: { rule: Partial<Rule>; onClose: () => void }) {
  const refresh = useRefresh();
  const toast = useToast();
  const accounts = useAccounts();
  const [r, setR] = useState<Partial<Rule>>(rule);
  const [minText, setMinText] = useState(rule.min_amount ? String(rule.min_amount / 100) : "");
  const [maxText, setMaxText] = useState(rule.max_amount ? String(rule.max_amount / 100) : "");
  const set = <K extends keyof Rule>(k: K, v: Rule[K] | null) => setR((x) => ({ ...x, [k]: v }));
  const body = () => ({
    name: r.name || null,
    match_field: r.match_field,
    match_type: r.match_type,
    pattern: r.pattern ?? "",
    direction: r.direction ?? null,
    min_amount: minText ? parseAmount(minText) : null,
    max_amount: maxText ? parseAmount(maxText) : null,
    account_id: r.account_id ?? null,
    set_category_id: r.set_category_id ?? null,
    set_kind: r.set_kind ?? null,
    set_merchant_name: r.set_merchant_name || null,
    set_excluded: r.set_excluded ? true : null,
    priority: r.priority ?? 100,
    enabled: r.enabled !== 0,
  });
  const save = useMutation({
    mutationFn: async (applyNow: boolean) => {
      const res = r.id ? (await patch(`/rules/${r.id}`, body()), { id: r.id }) : await post<{ id: number }>("/rules", body());
      if (applyNow) return post<{ matched: number }>(`/rules/${res.id}/apply`);
      return { matched: -1 };
    },
    onSuccess: (res) => {
      toast(res.matched >= 0 ? `Rule saved and applied to ${res.matched} transactions` : "Rule saved");
      refresh();
      onClose();
    },
  });
  const preview = useMutation({
    mutationFn: async () => {
      if (!r.id) throw new Error("Save the rule first to preview it");
      return post<{ matched: number }>(`/rules/${r.id}/apply?dry=1`);
    },
    onSuccess: (res) => toast(`${res.matched} existing transactions match`),
    onError: (e) => toast(errorText(e), "error"),
  });
  const remove = useMutation({
    mutationFn: () => del(`/rules/${r.id}`),
    onSuccess: () => {
      toast("Rule deleted");
      refresh();
      onClose();
    },
  });

  return (
    <div className="flex flex-col gap-4">
      <label className="block">
        <Label hint="(optional)">Name</Label>
        <input className="field" value={r.name ?? ""} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Rent to landlord" />
      </label>
      <fieldset className="rounded-2xl border border-line p-4">
        <legend className="px-1 text-sm font-medium text-ink-2">When a transaction…</legend>
        <div className="grid gap-3 sm:grid-cols-[1fr_1fr_2fr]">
          <select className="field" value={r.match_field} onChange={(e) => set("match_field", e.target.value as Rule["match_field"])} aria-label="Field">
            <option value="any">text</option>
            <option value="merchant">merchant</option>
            <option value="description">description</option>
          </select>
          <select className="field" value={r.match_type} onChange={(e) => set("match_type", e.target.value as Rule["match_type"])} aria-label="Match type">
            <option value="contains">contains</option>
            <option value="equals">is exactly</option>
            <option value="starts_with">starts with</option>
            <option value="regex">matches pattern (regex)</option>
          </select>
          <input className="field" value={r.pattern ?? ""} onChange={(e) => set("pattern", e.target.value)} placeholder="e.g. BOLT" aria-label="Text to match" />
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-4">
          <select className="field" value={r.direction ?? ""} onChange={(e) => set("direction", (e.target.value || null) as Rule["direction"])} aria-label="Direction">
            <option value="">in or out</option>
            <option value="out">money out</option>
            <option value="in">money in</option>
          </select>
          <input className="field" inputMode="decimal" value={minText} onChange={(e) => setMinText(e.target.value)} placeholder="min ₼" aria-label="Minimum amount" />
          <input className="field" inputMode="decimal" value={maxText} onChange={(e) => setMaxText(e.target.value)} placeholder="max ₼" aria-label="Maximum amount" />
          <select className="field" value={r.account_id ?? ""} onChange={(e) => set("account_id", e.target.value ? Number(e.target.value) : null)} aria-label="Card">
            <option value="">any card</option>
            {accounts.active.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
      </fieldset>
      <fieldset className="rounded-2xl border border-line p-4">
        <legend className="px-1 text-sm font-medium text-ink-2">…then</legend>
        <Label>Set category</Label>
        <CategoryPicker value={r.set_category_id ?? null} onChange={(id) => set("set_category_id", id)} />
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <select className="field" value={r.set_kind ?? ""} onChange={(e) => set("set_kind", (e.target.value || null) as Rule["set_kind"])} aria-label="Type">
            <option value="">keep type</option>
            <option value="expense">mark as expense</option>
            <option value="income">mark as income</option>
            <option value="transfer">mark as transfer</option>
          </select>
          <input className="field" value={r.set_merchant_name ?? ""} onChange={(e) => set("set_merchant_name", e.target.value)} placeholder="rename merchant to… (optional)" />
        </div>
        <Toggle checked={Boolean(r.set_excluded)} onChange={(v) => set("set_excluded", v ? 1 : null)} label="Leave out of statistics" />
      </fieldset>
      <Toggle checked={r.enabled !== 0} onChange={(v) => set("enabled", v ? 1 : 0)} label="Rule is active" />
      <ErrorNote error={save.error ?? remove.error} />
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" loading={save.isPending && save.variables === true} onClick={() => save.mutate(true)}>
          Save and apply to past transactions
        </Button>
        <Button loading={save.isPending && save.variables === false} onClick={() => save.mutate(false)}>
          Save for new ones only
        </Button>
        {r.id && (
          <>
            <Button variant="ghost" loading={preview.isPending} onClick={() => preview.mutate()}>
              Preview matches
            </Button>
            <Button variant="danger" loading={remove.isPending} onClick={() => window.confirm("Delete this rule?") && remove.mutate()}>
              Delete
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
