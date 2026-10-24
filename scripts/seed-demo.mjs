#!/usr/bin/env node
// Fills a LOCAL development server with ~4 months of realistic demo data by
// sending ABB-style SMS texts to the ingest webhook — exactly like a phone would.
//
//   npm run dev:api           (in one terminal)
//   npm run db:seed:demo      (in another)
//
// Options (env vars): BASE_URL (default http://127.0.0.1:8787), APP_PASSWORD (default from .dev.vars)

import { readFileSync } from "node:fs";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:8787";
let password = process.env.APP_PASSWORD;
if (!password) {
  try {
    password = readFileSync(".dev.vars", "utf8").match(/^APP_PASSWORD=(.*)$/m)?.[1]?.trim();
  } catch {
    // no .dev.vars
  }
}
if (!password) throw new Error("Set APP_PASSWORD or create .dev.vars");
if (!/^http:\/\/(127\.0\.0\.1|localhost)/.test(BASE) && !process.argv.includes("--yes-really")) {
  throw new Error("Refusing to seed a non-local server. Pass --yes-really if you mean it.");
}

let seed = 42;
const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const between = (a, b) => a + rand() * (b - a);
const pick = (xs) => xs[Math.floor(rand() * xs.length)];
const pad = (n) => String(n).padStart(2, "0");

const login = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ password }),
});
if (!login.ok) throw new Error(`Login failed: ${await login.text()}`);
const cookie = login.headers.get("set-cookie").split(";")[0];
const api = async (path, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", cookie, origin: BASE },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
};
const { token } = await api("/api/messages/tokens", { name: "Demo seeder" });

const cards = { main: "1234", online: "5678", salary: "9012" };
const balances = { main: 1800, online: 400, salary: 3000 };

// [merchant, card, times per week, min, max, hour range]
const habits = [
  ["BRAVO SUPERMARKET 014 BAKU AZ", "main", 2.2, 14, 65, [10, 21]],
  ["ARAZ MARKET 112", "main", 1.2, 6, 30, [8, 22]],
  ["WOLT AZERBAIJAN", "online", 2.0, 11, 32, [12, 23]],
  ["BOLT.EU", "main", 4.0, 2.8, 9.5, [7, 23]],
  ["COFFEE MOFFIE NIZAMI", "main", 3.0, 4.2, 7.5, [8, 18]],
  ["SOCAR PETROLEUM 33", "main", 0.9, 38, 62, [8, 20]],
  ["ZEYTUN APTEK 7", "main", 0.4, 6, 28, [9, 21]],
  ["KAFE NERGIZ", "main", 0.6, 18, 55, [13, 22]],
  ["SHAH KEBAB 28 MAY", "main", 0.7, 9, 22, [12, 23]],
  ["PARK CINEMA FLAME", "main", 0.4, 12, 24, [17, 22]],
  ["TRENDYOL", "online", 0.3, 25, 140, [20, 24]],
  ["MAGAZA 24 SAAT", "main", 0.8, 3, 15, [22, 24]],
];
// [merchant, card, day of month, amount, currency]
const monthly = [
  ["AZERCELL TELECOM", "main", 3, 15, "AZN"],
  ["NETFLIX.COM", "online", 8, 9.99, "USD"],
  ["SPOTIFY P1A2B3", "online", 14, 5.99, "USD"],
  ["SPORTLIFE FITNESS", "main", 2, 60, "AZN"],
  ["AZERISIQ", "main", 11, 0, "AZN"],
  ["CITYNET", "main", 6, 25, "AZN"],
];

const messages = [];
const today = new Date();
const start = new Date(today.getTime() - 120 * 86400000);
const fmt = (d, h, m) => `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${pad(h)}:${pad(m)}`;

for (let d = new Date(start); d <= today; d = new Date(d.getTime() + 86400000)) {
  const day = d.getUTCDate();
  const isWeekend = [0, 6].includes(d.getUTCDay());
  for (const [merchant, card, perWeek, min, max, [h1, h2]] of habits) {
    if (rand() < (perWeek / 7) * (isWeekend ? 1.3 : 0.9)) {
      const amount = between(min, max);
      const h = Math.min(23, Math.floor(between(h1, h2)));
      messages.push({ when: new Date(d), h, m: Math.floor(between(0, 59)), merchant, card, amount, currency: "AZN", kind: "out" });
    }
  }
  for (const [merchant, card, dom, amount, currency] of monthly) {
    if (day === dom) {
      const value = amount || between(22, 38);
      messages.push({ when: new Date(d), h: 9, m: 15, merchant, card, amount: value, currency, kind: "out" });
    }
  }
  if (day === 1) messages.push({ when: new Date(d), h: 10, m: 2, merchant: null, card: "salary", amount: 2800, currency: "AZN", kind: "salary" });
  if (day === 2) messages.push({ when: new Date(d), h: 11, m: 30, merchant: null, card: "salary", amount: 1200, currency: "AZN", kind: "move" });
  if (day === 5) messages.push({ when: new Date(d), h: 19, m: 40, merchant: null, card: "main", amount: 650, currency: "AZN", kind: "rent" });
  if (day === 15 || day === 28) messages.push({ when: new Date(d), h: 18, m: 5, merchant: "ABB ATM 28 MALL", card: "main", amount: 100, currency: "AZN", kind: "atm" });
}
// One unusually large purchase
messages.push({ when: new Date(today.getTime() - 3 * 86400000), h: 20, m: 10, merchant: "BRAVO SUPERMARKET 014 BAKU AZ", card: "main", amount: 245.3, currency: "AZN", kind: "out" });
messages.sort((a, b) => a.when - b.when || a.h - b.h);

