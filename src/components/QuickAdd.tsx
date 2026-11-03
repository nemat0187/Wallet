import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { formatMoney, parseAmount, localDate } from "@shared/money";
import { get, post } from "../lib/api";
import { useAccounts, useBootstrap, useCategories, useRefresh } from "../lib/data";
import { Button, ErrorNote, Label, Segmented, Sheet, useToast } from "../lib/ui";
import { CategoryPicker } from "./CategoryPicker";
import { CategoryIcon } from "./Transactions";

const CURRENCIES = ["AZN", "USD", "EUR", "GBP", "RUB", "TRY", "GEL", "AED"];
interface RatesResponse {
  rates: { currency: string; rate: number; approximate: boolean }[];
}

/** Add a cash expense (or any manual transaction). */
export function QuickAdd({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Sheet open={open} onClose={onClose} title="Add a transaction">
      {open && <Form onDone={onClose} />}
    </Sheet>
  );
}

function Form({ onDone }: { onDone: () => void }) {
  const { data } = useBootstrap();
  const accounts = useAccounts();
  const cats = useCategories();
  const refresh = useRefresh();
  const toast = useToast();
  const tz = data?.settings.tz_offset_minutes ?? 240;
  const cash = accounts.active.find((a) => a.type === "cash");
  const [direction, setDirection] = useState<"out" | "in">("out");
  const [amount, setAmount] = useState("");
  const [merchant, setMerchant] = useState("");
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [picking, setPicking] = useState(false);
  const [accountId, setAccountId] = useState<number | null>(cash?.id ?? accounts.active[0]?.id ?? null);
  const [date, setDate] = useState(localDate(new Date(), tz));
  const [note, setNote] = useState("");
  const [currencyChoice, setCurrencyChoice] = useState<string | null>(null);
  const account = accounts.active.find((a) => a.id === accountId);
  const currency = currencyChoice ?? account?.currency ?? "AZN";
  const rates = useQuery({ queryKey: ["rates"], queryFn: () => get<RatesResponse>("/rates"), staleTime: 300_000, enabled: currency !== "AZN" });
  const rate = rates.data?.rates.find((r) => r.currency === currency);
  const entered = parseAmount(amount);

  const save = useMutation({
    mutationFn: () => {
      const minor = parseAmount(amount);
      if (!minor || minor <= 0) throw new Error("Enter an amount, for example 12.50");
      const now = new Date(Date.now() + tz * 60_000);
      const time = date === localDate(new Date(), tz) ? `${String(now.getUTCHours()).padStart(2, "0")}:${String(now.getUTCMinutes()).padStart(2, "0")}` : undefined;
      return post("/transactions", {
        account_id: accountId,
        date,
        time,
        amount: minor,
        currency,
        direction,
        merchant: merchant.trim() || null,
        category_id: categoryId,
        note: note.trim() || null,
      });
    },
    onSuccess: () => {
      toast(direction === "out" ? "Expense added" : "Income added");
      refresh();
      onDone();
    },
  });

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <Segmented
        value={direction}
        onChange={(v) => {
          setDirection(v);
          setCategoryId(null);
        }}
        options={[
          { value: "out", label: "Expense" },
          { value: "in", label: "Income" },
        ]}
        className="self-start"
      />
      <label className="block">
        <Label>Amount</Label>
        <div className="relative">
          <input
            inputMode="decimal"
            autoComplete="off"
            className="field h-16 pr-24 text-3xl font-semibold num"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <select
            className="absolute right-2 top-1/2 h-10 -translate-y-1/2 rounded-lg border border-line bg-surface-2 px-2 text-base font-medium"
            value={currency}
            onChange={(e) => setCurrencyChoice(e.target.value)}
            aria-label="Currency"
          >
            {[...new Set([currency, ...CURRENCIES])].map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        {currency !== "AZN" && entered && rate && (
          <p className="mt-1.5 text-[13px] text-ink-3">
            ≈ <span className="num">{formatMoney(Math.round(entered * rate.rate))}</span> at today's rate (1 {currency} = {rate.rate.toFixed(4)} ₼
            {rate.approximate ? ", approximate" : ""}).
            {account && account.currency !== currency && ` It will be saved in ${account.currency} for ${account.name}.`}
          </p>
        )}
      </label>
      <label className="block">
        <Label>{direction === "out" ? "What was it?" : "From"}</Label>
        <input
          className="field"
          value={merchant}
          onChange={(e) => setMerchant(e.target.value)}
          placeholder={direction === "out" ? "e.g. Taxi, Bazaar, Lunch" : "e.g. Salary, Gift"}
        />
      </label>
      <div>
        <Label hint="(leave empty to categorize automatically)">Category</Label>
        <button type="button" className="field flex items-center gap-3 text-left" onClick={() => setPicking((p) => !p)} aria-expanded={picking}>
          {categoryId ? <CategoryIcon id={categoryId} size={28} /> : <span className="w-7 text-center">✨</span>}
          <span className="flex-1">{cats.info(categoryId)?.path ?? "Automatic"}</span>
          <span className="text-sm font-medium text-accent">{picking ? "Close" : "Choose"}</span>
        </button>
        {picking && (
          <div className="mt-2">
            <CategoryPicker
              value={categoryId}
              kinds={direction === "out" ? ["expense", "transfer"] : ["income", "transfer"]}
              onChange={(id) => {
                setCategoryId(id);
                setPicking(false);
              }}
            />
          </div>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <Label>Paid with</Label>
          <select className="field" value={accountId ?? ""} onChange={(e) => setAccountId(e.target.value ? Number(e.target.value) : null)}>
            {accounts.active.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <Label>Date</Label>
          <input type="date" className="field" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
      </div>
      <label className="block">
        <Label>Note</Label>
        <input className="field" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" />
      </label>
      <ErrorNote error={save.error} />
      <Button type="submit" variant="primary" loading={save.isPending}>
        {direction === "out" ? "Add expense" : "Add income"}
      </Button>
    </form>
  );
}
