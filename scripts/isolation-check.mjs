#!/usr/bin/env node
// Checks, against a LOCAL dev server, that one user can never see or change another user's data.
// Creates a second user directly in the local database, signs in as the owner and as user 2, and tries to
// read and modify the owner's rows through the API.
//
//   npm run dev:api          (one terminal)
//   node scripts/isolation-check.mjs

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:8787";
if (!/^http:\/\/(127\.0\.0\.1|localhost)/.test(BASE)) throw new Error("Local servers only");
const password = readFileSync(".dev.vars", "utf8").match(/^APP_PASSWORD=(.*)$/m)?.[1]?.trim();

// A fresh user id each run (the server remembers which users it already set up).
const U2 = 1000 + Math.floor(Math.random() * 900000);
const sql = (command) =>
  JSON.parse(execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--local", "--json", "--command", command.replaceAll("@U2@", String(U2))], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }))[0].results;

const token = "isolation-check-token";
const hash = createHash("sha256").update(token).digest("hex");
const now = new Date().toISOString();
const expires = new Date(Date.now() + 86_400_000).toISOString();
const wipeUser2 = () => {
  for (const t of ["notes", "goals", "transactions", "raw_messages", "merchants", "accounts", "categories", "budgets", "api_tokens", "rules", "dashboards", "range_budgets", "insights", "ai_usage", "notifications_sent", "sessions"]) sql(`DELETE FROM ${t} WHERE user_id = @U2@`);
  sql("DELETE FROM user_settings WHERE user_id = @U2@");
  sql("DELETE FROM users WHERE id = @U2@");
};
wipeUser2();
sql("DELETE FROM transactions WHERE user_id = 1 AND merchant_raw LIKE '%ISOLATION%'");
sql("DELETE FROM raw_messages WHERE user_id = 1 AND body LIKE '%ISOLATION SHOP%'");
sql("DELETE FROM api_tokens WHERE user_id = 1 AND name = 'isolation'");
sql("DELETE FROM accounts WHERE user_id = 1 AND card_last4 = '7777'");
sql(`INSERT INTO users (id, email, name, role, status, created_at) VALUES (@U2@, 'second@example.test', 'Second', 'user', 'active', '${now}')`);
sql(`INSERT INTO sessions (user_id, token_hash, created_at, last_seen_at, expires_at) VALUES (@U2@, '${hash}', '${now}', '${now}', '${expires}')`);

const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
const ownerCookie = login.headers.get("set-cookie").split(";")[0];
const call = (cookie) => async (method, path, body) => {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { cookie, "content-type": "application/json", origin: BASE },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
};
const owner = call(ownerCookie);
const other = call(`wallet_session=${token}`);

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  ${detail}`}`);
};

// What the owner has.
const ownerTx = (await owner("GET", "/transactions?limit=3")).data.items;
const txId = ownerTx[0].id;
const ownerAccounts = (await owner("GET", "/accounts")).data;
const ownerCounts = sql("SELECT (SELECT COUNT(*) FROM transactions WHERE user_id = 1) tx, (SELECT COUNT(*) FROM accounts WHERE user_id = 1) acc, (SELECT COUNT(*) FROM merchants WHERE user_id = 1) mer, (SELECT COUNT(*) FROM categories WHERE user_id = 1) cat")[0];
const ownerNoteId = (await owner("POST", "/notes", { title: "owner secret", body: "x" })).data.id;
const ownerGoal = (await owner("POST", "/goals", { name: "owner goal", target: 100000, deadline: null })).data.id;
const ownerRule = (await owner("POST", "/rules", { conditions: [{ field: "merchant", op: "contains", value: "zzz" }], set_tags: "t" })).data.id;
const ownerDash = (await owner("POST", "/dashboards", { name: "owner dash", widgets: [] })).data.id;

const await_ids = new Set((await owner("GET", "/categories")).data.map((c) => c.id));

