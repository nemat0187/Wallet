// Heuristic parser for bank card notifications (SMS or push), tuned for
// Azerbaijani banks such as ABB but tolerant of English and Russian wording.
//
// Strategy: first read "Key: Value" fields (the most common SMS layout), then
// fill the gaps with free-text heuristics. The result carries a confidence
// score; low-confidence results are re-checked by AI when it is available.

import type { ParsedMessage } from "@shared/types";
import { parseAmount, pad2 } from "@shared/money";

/** Lowercase and strip Azerbaijani/Turkish diacritics, keeping the string length (indexes stay aligned). */
export function foldText(s: string): string {
  let out = "";
  for (const ch of s) {
    const mapped = FOLD[ch];
    if (mapped !== undefined) out += mapped;
    else {
      const lower = ch.toLowerCase();
      out += lower.length === ch.length ? lower : ch;
    }
  }
  return out;
}

const FOLD: Record<string, string> = {
  ə: "e", Ə: "e", ı: "i", İ: "i", ö: "o", Ö: "o", ü: "u", Ü: "u",
  ş: "s", Ş: "s", ç: "c", Ç: "c", ğ: "g", Ğ: "g",
};

const CURRENCY_ALIASES: Record<string, string> = {
  azn: "AZN", man: "AZN", manat: "AZN", "₼": "AZN",
  usd: "USD", $: "USD", eur: "EUR", "€": "EUR", rub: "RUB", rur: "RUB", "₽": "RUB",
  try: "TRY", tl: "TRY", "₺": "TRY", gbp: "GBP", "£": "GBP", gel: "GEL", aed: "AED",
  kzt: "KZT", uah: "UAH", chf: "CHF", cny: "CNY", jpy: "JPY", cad: "CAD",
};
const CUR = "(AZN|MANAT|MAN|USD|EUR|RUB|RUR|TRY|TL|GBP|GEL|AED|KZT|UAH|CHF|CNY|JPY|CAD|₼|\\$|€|₽|₺|£)";
const NUM = "((?:\\d{1,3}(?:[ \\u00a0,]\\d{3})+|\\d+)(?:[.,]\\d{1,2})?)";
const AMOUNT_RE = new RegExp(
  `(?<![\\d*.,:])([-+−])?\\s?${NUM}\\s?${CUR}(?![a-z])|(?<![a-z])${CUR}\\s?([-+−])?\\s?${NUM}(?![\\d])`,
  "gi",
);
const CUR_WITH_DIGIT = new RegExp(`\\d\\s?${CUR}(?![a-z])|(?<![a-z])${CUR}\\s?\\d`, "i");

// Keyword groups, matched against folded (lowercase, diacritic-free) text.
const KW = {
  // "balansinizdan" = "from your balance", which is not a balance figure.
  balance: /(balans(?!\w*d[ae]n\b)|balance|qaliq|movcud|available|avail\b|istifadeye yararli|остаток|доступно|баланс)/,
  limit: /(limit)/,
  fee: /(komissiya|commission|\bfee\b|xidmet haqqi|комиссия)/,
  refund: /(refund|\breturn|reversal|qaytar|geri qaytar|legv|возврат|отмена)/,
  income: /(medaxil|daxil ol|hesabiniza|kartiniza|credited|\breceived|incoming|зачислен|поступлен|пополнен|maas|salary|emek haqqi|cashback|kesbek)/,
  outgoing: /(kartinizdan|hesabinizdan|balansinizdan|silindi|cixildi|debited|списан)/,
  cash: /(nagd|cash withdrawal|\batm\b|bankomat|снятие|наличн)/,
  transfer: /(kocurme|transfer|перевод|kartdan karta|\bc2c\b|\bp2p\b)/,
  purchase: /(mexaric|odenis|alis|satinalma|purchase|payment|\bpaid\b|spent|\bdebit|списан|покупка|оплата|\bpos\b)/,
};

const OTP_RE = [
  /(\bkod\w*|\bcode\b|parol|sifre|\botp\b|пароль|(?<![а-яё])код)[^\d\n]{0,25}\b\d{4,8}\b/,
  /\b\d{4,8}\b[^\d\n]{0,25}(\bkod\w*|\bcode\b|\botp\b|пароль|(?<![а-яё])код)/,
  /(hec kime|do not share|never share|никому не)/,
];

