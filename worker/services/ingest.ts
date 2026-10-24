// Bank notification ingestion: phone → /api/ingest → parse → transaction.

import { z } from "zod";
import type { Env } from "../env";
import type { ParsedMessage } from "@shared/types";
import { first, insert, nowIso, run } from "../lib/db";
import { sha256Hex } from "../lib/crypto";
import { isOtpMessage, parseBankMessage } from "./parser";
import { aiBlocked, structuredCall } from "./ai";
import { setSetting } from "./settings";
import { createContext, createTransaction, matchOwnTransfer, resolveAccount } from "./transactions";
import { convert } from "./fx";
import { localDate, parseAmount } from "@shared/money";

export interface IngestInput {
  body: string;
  sender?: string | null;
  source: "sms" | "push" | "email" | "test";
  receivedAt?: Date;
}

export interface IngestResult {
  status: "parsed" | "failed" | "ignored" | "duplicate";
  message_id: number | null;
  transaction_id: number | null;
  needs_ai: boolean;
  parsed?: ParsedMessage;
  error?: string;
}

const MAX_BODY = 2000;

export async function ingestMessage(env: Env, input: IngestInput): Promise<IngestResult> {
  const body = input.body.replace(/\r/g, "").trim().slice(0, MAX_BODY);
  if (!body) return { status: "ignored", message_id: null, transaction_id: null, needs_ai: false, error: "Empty message" };
  const receivedAt = input.receivedAt && !Number.isNaN(input.receivedAt.getTime()) ? input.receivedAt : new Date();
  const now = nowIso();
  await setSetting(env.DB, "last_message_at", now);

  // Never store one-time passwords.
  if (isOtpMessage(body)) {
    return { status: "ignored", message_id: null, transaction_id: null, needs_ai: false, error: "One-time code message (not stored)" };
  }

  const hash = await sha256Hex(body);
  const existing = await first<{ id: number; transaction_id: number | null }>(
    env.DB,
    "SELECT id, transaction_id FROM raw_messages WHERE body_hash = ?",
    hash,
  );
  if (existing) {
    return { status: "duplicate", message_id: existing.id, transaction_id: existing.transaction_id, needs_ai: false };
  }

  const messageId = await insert(
    env.DB,
    "INSERT INTO raw_messages (source, sender, body, body_hash, received_at, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
    input.source,
    input.sender?.slice(0, 60) ?? null,
    body,
    hash,
    receivedAt.toISOString(),
    now,
  );
  return processMessage(env, messageId, body, receivedAt, `msg:${hash}`);
}