// 1. Lists are empty for the other user.
await other("GET", "/bootstrap"); // first request sets the user up (own categories and cash wallet)
const ownerIds = {
  "/accounts": new Set(ownerAccounts.map((a) => a.id)),
  "/categories": new Set((await owner("GET", "/categories")).data.map((c) => c.id)),
};
for (const path of ["/transactions?limit=50", "/accounts", "/merchants", "/rules", "/notes", "/dashboards", "/categories"]) {
  const r = await other("GET", path);
  const list = Array.isArray(r.data) ? r.data : r.data.items;
  const mine = ownerIds[path];
  check(
    mine ? `list ${path} holds none of the owner's rows` : `list ${path} is empty for user 2`,
    r.status === 200 && Array.isArray(list) && (mine ? list.every((x) => !mine.has(x.id)) : list.length === 0),
    JSON.stringify(r.data).slice(0, 120),
  );
}
const dash = await other("GET", "/analytics/dashboard");
check("dashboard totals are zero", dash.status === 200 && dash.data.totals.spent === 0 && dash.data.recent.length === 0, JSON.stringify(dash.data.totals));
const q = await other("POST", "/analytics/query", { metric: "spent", group_by: "category", from: "2000-01-01", to: "2100-01-01" });
check("custom analytics query is empty", q.status === 200 && q.data.total === 0 && q.data.rows.length === 0, JSON.stringify(q.data).slice(0, 120));
const backup = await other("GET", "/export/backup.json");
const backupRows = Object.entries(backup.data.data ?? {}).filter(([k, v]) => Array.isArray(v) && ["transactions", "accounts", "merchants", "rules", "notes", "dashboards", "raw_messages"].includes(k));
check("backup holds none of the owner's rows", backupRows.every(([k, v]) => v.every((r) => !(k === "accounts" && ownerIds["/accounts"].has(r.id)))) && backupRows.filter(([k]) => k !== "accounts").every(([, v]) => v.length === 0), backupRows.map(([k, v]) => `${k}:${v.length}`).join(" "));
const csv = await other("GET", "/export/transactions.csv");
check("CSV export has no owner rows", typeof csv.data === "string" && csv.data.trim().split("\n").length <= 1, String(csv.data).slice(0, 80));

// 2. Reading owner rows by id.
check("GET owner's transaction -> 404", (await other("GET", `/transactions/${txId}`)).status === 404);

// 3. Changing owner rows by id has no effect.
const before = (await owner("GET", `/transactions/${txId}`)).data;
await other("PATCH", `/transactions/${txId}`, { note: "HACKED", amount: 1, tags: "hacked" });
await other("POST", "/transactions/bulk", { ids: ownerTx.map((t) => t.id), delete: true });
await other("DELETE", `/transactions/${txId}`);
await other("PUT", `/notes/${ownerNoteId}`, { title: "HACKED", body: "HACKED" });
await other("DELETE", `/notes/${ownerNoteId}`);
const goalHit = [(await other("PUT", `/goals/${ownerGoal}`, { name: "HACKED", target: 1, deadline: null })).status, (await other("POST", `/goals/${ownerGoal}/contribute`, { amount: 5 })).status, (await other("DELETE", `/goals/${ownerGoal}`)).status];
await other("DELETE", `/rules/${ownerRule}`);
await other("PUT", `/dashboards/${ownerDash}`, { name: "HACKED", widgets: [] });
await other("DELETE", `/dashboards/${ownerDash}`);
await other("PATCH", `/accounts/${ownerAccounts[0].id}`, { name: "HACKED", balance: 1 });
await other("DELETE", `/accounts/${ownerAccounts[0].id}`);
await other("POST", `/accounts/${ownerAccounts[0].id}/merge-into/${ownerAccounts[1]?.id ?? ownerAccounts[0].id}`);
const after = (await owner("GET", `/transactions/${txId}`)).data;
check("owner's transaction unchanged and still there", after.note === before.note && after.amount === before.amount && after.tags === before.tags && after.id === txId);
const ownerCountsAfter = sql("SELECT (SELECT COUNT(*) FROM transactions WHERE user_id = 1) tx, (SELECT COUNT(*) FROM accounts WHERE user_id = 1) acc, (SELECT COUNT(*) FROM merchants WHERE user_id = 1) mer, (SELECT COUNT(*) FROM categories WHERE user_id = 1) cat")[0];
check("owner's row counts unchanged", JSON.stringify(ownerCounts) === JSON.stringify(ownerCountsAfter), `${JSON.stringify(ownerCounts)} -> ${JSON.stringify(ownerCountsAfter)}`);
const ownerGoalNow = (await owner("GET", "/goals")).data.find((g) => g.id === ownerGoal);
check("the other person cannot see, change or delete the owner's goal", (await other("GET", "/goals")).data.length === 0 && goalHit[0] === 404 && goalHit[1] === 404 && ownerGoalNow?.name === "owner goal" && ownerGoalNow.saved === 0, JSON.stringify(goalHit));
const note = (await owner("GET", "/notes")).data.find((n) => n.id === ownerNoteId);
check("owner's note untouched", note?.title === "owner secret");
check("owner's rule still there", (await owner("GET", "/rules")).data.some((r) => r.id === ownerRule));
check("owner's dashboard untouched", (await owner("GET", "/dashboards")).data.find((d) => d.id === ownerDash)?.name === "owner dash");
check("owner's account untouched", (await owner("GET", "/accounts")).data[0].name === ownerAccounts[0].name);

