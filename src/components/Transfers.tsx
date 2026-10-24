// Suggested transfers between the owner's own cards. Bank messages only name
// the owner's own card, so the app never decides this by itself: it pairs a
// payment out of one card with the same amount arriving on another and asks.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftRight, ArrowRight, Search } from "lucide-react";
import type { Transaction } from "@shared/types";
import { formatMoney } from "@shared/money";
import { get, post } from "../lib/api";
import { useAccounts, useRefresh } from "../lib/data";
import { Button, Empty, Sheet, Spinner, errorText, useToast } from "../lib/ui";
import { dayLabel } from "./Transactions";

export interface TransferPair {
  out: Transaction;
  in: Transaction;
}

export function useTransferPairs() {
  return useQuery({ queryKey: ["transfer-pairs"], queryFn: () => get<TransferPair[]>("/transactions/transfer-pairs"), staleTime: 30_000 });
}

export function useCardName() {
  const accounts = useAccounts();
  return (id: number | null) => {
    const a = id ? accounts.byId.get(id) : null;
    return a ? a.name.replace(/^ABB card /, "card ") : "no card";
  };
}

function time(iso: string, tz = 240) {
  const d = new Date(Date.parse(iso) + tz * 60_000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/** Tag or dismiss suggested pairs. */
export function usePairActions() {
  const refresh = useRefresh();
  const toast = useToast();
  const qc = useQueryClient();
  const mark = useMutation({
    mutationFn: (ids: number[]) => post("/transactions/bulk", { ids, kind: "transfer" }),
    onSuccess: (_r, ids) => {
      toast(ids.length > 2 ? `Marked ${ids.length / 2} transfers between your cards` : "Marked as a transfer between your cards");
      refresh();
    },
    onError: (e) => toast(errorText(e), "error"),
  });
  const dismiss = useMutation({
    mutationFn: (id: number) => post(`/transactions/${id}/unpair`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["transfer-pairs"] });
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["tx"] });
    },
    onError: (e) => toast(errorText(e), "error"),
  });
  return { mark, dismiss };
}

/** "3 possible transfers between your cards — Review". Renders nothing when there are none. */
export function TransferPairsBanner({ className }: { className?: string }) {
  const pairs = useTransferPairs();
  const [open, setOpen] = useState(false);
  const n = pairs.data?.length ?? 0;
  return (
    <>
      {n > 0 && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={`flex w-full items-center gap-3 rounded-2xl bg-accent-soft px-4 py-3 text-left hover:brightness-[0.98] ${className ?? ""}`}
        >
          <ArrowLeftRight size={18} className="shrink-0 text-accent" aria-hidden />
          <span className="flex-1 text-sm">
            <strong className="font-semibold">{n}</strong> {n === 1 ? "pair looks" : "pairs look"} like money moved between your own cards. They count as spending
            and income until you confirm.
          </span>
          <span className="text-sm font-medium text-accent">Review</span>
        </button>
      )}
      <TransferPairsSheet open={open} onClose={() => setOpen(false)} />
    </>
  );
}

export function TransferPairsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const pairs = useTransferPairs();
  const { mark, dismiss } = usePairActions();
  const toast = useToast();
  const qc = useQueryClient();
  const scan = useMutation({
    mutationFn: () => post<{ found: number }>("/transactions/transfer-pairs/scan"),
    onSuccess: (r) => {
      toast(r.found ? `Found ${r.found} new ${r.found === 1 ? "pair" : "pairs"}` : "No new pairs found");
      qc.invalidateQueries({ queryKey: ["transfer-pairs"] });
      qc.invalidateQueries({ queryKey: ["transactions"] });
    },
    onError: (e) => toast(errorText(e), "error"),
  });
  const list = pairs.data ?? [];
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Transfers between your cards?"
      wide
      footer={
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" loading={scan.isPending} onClick={() => scan.mutate()}>
            <Search size={16} /> Search my history again
          </Button>
          {list.length > 1 && (
            <Button variant="primary" className="ml-auto" loading={mark.isPending} onClick={() => mark.mutate(list.flatMap((p) => [p.out.id, p.in.id]))}>
              All are mine
            </Button>
          )}
        </div>
      }
    >
      <p className="text-sm text-ink-2">
        ABB's messages only show your own card, so the app can't know where money went. These are the same amount leaving one of your cards and arriving on another
        within a few minutes. Confirm the ones that were really between your cards and they stop counting as spending, income and against budgets.
      </p>
      {pairs.isLoading ? (
        <Spinner />
      ) : list.length === 0 ? (
        <Empty title="Nothing to review">When the same amount leaves one card and arrives on another, it shows up here.</Empty>
      ) : (
        <ul className="mt-4 flex flex-col gap-3">
          {list.map((p) => (
            <li key={p.out.id} className="rounded-2xl border border-line p-3">
              <PairSummary out={p.out} into={p.in} />
              <div className="mt-3 flex gap-2">
                <Button size="sm" variant="primary" className="flex-1" disabled={mark.isPending} onClick={() => mark.mutate([p.out.id, p.in.id])}>
                  Yes, my transfer
                </Button>
                <Button size="sm" className="flex-1" disabled={dismiss.isPending} onClick={() => dismiss.mutate(p.out.id)}>
                  Not a transfer
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  );
}

export function PairSummary({ out, into, tz = 240 }: { out: Transaction; into: Transaction; tz?: number }) {
  const card = useCardName();
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{card(out.account_id)}</span>
        <span className="num block text-ink-2">{formatMoney(out.amount, out.currency)}</span>
      </span>
      <ArrowRight size={16} className="shrink-0 text-ink-3" aria-hidden />
      <span className="min-w-0 flex-1 text-right">
        <span className="block truncate font-medium">{card(into.account_id)}</span>
        <span className="num block text-good">{formatMoney(into.amount, into.currency, { sign: true })}</span>
      </span>
      <span className="w-24 shrink-0 text-right text-[13px] text-ink-3">
        {dayLabel(out.local_date).replace(/^(\w+), /, "")}
        <br />
        {time(out.occurred_at, tz)}
      </span>
    </div>
  );
}
