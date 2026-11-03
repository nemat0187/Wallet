#!/usr/bin/env node
// End-to-end check of exchange rates and foreign-currency money against a LOCAL dev server, with mock rate sources.
// .dev.vars must contain (local only):
//   APP_PASSWORD=...  FX_TEST_CBAR_URL=http://127.0.0.1:8797/currencies  FX_TEST_ER_URL=http://127.0.0.1:8797/er
//   npm run dev:api     then     node scripts/fx-check.mjs

import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:8787";
if (!/^http:\/\/(127\.0\.0\.1|localhost)/.test(BASE)) throw new Error("Local servers only");
const password = readFileSync(".dev.vars", "utf8").match(/^APP_PASSWORD=(.*)$/m)?.[1]?.trim();
const sql = (command) =>
  JSON.parse(execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--local", "--json", "--command", command], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }))[0].results;
const ymdOf = (offsetDays) => new Date(Date.now() + 240 * 60_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);
const TODAY = ymdOf(0), YEST = ymdOf(-1), OLD = ymdOf(-14), SEED = ymdOf(-30);
const dmy = (ymd) => ymd.split("-").reverse().join(".");

// Mock rate sources. The bank's file exists only for TODAY (and only while `bankUp`); the backup source can be switched off too.
let bankUp = true, backupUp = true;
const hits = { bank: {}, backup: 0 };
const mock = createServer((req, res) => {
  const url = req.url ?? "";
  if (url.startsWith("/currencies/")) {
    const date = url.slice("/currencies/".length).replace(".xml", "");
    hits.bank[date] = (hits.bank[date] ?? 0) + 1;
    if (!bankUp || date !== dmy(TODAY)) { res.statusCode = 404; return res.end("not found"); }
    res.setHeader("content-type", "text/xml");
    return res.end(`<ValCurs Date="${date}"><ValType Type="x"><Valute Code="USD"><Nominal>1</Nominal><Value>1.7000</Value></Valute><Valute Code="EUR"><Nominal>1</Nominal><Value>2.0000</Value></Valute><Valute Code="RUB"><Nominal>100</Nominal><Value>2.0000</Value></Valute></ValType></ValCurs>`);
  }
  if (url.startsWith("/er")) {
    hits.backup++;
    if (!backupUp) { res.statusCode = 503; return res.end("down"); }
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ result: "success", base_code: "USD", rates: { USD: 1, AZN: 1.7, EUR: 0.8, RUB: 85 } }));
  }
  res.statusCode = 404;
  res.end();
}).listen(8797);

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  ${detail}`}`);
};
const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;