// 4. Things user 2 creates belong to user 2 only.
const created = await other("POST", "/notes", { title: "mine", body: "private" });
check("user 2 can create a note", created.status === 200);
check("owner does not see user 2's note", !(await owner("GET", "/notes")).data.some((n) => n.title === "mine"));
check("user 2 sees only their note", (await other("GET", "/notes")).data.length === 1);
const sessions = await other("GET", "/auth/sessions");
check("sessions list shows only user 2's session", sessions.status === 200 && sessions.data.length === 1, JSON.stringify(sessions.data).slice(0, 100));
await other("POST", "/auth/sessions/revoke-others");
check("revoke-others by user 2 leaves the owner signed in", (await owner("GET", "/accounts")).status === 200);

// 5. User 2 gets their own setup, settings, tokens and messages.
const boot = await other("GET", "/bootstrap");
check("user 2 gets their own default categories and a cash wallet", boot.data.categories.length > 50 && boot.data.accounts.some((a) => a.type === "cash"), `${boot.data.categories?.length} categories`);
check("category slugs look the same for every user", boot.data.categories.some((c) => c.slug === "dining.delivery"), "slug suffix leaked");
check("categories are not shared with the owner", boot.data.categories.every((c) => !(await_ids.has(c.id))), "");
await other("PATCH", "/settings", { month_start_day: 15, overall_budget: 12345 });
const ownerSettings = (await owner("GET", "/settings")).data;
const otherSettings = (await other("GET", "/settings")).data;
check("settings are separate per user", otherSettings.month_start_day === 15 && ownerSettings.month_start_day !== 15 && ownerSettings.overall_budget !== 12345, JSON.stringify([ownerSettings.month_start_day, otherSettings.month_start_day]));
const otherToken = (await other("POST", "/messages/tokens", { name: "phone 2" })).data.token;
const ownerBefore = sql("SELECT COUNT(*) n FROM transactions WHERE user_id = 1")[0].n;
const sms = { title: "💸 Ödəniş: -4.50₼", text: "ISOLATION SHOP\nKart: **7777\nBalans: 20.00₼" };
const post = (t) => fetch(`${BASE}/api/ingest?token=${t}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sms) }).then((r) => r.json());
const a = await post(otherToken);
check("user 2's phone message is recorded", a.status === "parsed", JSON.stringify(a));
const ownerToken = (await owner("POST", "/messages/tokens", { name: "isolation" })).data.token;
const b = await post(ownerToken);
check("the same text from the owner is not treated as a duplicate", b.status === "parsed", JSON.stringify(b));
check("the message landed with user 2 only", sql("SELECT COUNT(*) n FROM transactions WHERE user_id = @U2@ AND merchant_raw LIKE '%ISOLATION%'")[0].n === 1 && sql("SELECT COUNT(*) n FROM transactions WHERE user_id = 1")[0].n === ownerBefore + 1);
const card = (list) => list.find((x) => x.card_last4 === "7777")?.id;
const card2 = card((await other("GET", "/accounts")).data);
const card1 = card((await owner("GET", "/accounts")).data);
check("each user gets their own record for the same card number", card2 && card1 && card1 !== card2, `${card1} vs ${card2}`);
const badToken = await fetch(`${BASE}/api/ingest?token=wlt_nonsense`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sms) });
check("an unknown token is refused", badToken.status === 401);
sql("UPDATE users SET status = 'disabled' WHERE id = @U2@");
check("a disabled user's session stops working", (await other("GET", "/accounts")).status === 401);
check("a disabled user's phone token stops working", (await fetch(`${BASE}/api/ingest?token=${otherToken}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sms) })).status === 401);
sql("UPDATE users SET status = 'active' WHERE id = @U2@");

// Clean up what this check created.
await owner("DELETE", `/notes/${ownerNoteId}`);
await owner("DELETE", `/rules/${ownerRule}`);
await owner("DELETE", `/dashboards/${ownerDash}`);
wipeUser2();
sql("DELETE FROM transactions WHERE user_id = 1 AND merchant_raw LIKE '%ISOLATION%'");
sql("DELETE FROM raw_messages WHERE user_id = 1 AND body LIKE '%ISOLATION SHOP%'");
sql("DELETE FROM api_tokens WHERE user_id = 1 AND name = 'isolation'");
sql("DELETE FROM accounts WHERE user_id = 1 AND card_last4 = '7777'");

console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll isolation checks passed");
process.exit(failures ? 1 : 0);
