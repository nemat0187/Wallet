// Savings goals on the Budgets page: a target, what is saved so far, an optional deadline.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PiggyBank, Plus } from "lucide-react";
import { goalProgress, type Goal } from "@shared/goals";
import { formatDay, formatMoney, localDate, parseAmount } from "@shared/money";
import { del, get, post, put } from "../lib/api";
import { useBootstrap } from "../lib/data";
import { Button, ErrorNote, Label, Sheet, useToast } from "../lib/ui";
import { Meter } from "./charts";

const money = (v: number) => formatMoney(v, "AZN", { decimals: v < 100000 });

export function GoalsSection() {
  const qc = useQueryClient();
  const toast = useToast();
  const settings = useBootstrap().data?.settings;
  const today = localDate(new Date(), settings?.tz_offset_minutes ?? 240);
  const goals = useQuery({ queryKey: ["goals"], queryFn: () => get<Goal[]>("/goals") });
  const [editing, setEditing] = useState<Goal | "new" | null>(null);
  const [adding, setAdding] = useState<{ id: number; value: string } | null>(null);
  const done = () => qc.invalidateQueries({ queryKey: ["goals"] });
  const contribute = useMutation({
    mutationFn: ({ id, amount }: { id: number; amount: number }) => post(`/goals/${id}/contribute`, { amount }),
    onSuccess: () => {
      setAdding(null);
      done();
    },
    onError: (e) => toast(e instanceof Error ? e.message : "Could not save", "error"),
  });
  const list = goals.data ?? [];

  return (
    <>
      <div className="mb-3 mt-8 flex items-end justify-between gap-3 px-1">
        <h2 className="flex items-center gap-2 text-[17px] font-semibold tracking-tight">
          <PiggyBank size={18} className="text-accent" aria-hidden /> Savings goals
        </h2>
        <Button size="sm" onClick={() => setEditing("new")}>
          <Plus size={16} /> Add
        </Button>
      </div>
      {list.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-line px-4 py-5 text-sm text-ink-2">
          Saving for something, like a trip, a laptop or an emergency fund? Add a goal, put money aside as you go and see how much to save each month.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-line rounded-2xl border border-line bg-surface">
          {list.map((g) => {
            const p = goalProgress(g, today);
            return (
              <li key={g.id} className="px-4 py-3.5">
                <button className="block w-full text-left" onClick={() => setEditing(g)}>
                  <span className="mb-2 flex items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate font-medium">{g.name}</span>
                    <span className="num shrink-0 text-right">
                      <span className="font-semibold">{money(g.saved)}</span>
                      <span className="text-ink-3"> / {money(g.target)}</span>
                    </span>
                  </span>
                  <Meter spent={g.saved} amount={g.target} status="ok" paceFraction={null} />
                </button>
                <p className="mt-1.5 text-[13px] text-ink-3">
                  {p.done
                    ? "Goal reached 🎉"
                    : p.days_left === null
                      ? `${p.pct}% · ${money(p.remaining)} to go`
                      : p.days_left < 0
                        ? `${p.pct}% · deadline ${formatDay(g.deadline!)} has passed · ${money(p.remaining)} to go`
                        : `${p.pct}% · by ${formatDay(g.deadline!)} · save about ${money(p.monthly ?? 0)} a month`}
                </p>
                {adding?.id === g.id ? (
                  <form
                    className="mt-2 flex gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const minor = parseAmount(adding.value);
                      if (minor === null || minor === 0) return toast("Enter an amount like 50 (or -20 to take some back)", "error");
                      contribute.mutate({ id: g.id, amount: minor });
                    }}
                  >
                    <input
                      autoFocus
                      inputMode="decimal"
                      className="field flex-1"
                      placeholder="Amount to put aside"
                      value={adding.value}
                      onChange={(e) => setAdding({ id: g.id, value: e.target.value })}
                    />
                    <Button type="submit" size="sm" variant="primary" loading={contribute.isPending}>
                      Save
                    </Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setAdding(null)}>
                      Cancel
                    </Button>
                  </form>
                ) : (
                  <Button className="mt-2" size="sm" variant="secondary" onClick={() => setAdding({ id: g.id, value: "" })}>
                    Add money
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <Sheet open={Boolean(editing)} onClose={() => setEditing(null)} title={editing && editing !== "new" ? "Edit goal" : "New savings goal"}>
        {editing && <GoalForm key={editing === "new" ? "new" : editing.id} goal={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={done} />}
      </Sheet>
    </>
  );
}

function GoalForm({ goal, onClose, onSaved }: { goal: Goal | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(goal?.name ?? "");
  const [target, setTarget] = useState(goal ? String(goal.target / 100) : "");
  const [deadline, setDeadline] = useState(goal?.deadline ?? "");
  const save = useMutation({
    mutationFn: () => {
      const minor = parseAmount(target || "0");
      if (!name.trim()) throw new Error("Give the goal a name");
      if (!minor || minor <= 0) throw new Error("Enter a target like 2000");
      const body = { name: name.trim(), target: minor, deadline: deadline || null };
      return goal ? put(`/goals/${goal.id}`, body) : post("/goals", body);
    },
    onSuccess: () => {
      toast("Goal saved");
      onSaved();
      onClose();
    },
  });
  const remove = useMutation({
    mutationFn: () => del(`/goals/${goal!.id}`),
    onSuccess: () => {
      toast("Goal removed");
      onSaved();
      onClose();
    },
  });
  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <label className="block">
        <Label>What are you saving for?</Label>
        <input className="field" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="e.g. Holiday in Turkey" />
      </label>
      <label className="block">
        <Label>Target amount</Label>
        <div className="relative">
          <input inputMode="decimal" className="field h-14 pr-10 text-2xl font-semibold num" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="0" />
          <span className="absolute right-4 top-1/2 -translate-y-1/2 text-xl text-ink-3">₼</span>
        </div>
      </label>
      <label className="block">
        <Label hint="(optional)">Deadline</Label>
        <input type="date" className="field" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
      </label>
      <ErrorNote error={save.error ?? remove.error} />
      <div className="flex gap-2">
        <Button type="submit" variant="primary" className="flex-1" loading={save.isPending}>
          Save goal
        </Button>
        {goal && (
          <Button type="button" variant="danger" loading={remove.isPending} onClick={() => window.confirm("Remove this goal?") && remove.mutate()}>
            Remove
          </Button>
        )}
      </div>
    </form>
  );
}