try {
  const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
  const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("wallet_session="));
  const api = async (method, path, body) => {
    const res = await fetch(`${BASE}/api${path}`, { method, headers: { cookie, "content-type": "application/json", origin: BASE }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  sql(`DELETE FROM fx_rates WHERE date IN ('${TODAY}', '${YEST}', '${OLD}', '${SEED}')`);
  sql(`INSERT INTO fx_rates (date, currency, rate, source, fetched_at) VALUES ('${SEED}', 'USD', 1.69, 'cbar', '${new Date().toISOString()}'), ('${SEED}', 'EUR', 1.99, 'cbar', '${new Date().toISOString()}')`);

  // 1. The official source.
  const refreshed = await api("POST", "/rates/refresh");
  const usd = (r) => r.data.rates.find((x) => x.currency === "USD");
  check("refresh takes today's rates from the bank file", refreshed.data.ok === true && refreshed.data.source === "cbar", JSON.stringify(refreshed.data).slice(0, 200));
  check("USD and EUR rates are stored per unit (RUB nominal 100 divided)", near(usd(refreshed) .rate, 1.7, 0.0001) && near(refreshed.data.rates.find((x) => x.currency === "RUB").rate, 0.02, 0.0001), JSON.stringify(refreshed.data.rates));
  check("the rates screen reports the source and date", usd(refreshed).source === "cbar" && usd(refreshed).date === TODAY && usd(refreshed).approximate === false);

  // 2. A card in another currency, spending in its own currency and in a different one.
  const acc = await api("POST", "/accounts", { name: "FX Amex", type: "card", currency: "USD", balance: 50000 });
  const accId = acc.data.id;
  const add = async (body) => (await api("POST", "/transactions", { account_id: accId, direction: "out", merchant: "FXTEST", ...body })).data.id;
  const row = (id) => sql(`SELECT amount, currency, amount_base, orig_amount, orig_currency FROM transactions WHERE id = ${id}`)[0];
  const t1 = row(await add({ date: TODAY, amount: 1000 }));
  check("a USD expense on a USD card is converted to AZN at the day's rate", t1.currency === "USD" && t1.amount === -1000 && t1.amount_base === -1700, JSON.stringify(t1));
  const t2 = row(await add({ date: TODAY, amount: 1000, currency: "EUR" }));
  check("a EUR expense on a USD card is saved in USD with the EUR original kept", t2.currency === "USD" && near(t2.amount, -1176) && t2.orig_amount === 1000 && t2.orig_currency === "EUR" && near(t2.amount_base, -2000), JSON.stringify(t2));
  const t3 = row(await add({ date: TODAY, amount: 5000, currency: "AZN" }));
  check("an AZN expense on a USD card is converted into USD", t3.currency === "USD" && near(t3.amount, -2941) && t3.orig_currency === "AZN" && near(t3.amount_base, -5000), JSON.stringify(t3));

  // 3. Backup source for yesterday (the bank has no file).
  const t4 = row(await add({ date: YEST, amount: 1000 }));
  check("when the bank file is missing, the backup source supplies recent rates", t4.amount_base === -1700 && sql(`SELECT source FROM fx_rates WHERE date = '${YEST}' AND currency = 'USD'`)[0]?.source === "er-api", JSON.stringify(t4));

  // 4. An older day with no published rate: nearest earlier rate, fetched once only.
  const before = hits.bank[dmy(OLD)] ?? 0;
  const t5 = row(await add({ date: OLD, amount: 1000 }));
  const afterFirst = hits.bank[dmy(OLD)] ?? 0;
  await add({ date: OLD, amount: 2000 });
  const afterSecond = hits.bank[dmy(OLD)] ?? 0;
  check("a day without a published rate uses the nearest earlier one", t5.amount_base === -1690 && sql(`SELECT source FROM fx_rates WHERE date = '${OLD}' AND currency = 'USD'`)[0]?.source === "carried", JSON.stringify(t5));
  check("and the rate source is not asked again for every transaction", afterFirst - before === 1 && afterSecond === afterFirst, `${before} ${afterFirst} ${afterSecond}`);

  // 5. Totals and the overall budget statistics use AZN.
  const accounts = (await api("GET", "/accounts")).data;
  const mine = accounts.find((a) => a.id === accId);
  check("the account list shows the balance in AZN", mine.balance_base === Math.round(50000 * 1.7) || near(mine.balance_base, 85000, 5), JSON.stringify(mine));
  const dash = (await api("GET", "/analytics/dashboard")).data;
  check("the home overview carries the AZN balance too", near(dash.accounts.find((a) => a.id === accId)?.balance_base, 85000, 5));
  const q = (await api("POST", "/analytics/query", { metric: "spent", group_by: "none", from: SEED, to: TODAY, filters: { merchant: "FXTEST" } })).data;
  check("spending statistics add up in AZN", near(q.total, 1700 + 2000 + 5000 + 1700 + 1690 + 3380, 10), JSON.stringify(q).slice(0, 200));

  // 6. Both sources down: friendly error, last known rates stay.
  bankUp = false;
  backupUp = false;
  sql(`DELETE FROM fx_rates WHERE date = '${TODAY}'`);
  const down = await api("POST", "/rates/refresh");
  check("with every source down the refresh says so and keeps the last rates", down.status === 200 && down.data.ok === false && /Could not reach/.test(down.data.error) && usd(down).rate > 1, JSON.stringify(down.data).slice(0, 200));
  const t6 = row(await add({ date: TODAY, amount: 1000 }));
  check("spending still converts using the last known rate", t6.amount_base === -1690 || t6.amount_base === -1700, JSON.stringify(t6));

  // Tidy up.
  sql(`DELETE FROM transactions WHERE account_id = ${accId}`);
  sql(`DELETE FROM merchants WHERE name = 'FXTEST' OR key LIKE 'fxtest%'`);
  sql(`DELETE FROM accounts WHERE id = ${accId}`);
  sql(`DELETE FROM fx_rates WHERE date IN ('${OLD}', '${SEED}', '${YEST}')`);
} finally {
  mock.close();
}
console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll exchange-rate checks passed");
process.exit(failures ? 1 : 0);