// "Key: Value" field names (folded) mapped to a field.
type Field = "amount" | "balance" | "card" | "merchant" | "date" | "time" | "type" | "description" | "fee";
const KEY_FIELDS: { field: Field; re: RegExp }[] = [
  { field: "balance", re: /^(balans|balance|qaliq|movcud|available|istifadeye yararli|остаток|баланс|доступно)/ },
  { field: "fee", re: /^(komissiya|commission|fee|xidmet haqqi|комиссия)/ },
  { field: "card", re: /^(kart|card|карта|hesab|account|счет)/ },
  {
    field: "merchant",
    re: /^(yer|obyekt|merchant|magaza|unvan|terminal|satici|place|where|noqte|ticaret|место|продавец|магазин|получатель|alici|receiver|recipient|from|kimden|gonderen|отправитель)/,
  },
  { field: "time", re: /^(vaxt|время|time|saat)/ },
  { field: "date", re: /^(tarix|date|дата)/ },
  { field: "type", re: /^(emeliyyat|operation|операция|tranzaksiya|transaction|nov|type)/ },
  { field: "description", re: /^(teyinat|purpose|назначение|description|qeyd|melumat|details)/ },
  {
    field: "amount",
    re: /^(mebleg|amount|summa|сумма|odenis|mexaric|medaxil|alis|purchase|payment|kocurme|nagd|satinalma|debit|credit|списание|зачисление|покупка|оплата|перевод|refund|qaytarilma|geri)/,
  },
];

interface FoundAmount {
  value: number;
  currency: string;
  sign: "+" | "-" | null;
  index: number;
  end: number;
  label: "txn" | "balance" | "fee" | "limit";
}

export interface ParseOptions {
  receivedAt: Date;
  tzOffsetMinutes: number;
}

export function parseBankMessage(text: string, opts: ParseOptions): ParsedMessage {
  const raw = text.replace(/\r/g, "").trim();
  const folded = foldText(raw);
  const empty = emptyResult();
  if (OTP_RE.some((re) => re.test(folded))) return empty;

  const amounts = findAmounts(raw, folded);
  const txnAmounts = amounts.filter((a) => a.label === "txn");
  let feeOnly = false;
  if (txnAmounts.length === 0) {
    // A lone fee is still a transaction ("Komissiya: 0.50 AZN").
    const fee = amounts.find((a) => a.label === "fee");
    if (!fee) return empty;
    txnAmounts.push({ ...fee, label: "txn" });
    feeOnly = true;
  }

  const kv = readKeyValues(raw);

  // Amount: prefer AZN as the account amount and another currency as the original amount.
  let main = txnAmounts[0];
  let orig: FoundAmount | null = null;
  const azn = txnAmounts.find((a) => a.currency === "AZN");
  const foreign = txnAmounts.find((a) => a.currency !== "AZN");
  if (azn && foreign) {
    main = azn;
    orig = foreign;
  }
  const balance = amounts.find((a) => a.label === "balance") ?? null;

  // Direction and type: the explicit operation field wins over the rest of the text.
  const typeText = foldText([kv.type, kv.amountKey].filter(Boolean).join(" "));
  let cls = (typeText && classify(typeText)) || classify(folded);
  // "Köçürmə" alone doesn't say which way the money went; the rest of the text does.
  if (cls?.type === "transfer_out" && classify(folded)?.type === "transfer_in") cls = classify(folded);
  if (feeOnly) cls = { type: "fee", direction: "out" };
  let { type, direction } = cls ?? { type: "purchase" as const, direction: "out" as const };
  if (main.sign && type !== "refund") {
    direction = main.sign === "+" ? "in" : "out";
    if (type === "transfer_in" || type === "transfer_out") type = direction === "in" ? "transfer_in" : "transfer_out";
    if (type === "income" && direction === "out") type = "purchase";
  }

  const card = extractCard(raw, kv.card);
  const dateText = kv.date ? `${kv.date} ${kv.time ?? ""}` : kv.time;
  const occurredAt = (dateText && extractDate(dateText, opts)) || extractDate(raw, opts);
  let merchant = kv.merchant ? cleanMerchant(kv.merchant) : null;
  if (!merchant && type !== "cash_withdrawal" && type !== "fee") merchant = extractMerchantFreeText(raw, folded, main);
  if (!merchant && kv.description) merchant = cleanMerchant(kv.description);

  let confidence = 0.4;
  if (cls || main.sign) confidence += 0.2;
  if (card) confidence += 0.15;
  if (merchant || type !== "purchase") confidence += 0.15;
  if (occurredAt) confidence += 0.1;

  return {
    is_transaction: true,
    direction,
    type,
    amount: main.value,
    currency: main.currency,
    orig_amount: orig?.value ?? null,
    orig_currency: orig?.currency ?? null,
    merchant,
    card_last4: card,
    occurred_at: occurredAt,
    balance_after: balance ? balance.value : null,
    balance_currency: balance ? balance.currency : null,
    confidence: Math.min(1, Math.round(confidence * 100) / 100),
  };
}