const money = (n) => n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/, ",");
const RECENT_DAYS = 6;

/** Messages from the last few days use the ABB app's real notification format (no date inside; time = arrival). */
function appNotification(x) {
  const azn = x.currency === "USD" ? x.amount * 1.7 : x.amount;
  const card = cards[x.card];
  if (x.kind === "salary") {
    balances.salary += x.amount;
    return `💸 Köçürmə: +${money(x.amount)}₼\nƏMƏK HAQQI\nKart: **${cards.salary}\nBalans: ${money(balances.salary)}₼`;
  }
  if (x.kind === "move") {
    balances.salary -= x.amount;
    balances.main += x.amount;
    return [
      `💸 Köçürmə: -${money(x.amount)}₼\nABB MOBILE\nKart: **${cards.salary}\nBalans: ${money(balances.salary)}₼`,
      `💸 Köçürmə: +${money(x.amount)}₼\nABB MOBILE\nKart: **${cards.main}\nBalans: ${money(balances.main)}₼`,
    ];
  }
  balances[x.card] -= azn;
  if (x.kind === "rent") return `💸 Köçürmə: -${money(x.amount)}₼\nABB MOBILE\nKart: **${card}\nBalans: ${money(balances[x.card])}₼`;
  if (x.kind === "atm") return `💸 Nağdlaşdırma: -${money(x.amount)}₼\n${x.merchant}\nKart: **${card}\nBalans: ${money(balances[x.card])}₼`;
  return `💸 Ödəniş: -${money(azn)}₼\n${x.merchant}\nKart: **${card}\nBalans: ${money(balances[x.card])}₼`;
}

function sms(x) {
  const time = fmt(x.when, x.h, x.m);
  const azn = x.currency === "USD" ? x.amount * 1.7 : x.amount;
  if (x.kind === "salary") {
    balances.salary += x.amount;
    return `Mədaxil: ${x.amount.toFixed(2)} AZN\nKart: 4169****${cards.salary}\nTəyinat: ƏMƏK HAQQI\nTarix: ${time}\nBalans: ${balances.salary.toFixed(2)} AZN`;
  }
  if (x.kind === "move") {
    balances.salary -= x.amount;
    balances.main += x.amount;
    return [
      `Köçürmə: ${x.amount.toFixed(2)} AZN kartınızdan. Kart: *${cards.salary}. Tarix: ${time}. Balans: ${balances.salary.toFixed(2)} AZN`,
      `Köçürmə: ${x.amount.toFixed(2)} AZN kartınıza daxil oldu. Kart: *${cards.main}. Tarix: ${time}. Balans: ${balances.main.toFixed(2)} AZN`,
    ];
  }
  balances[x.card] -= azn;
  if (x.kind === "rent") {
    return `Köçürmə: ${x.amount.toFixed(2)} AZN kartınızdan. Kart: *${cards.main}. Tarix: ${time}. Balans: ${balances.main.toFixed(2)} AZN`;
  }
  if (x.kind === "atm") {
    return `Nağdlaşdırma: ${x.amount.toFixed(2)} AZN\nYer: ${x.merchant}\nKart: 4169***${cards.main}\nTarix: ${time}\nBalans: ${balances.main.toFixed(2)} AZN`;
  }
  const amountText =
    x.currency === "USD" ? `${x.amount.toFixed(2)} USD (${azn.toFixed(2)} AZN)` : `${x.amount.toFixed(2)} AZN`;
  return pick([
    () => `ABB\nMəxaric: ${amountText}\n${x.merchant}\nKart: 4169***${cards[x.card]}\nTarix: ${time}\nBalans: ${balances[x.card].toFixed(2)} AZN`,
    () => `Ödəniş: ${amountText}\nObyekt: ${x.merchant}\nKart: *${cards[x.card]}\nTarix: ${time}\nMövcud balans: ${balances[x.card].toFixed(2)} AZN`,
  ])();
}

let ok = 0;
for (const x of messages) {
  // Local time in Baku (UTC+4) → epoch ms for the "received" timestamp.
  const at = Date.UTC(x.when.getUTCFullYear(), x.when.getUTCMonth(), x.when.getUTCDate(), x.h, x.m) - 4 * 3600_000;
  const recent = Date.now() - at < RECENT_DAYS * 86400000 && at <= Date.now();
  const texts = [recent ? appNotification(x) : sms(x)].flat();
  for (const text of texts) {
    const res = await fetch(`${BASE}/api/ingest?token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: recent ? JSON.stringify({ text, received_at: at }) : JSON.stringify({ text, from: "ABB" }),
    });
    const body = await res.json();
    if (body.status === "parsed") ok++;
    else if (body.status !== "duplicate") console.log("not parsed:", body, text);
  }
}

// A few budgets so the budget screens have something to show.
const cats = await api("/api/categories");
const bySlug = Object.fromEntries(cats.map((c) => [c.slug, c.id]));
const put = (path, body) =>
  fetch(`${BASE}${path}`, { method: "PUT", headers: { "content-type": "application/json", cookie, origin: BASE }, body: JSON.stringify(body) });
await put("/api/budgets", { category_id: bySlug.food, amount: 45000 });
await put("/api/budgets", { category_id: bySlug.dining, amount: 30000 });
await put("/api/budgets", { category_id: bySlug.transport, amount: 25000 });
await put("/api/budgets", { category_id: bySlug.subscriptions, amount: 5000 });
await put("/api/budgets/overall", { amount: 200000 });

console.log(`Seeded ${ok} transactions from ${messages.length} demo events.`);
