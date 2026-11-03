#!/usr/bin/env node
// End-to-end check of the bring-your-own-AI features against a LOCAL dev server, with a mock Claude, ChatGPT and
// Gemini. .dev.vars must contain (local only):
//   APP_PASSWORD=...  ENCRYPTION_KEY=...  ANTHROPIC_API_KEY=sk-ant-INSTALLKEY-aaaaaaaaaaaaaaaa
//   AI_TEST_ANTHROPIC_URL=http://127.0.0.1:8798  AI_TEST_OPENAI_URL=http://127.0.0.1:8798  AI_TEST_GEMINI_URL=http://127.0.0.1:8798
//   npm run dev:api     then     node scripts/ai-check.mjs

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { startMock } from "./ai-mock.mjs";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:8787";
if (!/^http:\/\/(127\.0\.0\.1|localhost)/.test(BASE)) throw new Error("Local servers only");
const password = readFileSync(".dev.vars", "utf8").match(/^APP_PASSWORD=(.*)$/m)?.[1]?.trim();
const U2 = 2000 + Math.floor(Math.random() * 900000);
const sql = (command) =>
  JSON.parse(execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--local", "--json", "--command", command.replaceAll("@U2@", String(U2))], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }))[0].results;
const RUN = Math.floor(Math.random() * 90000) + 10000; // makes every run's messages new
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const mock = await startMock(8798);
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  ${detail}`}`);
};
const seenBodies = [];

