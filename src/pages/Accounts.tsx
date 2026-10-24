import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Plus, ChevronRight } from "lucide-react";
import type { Account } from "@shared/types";
import { formatMoney, parseAmount } from "@shared/money";
import { del, get, patch, post } from "../lib/api";
import { useRefresh } from "../lib/data";
import { Button, Empty, ErrorNote, Label, Sheet, Spinner, Toggle, clsx, useToast } from "../lib/ui";
import { PageHeader } from "../components/Layout";

type Row = Account & { tx_count: number; last_tx: string | null };
const COLORS = ["#2563eb", "#7c3aed", "#0d9488", "#ea580c", "#db2777", "#16a34a", "#475569"];

export default function Accounts() {
  const q = useQuery({ queryKey: ["accounts-full"], queryFn: () => get<Row[]>("/accounts") });
  const [editing, setEditing] = useState<Partial<Row> | null>(null);
  if (!q.data) return <Spinner />;
  const total = q.data.filter((a) => !a.archived && a.include_in_totals && a.currency === "AZN").reduce((s, a) => s + (a.balance ?? 0), 0);

  return (
    <div>
      <PageHeader
        title="Cards & accounts"
        subtitle={`Total balance ${formatMoney(total)}`}
        actions={
          <Button size="sm" variant="primary" onClick={() => setEditing({ type: "cash", currency: "AZN", color: COLORS[5], include_in_totals: 1 })}>
            <Plus size={16} /> Add
          </Button>
        }
      />
      <p className="mt-2 max-w-prose text-sm text-ink-2">
        Your ABB cards are added automatically the first time a message for them arrives (matched by the last four digits). Balances update from each message.
      </p>
      <div className="mt-5">
        {q.data.length === 0 ? (
          <Empty title="No accounts yet" />
        ) : (
          <ul className="divide-y divide-line rounded-2xl border border-line bg-surface">
            {q.data.map((a) => (
              <li key={a.id}>
                <button onClick={() => setEditing(a)} className={clsx("flex w-full items-center gap-3 px-4 py-3.5 text-left hover:bg-surface-2", a.archived && "opacity-50")}>
                  <span className="h-9 w-1.5 rounded-full" style={{ background: a.color ?? "var(--accent)" }} aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{a.name}</span>
                    <span className="block text-[13px] text-ink-3">
                      {a.type === "card" ? `Card${a.card_last4 ? ` ending ${a.card_last4}` : ""}` : a.type === "cash" ? "Cash" : a.type === "savings" ? "Savings" : "Other"}
                      {` · ${a.tx_count} transactions`}
                      {a.archived ? " · hidden" : ""}
                    </span>
                  </span>
                  <span className="text-right">
                    <span className="num block font-semibold">{a.balance !== null ? formatMoney(a.balance, a.currency) : "—"}</span>
                    {a.balance_at && <span className="block text-[12px] text-ink-3">{a.balance_at.slice(0, 10)}</span>}
                  </span>
                  <ChevronRight size={16} className="text-ink-3" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <Sheet open={Boolean(editing)} onClose={() => setEditing(null)} title={editing?.id ? "Edit account" : "New account"}>
        {editing && <AccountForm key={editing.id ?? "new"} a={editing} all={q.data} onClose={() => setEditing(null)} />}
      </Sheet>
    </div>
  );
}

function AccountForm({ a, all, onClose }: { a: Partial<Row>; all: Row[]; onClose: () => void }) {
  const refresh = useRefresh();
  const toast = useToast();
  const [name, setName] = useState(a.name ?? "");
  const [type, setType] = useState<Account["type"]>(a.type ?? "card");
  const [last4, setLast4] = useState(a.card_last4 ?? "");
  const [currency, setCurrency] = useState(a.currency ?? "AZN");
  const [color, setColor] = useState(a.color ?? COLORS[0]);
  const [balance, setBalance] = useState(a.balance !== null && a.balance !== undefined ? String(a.balance / 100) : "");
  const [include, setInclude] = useState(a.include_in_totals !== 0);
  const [archived, setArchived] = useState(Boolean(a.archived));
  const [mergeInto, setMergeInto] = useState<number | "">("");

  const save = useMutation({
    mutationFn: () => {
      if (!name.trim()) throw new Error("Give the account a name");
      if (last4 && !/^\d{4}$/.test(last4)) throw new Error("Card ending must be 4 digits");
      const body: Record<string, unknown> = {
        name: name.trim(),
        type,
        card_last4: type === "card" && last4 ? last4 : null,
        currency,
        color,
        include_in_totals: include,
        archived,
      };
      const parsed = balance.trim() ? parseAmount(balance) : null;
      const original = a.balance ?? null;
      if (parsed !== original) body.balance = parsed;
      return a.id ? patch(`/accounts/${a.id}`, body) : post("/accounts", body);
    },
    onSuccess: () => {
      toast("Account saved");
      refresh();
      onClose();
    },
  });
  const merge = useMutation({
    mutationFn: () => post(`/accounts/${a.id}/merge-into/${mergeInto}`),
    onSuccess: () => {
      toast("Accounts merged");
      refresh();
      onClose();
    },
  });
  const remove = useMutation({
    mutationFn: () => del<{ archived: boolean }>(`/accounts/${a.id}`),
    onSuccess: (r) => {
      toast(r.archived ? "Account hidden (it has transactions)" : "Account deleted");
      refresh();
      onClose();
    },
  });

  return (
    <div className="flex flex-col gap-4">
      <label className="block">
        <Label>Name</Label>
        <input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. ABB salary card" />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <Label>Type</Label>
          <select className="field" value={type} onChange={(e) => setType(e.target.value as Account["type"])}>
            <option value="card">Card</option>
            <option value="cash">Cash</option>
            <option value="savings">Savings</option>
            <option value="other">Other</option>
          </select>
        </label>
        <label className="block">
          <Label>Currency</Label>
          <select className="field" value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {["AZN", "USD", "EUR", "GBP", "RUB", "TRY"].map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
      </div>
      {type === "card" && (
        <label className="block">
          <Label hint="(how messages are matched to this card)">Card ends with</Label>
          <input className="field num" inputMode="numeric" maxLength={4} value={last4} onChange={(e) => setLast4(e.target.value.replace(/\D/g, ""))} placeholder="1234" />
        </label>
      )}
      <label className="block">
        <Label hint="(updates automatically from bank messages)">Current balance</Label>
        <input className="field num" inputMode="decimal" value={balance} onChange={(e) => setBalance(e.target.value)} placeholder="0.00" />
      </label>
      <div>
        <Label>Colour</Label>
        <div className="flex gap-2">
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setColor(c)}
              className={clsx("h-8 w-8 rounded-full", color === c && "ring-2 ring-ink ring-offset-2 ring-offset-surface")}
              style={{ background: c }}
              aria-label={`Colour ${c}`}
            />
          ))}
        </div>
      </div>
      <Toggle checked={include} onChange={setInclude} label="Count in total balance" />
      {a.id && <Toggle checked={archived} onChange={setArchived} label="Hide this account" />}
      <ErrorNote error={save.error ?? merge.error ?? remove.error} />
      <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
        Save account
      </Button>
      {a.id && (
        <div className="flex flex-col gap-3 border-t border-line pt-4">
          <Label>Merge into another account</Label>
          <div className="flex gap-2">
            <select className="field" value={mergeInto} onChange={(e) => setMergeInto(e.target.value ? Number(e.target.value) : "")}>
              <option value="">Choose…</option>
              {all
                .filter((x) => x.id !== a.id)
                .map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
            </select>
            <Button disabled={!mergeInto} loading={merge.isPending} onClick={() => window.confirm("Move all transactions and delete this account?") && merge.mutate()}>
              Merge
            </Button>
          </div>
          <Button variant="danger" loading={remove.isPending} onClick={() => window.confirm("Delete this account?") && remove.mutate()}>
            Delete account
          </Button>
        </div>
      )}
    </div>
  );
}