/** Parse a stored message and create its transaction. Also used to re-process failed messages. */
export async function processMessage(
  env: Env,
  messageId: number,
  body: string,
  receivedAt: Date,
  externalRef: string,
): Promise<IngestResult> {
  const ctx = await createContext(env);
  let parsed = parseBankMessage(body, { receivedAt, tzOffsetMinutes: ctx.settings.tz_offset_minutes });
  let method = "regex";

  const weak = !parsed.is_transaction || parsed.confidence < 0.75 || (parsed.type === "purchase" && !parsed.merchant);
  if (weak && looksFinancial(body) && !(await aiBlocked(env, ctx.settings))) {
    try {
      const ai = await parseWithAI(env, body, receivedAt, ctx.settings.tz_offset_minutes, ctx.settings.ai_fast_model);
      if (ai) {
        parsed = mergeParses(parsed, ai);
        method = parsed.is_transaction ? "regex+ai" : "ai";
      }
    } catch (e) {
      console.error("AI parse failed", e);
    }
  }

  if (!parsed.is_transaction || parsed.amount <= 0) {
    await run(
      env.DB,
      "UPDATE raw_messages SET status = ?, parse_method = ?, parse_result = ?, error = ? WHERE id = ?",
      looksFinancial(body) ? "failed" : "ignored",
      method,
      JSON.stringify(parsed),
      looksFinancial(body) ? "No transaction amount found — is the notification title included?" : "Not a transaction",
      messageId,
    );
    return {
      status: looksFinancial(body) ? "failed" : "ignored",
      message_id: messageId,
      transaction_id: null,
      needs_ai: false,
      parsed,
      error: looksFinancial(body) ? "No transaction amount found — is the notification title included?" : "Not a transaction",
    };
  }

  // New cards default to AZN; the currency can be changed on the Accounts page.
  const account = await resolveAccount(env.DB, parsed.card_last4, "AZN");
  const accountCurrency = account?.currency ?? ctx.settings.base_currency;
  const occurredAt = parsed.occurred_at ?? receivedAt.toISOString();
  const ymd = localDate(new Date(occurredAt), ctx.settings.tz_offset_minutes);

  // Express the amount in the account's currency; keep the original if it differs.
  let amount = parsed.amount;
  let origAmount = parsed.orig_amount;
  let origCurrency = parsed.orig_currency;
  if (parsed.currency !== accountCurrency) {
    origAmount = parsed.amount;
    origCurrency = parsed.currency;
    amount = await convert(env.DB, parsed.amount, parsed.currency, accountCurrency, ymd);
  }
  const signed = parsed.direction === "in" ? amount : -amount;
  const balance =
    parsed.balance_after !== null && (parsed.balance_currency ?? accountCurrency) === accountCurrency ? parsed.balance_after : null;

  const created = await createTransaction(
    env,
    {
      account_id: account?.id ?? null,
      occurred_at: occurredAt,
      amount: signed,
      currency: accountCurrency,
      orig_amount: origAmount,
      orig_currency: origCurrency,
      merchant_raw: parsed.merchant,
      description: describeType(parsed.type),
      balance_after: balance,
      source: "sms",
      external_ref: externalRef,
      type: parsed.type,
    },
    ctx,
  );
  if (parsed.type === "transfer_in" || parsed.type === "transfer_out") await matchOwnTransfer(env.DB, ctx.idx, created.id);

  await run(
    env.DB,
    "UPDATE raw_messages SET status = 'parsed', parse_method = ?, parse_result = ?, error = NULL, transaction_id = ? WHERE id = ?",
    method,
    JSON.stringify(parsed),
    created.id,
    messageId,
  );
  return {
    status: created.duplicate ? "duplicate" : "parsed",
    message_id: messageId,
    transaction_id: created.id,
    needs_ai: created.needs_ai,
    parsed,
  };
}

function describeType(type: ParsedMessage["type"]): string | null {
  const map: Partial<Record<ParsedMessage["type"], string>> = {
    purchase: "Card payment",
    cash_withdrawal: "Cash withdrawal",
    transfer_in: "Transfer received",
    transfer_out: "Transfer sent",
    income: "Incoming payment",
    refund: "Refund",
    fee: "Bank fee",
  };
  return map[type] ?? null;
}

/** Cheap pre-check so we never spend AI money on obviously irrelevant texts. */
function looksFinancial(body: string): boolean {
  return /\d/.test(body) && /(azn|usd|eur|rub|try|man|₼|\$|€|balans|balance|kart|card|карт|odenis|ödəniş|mebleg|məbləğ)/i.test(body);
}

const AiParseSchema = z.object({
  is_transaction: z.boolean().describe("false for OTP codes, ads, balance-only or informational messages"),
  direction: z.enum(["in", "out"]),
  type: z.enum(["purchase", "transfer_in", "transfer_out", "cash_withdrawal", "income", "refund", "fee", "other"]),
  amount: z.number().describe("Transaction amount as a decimal number, e.g. 12.5"),
  currency: z.string().describe("ISO code of `amount`, e.g. AZN"),
  original_amount: z.number().nullable().describe("If the purchase was in a foreign currency and an AZN amount is also shown, the foreign amount"),
  original_currency: z.string().nullable(),
  merchant: z.string().nullable().describe("Merchant / counterparty name exactly as written, without card numbers or dates"),
  card_last4: z.string().nullable(),
  local_datetime: z.string().nullable().describe("Transaction date-time as written, converted to YYYY-MM-DD HH:MM (local time), or null"),
  balance_after: z.number().nullable(),
  balance_currency: z.string().nullable(),
});