const call = (cookie) => async (method, path, body) => {
  const res = await fetch(`${BASE}/api${path}`, { method, headers: { cookie, "content-type": "application/json", origin: BASE }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  seenBodies.push(text);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
};

const GOOD = { anthropic: "sk-ant-GOODKEY-aaaaaaaaaaaaaaaaaaaa", openai: "sk-GOODKEY-bbbbbbbbbbbbbbbbbbbbbbbb", gemini: "AIzaGOODKEY-ccccccccccccccccccccccc" };
const EXPECT_MODELS = { anthropic: ["claude-haiku-5-5", "claude-opus-5-5"], openai: ["gpt-5-mini", "gpt-5"], gemini: ["gemini-2.5-flash", "gemini-2.5-pro"] };
const LABEL = { anthropic: "Claude", openai: "ChatGPT", gemini: "Gemini" };

try {
  const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
  const owner = call(login.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("wallet_session=")));
  sql("DELETE FROM user_settings WHERE user_id = 1 AND (key LIKE 'ai_key%' OR key LIKE 'ai_models%' OR key = 'ai_provider' OR key LIKE 'mfa_%' OR key IN ('totp_secret','recovery_codes'))");
  await owner("PATCH", "/settings", { ai_monthly_token_cap: 2000000, ai_enabled: true });

  // A second person, with a session but no AI key.
  const token = "ai-check-token";
  const hash = createHash("sha256").update(token).digest("hex");
  const now = new Date().toISOString();
  sql(`INSERT INTO users (id, email, name, role, status, created_at) VALUES (@U2@, 'ai2-${U2}@example.test', 'Second', 'user', 'active', '${now}')`);
  sql(`INSERT INTO sessions (user_id, token_hash, created_at, last_seen_at, expires_at) VALUES (@U2@, '${hash}', '${now}', '${now}', '${new Date(Date.now() + 86_400_000).toISOString()}')`);
  const other = call(`wallet_session=${token}`);
  await other("GET", "/bootstrap");

  // ===== The installation's Claude key works for the owner only =====
  const p0 = (await owner("GET", "/ai/providers")).data.providers.find((p) => p.provider === "anthropic");
  check("the owner sees the installation Claude key as usable", p0.has_key && p0.source === "installation" && p0.last4 === null, JSON.stringify(p0));
  const model0 = (await owner("GET", "/settings")).data;
  check("the owner can use AI without adding a key", model0.ai_configured === true);
  const o0 = (await other("GET", "/ai/providers")).data.providers;
  check("another person has no key and no installation fallback", o0.every((p) => !p.has_key), JSON.stringify(o0));
  const chatNoKey = await other("POST", "/ai/chat", { messages: [{ role: "user", content: "hi" }] });
  check("another person is told to add their own key", chatNoKey.status === 400 && /own API key/.test(chatNoKey.data.error), JSON.stringify(chatNoKey.data));
  mock.log.length = 0;
  const t0 = await owner("POST", "/ai/test");
  check("the owner's request used the installation key", t0.status === 200 && mock.log.some((l) => l.key.includes("INSTALLKEY") && l.method === "POST"), JSON.stringify(t0.data));

  // ===== Each provider =====
  const hook = (await owner("POST", "/messages/tokens", { name: "ai-check" })).data.token;
  const send = (title, text) => fetch(`${BASE}/api/ingest?token=${hook}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, text }) }).then((r) => r.json());

  for (const p of ["anthropic", "openai", "gemini"]) {
    const name = LABEL[p];
    const bad = await owner("PUT", `/ai/keys/${p}`, { key: `${p === "gemini" ? "AIza" : "sk-"}BADKEY-zzzzzzzzzzzzzzzzzzzz` });
    check(`${name}: a wrong key is refused with a clear message`, bad.status === 400 && /rejected your API key/.test(bad.data.error), JSON.stringify(bad.data));
    check(`${name}: a refused key is not stored`, !(await owner("GET", "/ai/providers")).data.providers.find((x) => x.provider === p).last4);
    const short = await owner("PUT", `/ai/keys/${p}`, { key: "short" });
    check(`${name}: a nonsense key is refused before asking the provider`, short.status === 400);

    const saved = await owner("PUT", `/ai/keys/${p}`, { key: `  ${GOOD[p].slice(0, 12)}\n${GOOD[p].slice(12)}  ` }); // pasted with a line break
    const st = saved.data.providers?.find((x) => x.provider === p);
    check(`${name}: a good key is saved (pasted whitespace removed), shown only as the last 4`, saved.status === 200 && st.has_key && st.source === "own" && st.last4 === GOOD[p].slice(-4) && st.selected, JSON.stringify(saved.data).slice(0, 200));
    check(`${name}: the provider's own model list is offered`, EXPECT_MODELS[p].every((m) => st.models.includes(m)) && !st.models.some((m) => /embedding|whisper/.test(m)), JSON.stringify(st.models));
    const s = (await owner("GET", "/settings")).data;
    check(`${name}: sensible models are chosen from that list`, s.ai_provider === p && s.ai_fast_model === EXPECT_MODELS[p][0] && s.ai_smart_model === EXPECT_MODELS[p][1], `${s.ai_provider} ${s.ai_fast_model} ${s.ai_smart_model}`);

    mock.log.length = 0;
    const test = await owner("POST", "/ai/test");
    check(`${name}: the connection test works with the person's own key`, test.status === 200 && test.data.ok === true && test.data.provider === p && mock.log.some((l) => l.method === "POST" && l.key === GOOD[p]), JSON.stringify(test.data));

    // Categorizing a merchant nobody knows.
    const merchant = `ZXQ KITCHEN ${RUN} ${["qzk", "wvx", "jhp"][["anthropic", "openai", "gemini"].indexOf(p)]}`; // not in the built-in merchant list, so only AI can place it
    const r1 = await send(`💸 Ödəniş: -7.30₼ / ${merchant}`, "Kart: **1234 / Balans: 100.00₼");
    check(`${name}: a bank message from an unknown merchant is recorded`, r1.status === "parsed", JSON.stringify(r1));
    await sleep(1500);
    let m = (await owner("GET", `/merchants?q=${encodeURIComponent(merchant)}`)).data[0];
    if (m?.category_source !== "ai") {
      await owner("POST", "/ai/categorize");
      m = (await owner("GET", `/merchants?q=${encodeURIComponent(merchant)}`)).data[0];
    }
    check(`${name}: the merchant is categorized by AI`, m?.category_source === "ai" && m.category_id, JSON.stringify(m));

    // A message the built-in reader can't understand.
    mock.log.length = 0;
    const odd = await send("ABB", `odenis olundu 18.40 AZN PAPA JOHNS NARIMANOV ${RUN} ${p} qaliq 500.10 AZN kart 1234`);
    check(`${name}: a message only AI can read is recorded`, odd.status === "parsed" && mock.log.some((l) => l.method === "POST"), JSON.stringify(odd));

    const pdf = await owner("POST", "/import/pdf", { file_base64: "JVBERi0xLjQK".repeat(30) });
    check(`${name}: a PDF statement is read`, pdf.status === 200 && JSON.stringify(pdf.data).includes("BRAVO"), JSON.stringify(pdf.data).slice(0, 150));

    const report = await owner("POST", "/ai/insights", { kind: "manual", start: "2026-06-01", end: "2026-11-03" });
    check(`${name}: a report is written`, report.status === 200 && report.data.id, JSON.stringify(report.data));

    mock.log.length = 0;
    const chat = await owner("POST", "/ai/chat", { messages: [{ role: "user", content: "How much did I spend by category?" }] });
    const posts = mock.log.filter((l) => l.method === "POST").length;
    check(`${name}: chat looks things up and answers (2 requests: question, then answer)`, chat.status === 200 && /spending by category/.test(chat.data.reply) && posts === 2 && mock.log.some((l) => l.tools > 0), JSON.stringify(chat.data).slice(0, 200));
    check(`${name}: the looked-up numbers come from the person's real data`, /AZN|₼|\d/.test(chat.data.reply ?? ""), chat.data.reply);
  }

  // ===== Usage and costs =====
  const usage = (await owner("GET", "/ai/usage")).data;
  const rows = usage.by_purpose;
  const byProvider = (p) => rows.filter((r) => r.provider === p);
  check("usage is recorded per provider with tokens", ["anthropic", "openai", "gemini"].every((p) => byProvider(p).some((r) => r.input_tokens > 0 && r.output_tokens > 0)));
  check("Claude costs are known, other providers' are not", byProvider("anthropic").every((r) => r.cost_known === 1 && r.cost_usd > 0) && [...byProvider("openai"), ...byProvider("gemini")].every((r) => r.cost_known === 0 && r.cost_usd === 0));
  check("the month's token total is reported", usage.month_tokens > 20000 && usage.token_cap === 2000000 && usage.status === "ok", JSON.stringify([usage.month_tokens, usage.token_cap, usage.status]));

  // ===== Limits =====
  await owner("PATCH", "/settings", { ai_monthly_token_cap: 10000 });
  const capped = await owner("POST", "/ai/chat", { messages: [{ role: "user", content: "again" }] });
  check("the token limit stops further AI use with a clear message", capped.status === 400 && /usage limit/.test(capped.data.error), JSON.stringify(capped.data));
  check("usage status says the limit was reached", (await owner("GET", "/ai/usage")).data.status === "tokens_reached");
  await owner("PATCH", "/settings", { ai_monthly_token_cap: 2000000 });

  // ===== Provider problems =====
  await owner("PUT", "/ai/keys/openai", { key: "sk-QUOTAKEY-eeeeeeeeeeeeeeeeeeeeeeee" });
  const quota = await owner("POST", "/ai/test");
  check("an account out of quota gets a message about its plan", quota.status === 400 && /quota or credit/.test(quota.data.error) && /ChatGPT/.test(quota.data.error), JSON.stringify(quota.data));
  await owner("PUT", "/ai/keys/gemini", { key: "AIza-REJECTAFTER-dddddddddddddddddd" });
  const rej = await owner("POST", "/ai/test");
  check("a key the provider later rejects is reported", rej.status === 400 && /rejected your API key/.test(rej.data.error), JSON.stringify(rej.data));
  check("AI then stays paused until a new key is saved", (await owner("GET", "/ai/usage")).data.status === "key_rejected" && (await owner("POST", "/ai/chat", { messages: [{ role: "user", content: "x" }] })).status === 400);
  await owner("PUT", "/ai/keys/gemini", { key: GOOD.gemini });
  check("saving a new key resumes AI", (await owner("GET", "/ai/usage")).data.status === "ok" && (await owner("POST", "/ai/test")).status === 200);

  // ===== Switching provider =====
  await owner("PUT", "/ai/keys/openai", { key: GOOD.openai });
  const sw = await owner("PUT", "/ai/provider", { provider: "openai" });
  const s2 = (await owner("GET", "/settings")).data;
  check("switching provider chooses models that belong to it", sw.status === 200 && s2.ai_provider === "openai" && s2.ai_fast_model === "gpt-5-mini", JSON.stringify([s2.ai_provider, s2.ai_fast_model]));
  const back = await owner("PUT", "/ai/provider", { provider: "gemini" });
  check("and back again", (await owner("GET", "/settings")).data.ai_fast_model === "gemini-2.5-flash" && back.status === 200);
  await owner("PUT", "/ai/provider", { provider: "anthropic" });
  const refresh = await owner("POST", "/ai/models/openai");
  check("the model list can be refreshed", refresh.status === 200 && refresh.data.providers.find((x) => x.provider === "openai").models.includes("gpt-5"));

  // ===== Each person's keys are their own =====
  const theirs = await other("PUT", "/ai/keys/openai", { key: "sk-GOODKEY-ffffffffffffffffffffffff" });
  check("another person can save their own key", theirs.status === 200 && theirs.data.providers.find((p) => p.provider === "openai").last4 === "ffff");
  const mine = (await owner("GET", "/ai/providers")).data.providers.find((p) => p.provider === "openai");
  check("the owner's key is untouched by it", mine.last4 === GOOD.openai.slice(-4));
  mock.log.length = 0;
  await other("PUT", "/ai/provider", { provider: "openai" });
  const tt = await other("POST", "/ai/test");
  check("their requests use their key, not the owner's", tt.status === 200 && mock.log.filter((l) => l.method === "POST").every((l) => l.key === "sk-GOODKEY-ffffffffffffffffffffffff"), JSON.stringify(mock.log));
  check("their usage is their own", (await other("GET", "/ai/usage")).data.month_tokens < usage.month_tokens);

  // ===== Keys never leave the server =====
  const everything = seenBodies.join("\n") + (await (await fetch(`${BASE}/api/export/backup.json`, { headers: { cookie: login.headers.getSetCookie()[0].split(";")[0] } })).text());
  const leaked = Object.values(GOOD).filter((k) => everything.includes(k) || everything.includes(k.slice(0, 20) + "\\n"));
  check("no API response or backup contains a key", leaked.length === 0 && !everything.includes("sk-GOODKEY-ffff"), leaked.join(","));
  const plain = sql("SELECT COUNT(*) n FROM user_settings WHERE value LIKE '%GOODKEY%' OR value LIKE '%QUOTAKEY%' OR value LIKE '%REJECTAFTER%'")[0].n;
  check("keys are stored encrypted in the database", plain === 0);
  const sealed = sql("SELECT value FROM user_settings WHERE user_id = 1 AND key = 'ai_key_anthropic'")[0]?.value ?? "";
  check("stored keys look sealed", sealed.startsWith("enc1:"));

  // ===== Removing a key =====
  const removed = await owner("DELETE", "/ai/keys/gemini");
  check("a key can be removed", removed.status === 200 && !removed.data.providers.find((p) => p.provider === "gemini").has_key);
  check("the other person's key is stored under their own account", (sql("SELECT COUNT(*) n FROM user_settings WHERE user_id = @U2@ AND key LIKE 'ai_key%'")[0].n >= 1));
} finally {
  // Clean up what this check created.
  for (const t of ["ai_usage", "transactions", "raw_messages", "merchants", "accounts", "categories", "api_tokens", "insights", "sessions"]) sql(`DELETE FROM ${t} WHERE user_id = @U2@`);
  sql("DELETE FROM user_settings WHERE user_id = @U2@");
  sql("DELETE FROM users WHERE id = @U2@");
  sql("DELETE FROM transactions WHERE user_id = 1 AND (merchant_raw LIKE '%ZXQ KITCHEN%' OR merchant_raw LIKE '%PAPA JOHNS%')");
  sql("DELETE FROM raw_messages WHERE user_id = 1 AND (body LIKE '%ZXQ KITCHEN%' OR body LIKE '%PAPA JOHNS%')");
  sql("DELETE FROM merchants WHERE user_id = 1 AND key LIKE '%zxq kitchen%'");
  sql("DELETE FROM api_tokens WHERE user_id = 1 AND name = 'ai-check'");
  sql("DELETE FROM user_settings WHERE user_id = 1 AND (key LIKE 'ai_key%' OR key LIKE 'ai_models%' OR key = 'ai_provider' OR key = 'ai_key_error')");
  sql("DELETE FROM insights WHERE user_id = 1 AND created_at > date('now', '-1 day')");
  mock.close();
}
console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll AI checks passed");
process.exit(failures ? 1 : 0);