function classify(t: string): { type: ParsedMessage["type"]; direction: "in" | "out" } | null {
  if (KW.refund.test(t)) return { type: "refund", direction: "in" };
  if (KW.cash.test(t)) return { type: "cash_withdrawal", direction: "out" };
  const transfer = KW.transfer.test(t);
  if (KW.income.test(t) && !KW.outgoing.test(t)) return { type: transfer ? "transfer_in" : "income", direction: "in" };
  if (transfer) return { type: "transfer_out", direction: "out" };
  if (KW.purchase.test(t) || KW.outgoing.test(t)) return { type: "purchase", direction: "out" };
  return null;
}

function emptyResult(): ParsedMessage {
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

function findAmounts(raw: string, folded: string): FoundAmount[] {
  const found: FoundAmount[] = [];
  AMOUNT_RE.lastIndex = 0;
  for (let m = AMOUNT_RE.exec(raw); m; m = AMOUNT_RE.exec(raw)) {
    const [whole, sign1, num1, cur1, cur2, sign2, num2] = m;
    const num = num1 ?? num2;
    const cur = (cur1 ?? cur2).toLowerCase();
    const value = parseAmount(num);
    if (value === null) continue;
    const signChar = sign1 ?? sign2;
    const sign = signChar === "+" ? "+" : signChar === "-" || signChar === "−" ? "-" : null;
    found.push({
      value,
      currency: CURRENCY_ALIASES[cur] ?? cur.toUpperCase(),
      sign,
      index: m.index,
      end: m.index + whole.length,
      label: labelFor(folded, m.index),
    });
  }
  return found;
}

/** Look at the words just before an amount (same line, same clause) to decide what it is. */
function labelFor(folded: string, index: number): FoundAmount["label"] {
  const lineStart = folded.lastIndexOf("\n", index - 1) + 1;
  let context = folded.slice(Math.max(lineStart, index - 40), index);
  const cut = Math.max(context.lastIndexOf(","), context.lastIndexOf(";"), context.lastIndexOf(". "));
  if (cut > -1 && cut < context.length - 1) context = context.slice(cut + 1);
  if (KW.balance.test(context)) return "balance";
  if (KW.limit.test(context)) return "limit";
  if (KW.fee.test(context)) return "fee";
  return "txn";
}

interface KeyValues {
  amountKey?: string;
  card?: string;
  merchant?: string;
  date?: string;
  time?: string;
  type?: string;
  description?: string;
}

/** Splits on newlines, semicolons and on ". Next" / ", Key:" boundaries, then reads "Key: Value" pairs. */
function readKeyValues(raw: string): KeyValues {
  const kv: KeyValues = {};
  const parts = raw.split(
    /\n|;\s*|\.\s+(?=[A-ZƏÖÜŞÇĞİА-Я])|,\s*(?=[A-Za-zƏəÖöÜüŞşÇçĞğİıА-Яа-я ]{2,25}:)/,
  );
  for (const part of parts) {
    const m = part.match(/^\s*([^:\d]{2,30}?)\s*:\s*(.+?)\s*$/);
    if (!m) continue;
    const key = foldText(m[1]).trim();
    const value = m[2];
    for (const { field, re } of KEY_FIELDS) {
      if (!re.test(key)) continue;
      if (field === "amount") kv.amountKey ??= key;
      else if (field !== "fee" && field !== "balance") kv[field] ??= value;
      break;
    }
  }
  return kv;
}

function extractCard(raw: string, cardField?: string): string | null {
  const patterns = [
    /\d{4,6}[*xX•·]{2,}\d{0,2}[*xX•·]*(\d{4})\b/,
    /[*xX•·]{2,}\s?(\d{4})\b/,
    /\*\s?(\d{4})\b/,
    /(?:kart|card|карта)[^\d\n]{0,12}(\d{4})\b(?![.,]\d)/i,
  ];
  for (const s of cardField ? [cardField, raw] : [raw]) {
    for (const p of patterns) {
      const m = s.match(p);
      if (m) return m[1];
    }
    if (s === cardField) {
      const digits = s.match(/(\d{4})\D*$/);
      if (digits) return digits[1];
    }
  }
  return null;
}

/** Find a date/time in the text (interpreted in the user's timezone) and return ISO UTC. */
export function extractDate(text: string, opts: ParseOptions): string | null {
  const off = opts.tzOffsetMinutes * 60_000;
  const recvLocal = new Date(opts.receivedAt.getTime() + off);
  let y: number | undefined;
  let mo: number | undefined;
  let d: number | undefined;
  let h = 0;
  let mi = 0;
  let s = 0;
  let hasTime = false;

  const ymd = text.match(/\b(\d{4})-(\d{2})-(\d{2})(?:[\sT]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  const dmy = text.match(/(?<![\d.,])(\d{1,2})[./-](\d{1,2})[./-](\d{4}|\d{2})(?![\d])(?:[\s,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (ymd) {
    [y, mo, d] = [Number(ymd[1]), Number(ymd[2]), Number(ymd[3])];
    if (ymd[4]) [h, mi, s, hasTime] = [Number(ymd[4]), Number(ymd[5]), Number(ymd[6] ?? 0), true];
  } else if (dmy) {
    d = Number(dmy[1]);
    mo = Number(dmy[2]);
    y = Number(dmy[3]);
    if (y < 100) y += 2000;
    if (dmy[4]) [h, mi, s, hasTime] = [Number(dmy[4]), Number(dmy[5]), Number(dmy[6] ?? 0), true];
  }
  if (!hasTime) {
    const t = text.match(/(?<![\d.])(\d{1,2}):(\d{2})(?::(\d{2}))?(?![\d])/);
    if (t) [h, mi, s, hasTime] = [Number(t[1]), Number(t[2]), Number(t[3] ?? 0), true];
  }
  if (y === undefined) {
    if (!hasTime) return null;
    [y, mo, d] = [recvLocal.getUTCFullYear(), recvLocal.getUTCMonth() + 1, recvLocal.getUTCDate()];
  }
  if (!mo || !d || mo > 12 || d > 31 || h > 23 || mi > 59) return null;
  if (!hasTime) {
    // Date without a time: on the day the message arrived use the arrival time, otherwise noon.
    if (`${y}-${pad2(mo)}-${pad2(d)}` === recvLocal.toISOString().slice(0, 10)) return opts.receivedAt.toISOString();
    h = 12;
  }
  let utc = Date.UTC(y, mo - 1, d, h, mi, s) - off;
  // A time-only match just after midnight can belong to the previous day.
  if (utc > opts.receivedAt.getTime() + 3600_000 && !dmy && !ymd) utc -= 86_400_000;
  // Reject implausible dates (more than a day ahead or a year back).
  if (utc > opts.receivedAt.getTime() + 86_400_000 || utc < opts.receivedAt.getTime() - 366 * 86_400_000) return null;
  return new Date(utc).toISOString();
}

// Words that never belong to a merchant name (folded). Removed before judging a text segment.
const NOISE =
  /\b(abb|bank|pos|ecom|e-com|odenis\w*|mexaric|medaxil|alis\w*|satinalma|purchase|payment|paid|spent|debit\w*|credit\w*|mebleg\w*|amount|edil\w*|olun\w*|uzre|ucun|ile|ve|kart\w*|card|hesab\w*|tarix\w*|date|time|on|of|for|your|from|to|was|has|been|successful|ugurla|emeliyyat\w*|transaction)\b|покупка|оплата|списание|карт[аы]|сумма|успешно/g;
const MERCHANT_STOP = /(balans|balance|qaliq|movcud|available|остаток|tesekkur|thank|limit|endirim|kampaniya)/;

function stripNoise(seg: string): string {
  const f = foldText(seg);
  const keep = [...seg];
  const blank = (re: RegExp) => {
    for (const m of f.matchAll(re)) for (let i = m.index; i < m.index + m[0].length; i++) keep[i] = " ";
  };
  blank(/\d{1,2}[./-]\d{1,2}[./-]\d{2,4}/g);
  blank(/\b\d{1,2}:\d{2}(:\d{2})?\b/g);
  blank(/\d{4,6}[*x•·]+\d{0,2}[*x•·]*\d{4}|[*x•·]{2,}\s?\d{4}|\*\s?\d{4}/g);
  blank(NOISE);
  return keep
    .join("")
    .replace(/^[\s:.\-–]+|[\s:.\-–]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractMerchantFreeText(raw: string, folded: string, main: FoundAmount): string | null {
  const after = raw.slice(main.end);
  // "... at BRAVO SUPERMARKET on card *1234" / "... в МАГАЗИН ..."
  const at = after.match(/(?:^|\s)(?:at|в|@)\s+([A-Za-z0-9А-Яа-я][^,\n;]{1,60})/);
  if (at) {
    const name = stripNoise(at[1].split(/\s+(?:on|using|with|via|by)\s|\.\s|\s\*/i)[0]);
    if (looksLikeMerchant(name)) return cleanMerchant(name);
  }
  const split = (s: string) => s.split(/[,\n;|]|\.\s+/);
  // "Key: Value" segments were already read as fields; don't treat them as merchant names.
  const isField = (seg: string) => /^\s*[^:\d]{2,30}:\s*\S/.test(seg);
  for (const seg of split(after)) {
    if (isField(seg)) continue;
    const name = stripNoise(seg);
    if (looksLikeMerchant(name)) return cleanMerchant(name);
  }
  // Clauses before the amount (e.g. "*1234 POS BRAVO SUPERMARKET 12.40 AZN"): require capitals to avoid prose.
  const before = split(raw.slice(0, main.index)).reverse();
  for (const seg of before) {
    if (isField(seg) && !/^\s*abb\s*:/i.test(seg)) continue;
    const name = stripNoise(seg.replace(/^[^:]{0,15}:/, ""));
    if (looksLikeMerchant(name) && /[A-ZА-ЯƏÖÜŞÇĞİ]{3,}/.test(name)) return cleanMerchant(name);
  }
  void folded;
  return null;
}

function looksLikeMerchant(seg: string): boolean {
  if (seg.length < 2 || seg.length > 70) return false;
  const f = foldText(seg);
  if (MERCHANT_STOP.test(f)) return false;
  if (CUR_WITH_DIGIT.test(seg)) return false;
  if (Object.values(KW).some((re) => re.test(f)) && !/[A-Z]{3,}/.test(seg)) return false;
  const letters = seg.replace(/[^A-Za-zА-Яа-яƏəÖöÜüŞşÇçĞğİı]/g, "");
  return letters.length >= 2;
}

export function cleanMerchant(s: string): string | null {
  let m = s
    .replace(/\s+/g, " ")
    .replace(/[.,;:\-–\s]+$/, "")
    .replace(/^[.,;:\-–\s]+/, "")
    .trim();
  if (m.length > 80) m = m.slice(0, 80).trim();
  return m.length >= 2 ? m : null;
}

/** True for one-time-password / verification messages, which must never be stored. */
export function isOtpMessage(text: string): boolean {
  const folded = foldText(text);
  return OTP_RE.some((re) => re.test(folded));
}