async function parseWithAI(
  env: Env,
  body: string,
  receivedAt: Date,
  tzOffset: number,
  model: string,
): Promise<ParsedMessage | null> {
  const local = new Date(receivedAt.getTime() + tzOffset * 60_000).toISOString().slice(0, 16).replace("T", " ");
  const { data: r } = await structuredCall(env, {
    purpose: "parse",
    model,
    system:
      "You extract structured data from bank card notification messages (SMS or push) of Azerbaijani banks. " +
      "Messages may be in Azerbaijani, English or Russian. Keywords: Mədaxil/Medaxil = money in, Məxaric/Mexaric/Ödəniş = money out, " +
      "Nağdlaşdırma = cash withdrawal, Köçürmə = transfer, Balans/Qalıq = balance after the transaction. Never invent values.",
    content: `Message received at ${local} local time:\n"""\n${body}\n"""`,
    schema: AiParseSchema,
    maxTokens: 2000,
    effort: "low",
  });
  if (!r) return null;
  // Never accept an amount that isn't actually written in the message.
  const amountWritten = amountInText(body, r.amount) || Boolean(r.original_amount && amountInText(body, r.original_amount));
  const isJustTheBalance = r.balance_after !== null && Math.abs(r.amount - r.balance_after) < 0.005;
  if (r.is_transaction && (!amountWritten || isJustTheBalance)) return emptyParse();
  let occurred: string | null = null;
  const dt = r.local_datetime?.match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (dt) {
    const utc = Date.UTC(+dt[1], +dt[2] - 1, +dt[3], +dt[4], +dt[5]) - tzOffset * 60_000;
    if (Math.abs(utc - receivedAt.getTime()) < 366 * 86_400_000) occurred = new Date(utc).toISOString();
  }
  const toMinor = (n: number | null) => (n === null || !Number.isFinite(n) ? null : Math.round(Math.abs(n) * 100));
  return {
    is_transaction: r.is_transaction,
    direction: r.direction,
    type: r.type,
    amount: toMinor(r.amount) ?? 0,
    currency: (r.currency || "AZN").toUpperCase().slice(0, 3),
    orig_amount: toMinor(r.original_amount),
    orig_currency: r.original_currency?.toUpperCase().slice(0, 3) ?? null,
    merchant: r.merchant?.trim() || null,
    card_last4: r.card_last4?.replace(/\D/g, "").slice(-4) || null,
    occurred_at: occurred,
    balance_after: toMinor(r.balance_after),
    balance_currency: r.balance_currency?.toUpperCase().slice(0, 3) ?? null,
    confidence: 0.9,
  };
}

function amountInText(body: string, amount: number): boolean {
  const target = Math.round(Math.abs(amount) * 100);
  for (const m of body.matchAll(/\d{1,3}(?:[ ,]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?/g)) {
    if (parseAmount(m[0]) === target) return true;
  }
  return false;
}

function emptyParse(): ParsedMessage {
  return {
    is_transaction: false,
    direction: "out",
    type: "other",
    amount: 0,
    currency: "AZN",
    orig_amount: null,
    orig_currency: null,
    merchant: null,
    card_last4: null,
    occurred_at: null,
    balance_after: null,
    balance_currency: null,
    confidence: 0,
  };
}

/**
 * Combine both parses: AI is better at meaning (direction, type, merchant), the
 * deterministic parser at exact numbers, so its amount wins unless it was unsure.
 */
function mergeParses(regex: ParsedMessage, ai: ParsedMessage): ParsedMessage {
  if (!regex.is_transaction) return ai;
  if (!ai.is_transaction) return { ...regex, confidence: Math.min(regex.confidence, 0.5) };
  const trustRegexAmount = regex.amount > 0 && regex.confidence >= 0.6;
  return {
    ...ai,
    amount: trustRegexAmount ? regex.amount : ai.amount,
    currency: trustRegexAmount ? regex.currency : ai.currency,
    merchant: ai.merchant ?? regex.merchant,
    card_last4: regex.card_last4 ?? ai.card_last4,
    occurred_at: regex.occurred_at ?? ai.occurred_at,
    balance_after: regex.balance_after ?? ai.balance_after,
    balance_currency: regex.balance_currency ?? ai.balance_currency,
    confidence: 0.9,
  };
}
