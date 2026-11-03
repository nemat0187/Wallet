#!/usr/bin/env node
// End-to-end check of sign-up, approval and admin rules against a LOCAL dev server, with a mock Google.
//
// .dev.vars must contain (local only):
//   APP_PASSWORD=...  GOOGLE_CLIENT_ID=test-client  GOOGLE_CLIENT_SECRET=x
//   GOOGLE_AUTH_URL=http://127.0.0.1:8799/auth  GOOGLE_TOKEN_URL=http://127.0.0.1:8799/token
//   ENCRYPTION_KEY=<32 random bytes, base64>
//   npm run dev:api     then     node scripts/auth-check.mjs

import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:8787";
if (!/^http:\/\/(127\.0\.0\.1|localhost)/.test(BASE)) throw new Error("Local servers only");
const password = readFileSync(".dev.vars", "utf8").match(/^APP_PASSWORD=(.*)$/m)?.[1]?.trim();
const sql = (command) =>
  JSON.parse(execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--local", "--json", "--command", command], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }))[0].results;

// Mock Google token endpoint: the "code" is base64url JSON with the claims to return.
const mock = createServer((req, res) => {
  let data = "";
  req.on("data", (d) => (data += d));
  req.on("end", () => {
    const code = new URLSearchParams(data).get("code") ?? "";
    try {
      const claims = JSON.parse(Buffer.from(code, "base64url").toString());
      const payload = { iss: "https://accounts.google.com", aud: "test-client", exp: Math.floor(Date.now() / 1000) + 600, email_verified: true, ...claims };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id_token: `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s` }));
    } catch {
      res.statusCode = 400;
      res.end("{}");
    }
  });
}).listen(8799);

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  ${detail}`}`);
};

const cookieOf = (res) => (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]);
const nohtml = { redirect: "manual" };

// --- authenticator codes, computed the way an app does -----------------------------------------------------
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function totp(secret, stepOffset = 0) {
  let bits = 0, value = 0;
  const key = [];
  for (const ch of secret) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) { key.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  const counter = Math.floor(Date.now() / 30_000) + stepOffset;
  const msg = Buffer.alloc(8);
  msg.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  msg.writeUInt32BE(counter >>> 0, 4);
  const mac = createHmac("sha1", Buffer.from(key)).update(msg).digest();
  const o = mac[mac.length - 1] & 15;
  const bin = ((mac[o] & 0x7f) << 24) | (mac[o + 1] << 16) | (mac[o + 2] << 8) | mac[o + 3];
  return String(bin % 1_000_000).padStart(6, "0");
}
const named = (res, name) => cookieOf(res).find((c) => c.startsWith(`${name}=`));
async function passwordLogin() {
  const res = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
  return { res, data: await res.json(), session: named(res, "wallet_session"), mfa: named(res, "wallet_mfa") };
}
async function verify(mfaCookie, code) {
  const res = await fetch(`${BASE}/api/auth/mfa/verify`, { method: "POST", headers: { "content-type": "application/json", cookie: mfaCookie ?? "" }, body: JSON.stringify({ code }) });
  return { status: res.status, session: named(res, "wallet_session") };
}


/** Play the browser: start, then come back from Google with the given claims. Returns {location, cookies}. */
async function googleSignIn(claims, { tamperState = false } = {}) {
  const start = await fetch(`${BASE}/api/auth/google/start`, nohtml);
  const url = new URL(start.headers.get("location"));
  const stateCookie = cookieOf(start).find((c) => c.startsWith("wallet_google="));
  const nonce = url.searchParams.get("nonce");
  const code = Buffer.from(JSON.stringify({ nonce, ...claims })).toString("base64url");
  const back = await fetch(`${BASE}/api/auth/google/callback?code=${code}&state=${tamperState ? "wrong" : url.searchParams.get("state")}`, { ...nohtml, headers: { cookie: stateCookie ?? "" } });
  return { location: back.headers.get("location"), cookies: cookieOf(back).filter((c) => c.startsWith("wallet_session=")), status: back.status };
}

const call = (cookie) => async (method, path, body) => {
  const res = await fetch(`${BASE}/api${path}`, { method, headers: { cookie, "content-type": "application/json", origin: BASE }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};

try {
  const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
  const owner = call(cookieOf(login)[0]);
  const me = await (await fetch(`${BASE}/api/auth/me`)).json();
  check("Google is configured locally", me.google_configured === true, JSON.stringify(me));

  // Clean slate for the test person.
  const email = `newcomer${Date.now()}@example.test`;
  const claims = { sub: `sub-${Date.now()}`, email, name: "New Comer" };

  // 1. Sign-ups closed by default.
  await owner("PUT", "/admin/registration", { open: false });
  check("closed registration refuses a stranger", (await googleSignIn(claims)).location === "/?auth=closed");
  check("nobody was created", sql(`SELECT COUNT(*) n FROM users WHERE email = '${email}'`)[0].n === 0);

  // 2. Open: stranger becomes a pending request and gets no session.
  await owner("PUT", "/admin/registration", { open: true });
  const first = await googleSignIn(claims);
  check("open registration creates a waiting request", first.location === "/?auth=pending" && first.cookies.length === 0, JSON.stringify(first));
  const row = sql(`SELECT id, status, role FROM users WHERE email = '${email}'`)[0];
  check("the request is pending and not an admin", row?.status === "pending" && row?.role === "user");
  const again = await googleSignIn(claims);
  check("asking again does not create a second request or a session", again.location === "/?auth=pending" && sql(`SELECT COUNT(*) n FROM users WHERE email = '${email}'`)[0].n === 1 && again.cookies.length === 0);

  // 3. Bad callbacks.
  check("a tampered state is refused", (await googleSignIn({ sub: "x", email: "x@example.test" }, { tamperState: true })).location === "/?auth=error");
  check("an unverified email is refused", (await googleSignIn({ sub: "y", email: "y@example.test", email_verified: false })).location === "/?auth=error");
  check("a callback without a cookie is refused", (await fetch(`${BASE}/api/auth/google/callback?code=abc&state=zzz`, nohtml)).headers.get("location") === "/?auth=error");

  // 4. Admin sees it and approves.
  const list = await owner("GET", "/admin/users");
  check("admin sees the pending request first", list.data.users[0]?.email === email && list.data.users[0].status === "pending");
  const boot = await owner("GET", "/bootstrap");
  check("bootstrap shows the pending count to the admin", boot.data.counts.pending_users >= 1 && boot.data.user.role === "admin");
  check("admin approves", (await owner("POST", `/admin/users/${row.id}/approve`)).status === 200);

  // 5. Approved person signs in and only sees their own, freshly set-up data.
  const ok = await googleSignIn(claims);
  check("approved person gets a session", ok.location === "/" && ok.cookies.length === 1, JSON.stringify(ok));
  const person = call(ok.cookies[0]);
  const pb = await person("GET", "/bootstrap");
  check("they get their own default categories and cash wallet", pb.status === 200 && pb.data.categories.length > 50 && pb.data.accounts.length === 1 && pb.data.user.email === email);
  check("they are not an admin: no admin API, no pending count", (await person("GET", "/admin/users")).status === 403 && pb.data.counts.pending_users === 0);
  check("they cannot change sign-up settings", (await person("PUT", "/admin/registration", { open: false })).status === 403);
  check("they cannot approve anyone", (await person("POST", "/admin/users/1/approve")).status === 403);
  check("the owner has none of their data", (await owner("GET", "/transactions?limit=1")).data.items.every((t) => t.user_id !== row.id));

  // 6. Disable / enable.
  check("admin cannot change the owner account", (await owner("POST", "/admin/users/1/disable")).status === 400);
  await owner("POST", `/admin/users/${row.id}/disable`);
  check("disabled person's session stops working", (await person("GET", "/accounts")).status === 401);
  check("disabled person cannot sign in again", (await googleSignIn(claims)).location === "/?auth=disabled");
  await owner("POST", `/admin/users/${row.id}/enable`);
  check("enabled again, they can sign in", (await googleSignIn(claims)).location === "/");

  // 7. Reject removes a request; delete removes a user and their data.
  const claims2 = { sub: `sub2-${Date.now()}`, email: `second${Date.now()}@example.test`, name: "Second" };
  await googleSignIn(claims2);
  const second = sql(`SELECT id FROM users WHERE email = '${claims2.email}'`)[0];
  check("admin rejects a request", (await owner("POST", `/admin/users/${second.id}/reject`)).status === 200 && sql(`SELECT COUNT(*) n FROM users WHERE id = ${second.id}`)[0].n === 0);
  check("admin deletes a user and their data", (await owner("DELETE", `/admin/users/${row.id}`)).status === 200 && sql(`SELECT (SELECT COUNT(*) FROM users WHERE id = ${row.id}) + (SELECT COUNT(*) FROM categories WHERE user_id = ${row.id}) + (SELECT COUNT(*) FROM accounts WHERE user_id = ${row.id}) + (SELECT COUNT(*) FROM user_settings WHERE user_id = ${row.id}) n`)[0].n === 0);

  // 8. Link flow for the owner.
  const startLink = await fetch(`${BASE}/api/auth/google/link`, { ...nohtml, headers: { cookie: cookieOf(login)[0] } });
  const lurl = new URL(startLink.headers.get("location"));
  const lcookie = cookieOf(startLink).find((c) => c.startsWith("wallet_google="));
  const ownerEmail = `owner${Date.now()}@example.test`;
  const lcode = Buffer.from(JSON.stringify({ nonce: lurl.searchParams.get("nonce"), sub: `owner-${Date.now()}`, email: ownerEmail, name: "Owner Person" })).toString("base64url");
  const linked = await fetch(`${BASE}/api/auth/google/callback?code=${lcode}&state=${lurl.searchParams.get("state")}`, { ...nohtml, headers: { cookie: lcookie } });
  check("the owner can link their Google account", linked.headers.get("location") === "/settings?google=linked" && sql("SELECT email FROM users WHERE id = 1")[0].email === ownerEmail);
  const viaGoogle = await googleSignIn({ sub: sql("SELECT google_sub s FROM users WHERE id = 1")[0].s, email: ownerEmail, name: "Owner Person" });
  check("the owner then signs in with Google as the same account", viaGoogle.location === "/" && viaGoogle.cookies.length === 1);
  sql("UPDATE users SET email = NULL, google_sub = NULL, name = 'Owner' WHERE id = 1");


  // ===== Two-step verification =====
  sql("DELETE FROM login_attempts");
  const sec0 = (await owner("GET", "/bootstrap")).data.security;
  check("MFA starts off and not skipped", sec0.enabled === false && sec0.skipped === false, JSON.stringify(sec0));
  const setup = await owner("POST", "/auth/mfa/setup");
  check("setup returns a secret and an otpauth link", /^[A-Z2-7]{32}$/.test(setup.data.secret) && setup.data.uri.startsWith("otpauth://totp/"), JSON.stringify(setup.data));
  check("a wrong confirmation code is refused", (await owner("POST", "/auth/mfa/confirm", { code: "000000" })).status === 400);
  const confirm = await owner("POST", "/auth/mfa/confirm", { code: totp(setup.data.secret) });
  const recovery = confirm.data.recovery_codes ?? [];
  check("confirming turns MFA on and returns 8 recovery codes", confirm.status === 200 && recovery.length === 8 && recovery.every((c) => /^[0-9a-f]{5}-[0-9a-f]{5}$/.test(c)), JSON.stringify(confirm.data));
  const stored = sql("SELECT value FROM user_settings WHERE user_id = 1 AND key = 'totp_secret'")[0]?.value ?? "";
  check("the secret is stored encrypted", stored.startsWith("enc1:") && !stored.includes(setup.data.secret));
  check("recovery codes are stored hashed", !sql("SELECT value FROM user_settings WHERE user_id = 1 AND key = 'recovery_codes'")[0].value.includes(recovery[0].slice(0, 5)));
  check("status shows 8 codes left", (await owner("GET", "/auth/mfa")).data.recovery_remaining === 8);
  check("setup is refused while MFA is on", (await owner("POST", "/auth/mfa/setup")).status === 400);

  const l1 = await passwordLogin();
  check("password login now asks for a code and gives no session", l1.data.mfa_required === true && !l1.session && l1.mfa, JSON.stringify(l1.data));
  check("without the code step there is no access", (await fetch(`${BASE}/api/accounts`, { headers: { cookie: l1.mfa } })).status === 401);
  check("verify without the password step is refused", (await verify(undefined, totp(setup.data.secret, 1))).status === 401);
  check("a wrong code is refused", (await verify(l1.mfa, "123456")).status === 401);
  check("a forged password-step cookie is refused", (await verify("wallet_mfa=eyJ1IjoxfQ.AAAA", totp(setup.data.secret, 1))).status === 401);
  const sameStep = await verify(l1.mfa, totp(setup.data.secret));
  check("the code used to turn MFA on cannot be used again", sameStep.status === 401);
  const next = await verify(l1.mfa, totp(setup.data.secret, 1));
  check("the next code signs in", next.status === 200 && next.session, JSON.stringify(next));
  check("that code cannot be replayed", (await verify(l1.mfa, totp(setup.data.secret, 1))).status === 401);
  check("the new session works", (await call(next.session)("GET", "/accounts")).status === 200);

  const l2 = await passwordLogin();
  const byRecovery = await verify(l2.mfa, recovery[0].toUpperCase());
  check("a recovery code signs in (any letter case)", byRecovery.status === 200 && byRecovery.session);
  check("a recovery code works only once", (await verify((await passwordLogin()).mfa, recovery[0])).status === 401);
  const ownerAfter = call(byRecovery.session);
  check("status shows 7 codes left", (await ownerAfter("GET", "/auth/mfa")).data.recovery_remaining === 7);

  // Google users go through the same step.
  const mfaClaims = { sub: `mfa-${Date.now()}`, email: `mfauser${Date.now()}@example.test`, name: "Mfa User" };
  await owner("PUT", "/admin/registration", { open: true });
  await googleSignIn(mfaClaims);
  const mfaRow = sql(`SELECT id FROM users WHERE email = '${mfaClaims.email}'`)[0];
  await owner("POST", `/admin/users/${mfaRow.id}/approve`);
  const gUser = call((await googleSignIn(mfaClaims)).cookies[0]);
  const gSetup = await gUser("POST", "/auth/mfa/setup");
  const gConfirm = await gUser("POST", "/auth/mfa/confirm", { code: totp(gSetup.data.secret) });
  const gStart = await fetch(`${BASE}/api/auth/google/start`, nohtml);
  const gUrl = new URL(gStart.headers.get("location"));
  const gCode = Buffer.from(JSON.stringify({ nonce: gUrl.searchParams.get("nonce"), ...mfaClaims })).toString("base64url");
  const gBack = await fetch(`${BASE}/api/auth/google/callback?code=${gCode}&state=${gUrl.searchParams.get("state")}`, { ...nohtml, headers: { cookie: named(gStart, "wallet_google") } });
  check("a Google user with MFA is sent to the code step, without a session", gBack.headers.get("location") === "/?auth=mfa" && !named(gBack, "wallet_session") && named(gBack, "wallet_mfa"));
  const gDone = await verify(named(gBack, "wallet_mfa"), gConfirm.data.recovery_codes[0]);
  check("their code finishes the sign-in as that user", gDone.status === 200 && (await call(gDone.session)("GET", "/bootstrap")).data.user.email === mfaClaims.email);
  check("a code for one user does not open another account", (await verify(named(gBack, "wallet_mfa"), recovery[1])).status === 401);
  await owner("DELETE", `/admin/users/${mfaRow.id}`);
  await owner("PUT", "/admin/registration", { open: false });

  // Lockout after repeated wrong codes.
  sql("DELETE FROM login_attempts");
  const l3 = await passwordLogin();
  let last = 0;
  for (let i = 0; i < 6; i++) last = (await verify(l3.mfa, "000000")).status;
  check("5 wrong codes lock the account's code step", last === 429, String(last));
  check("even the right code is refused while locked", (await verify(l3.mfa, recovery[2])).status === 429);
  sql("DELETE FROM login_attempts");

  // Regenerate, skip, disable.
  check("new recovery codes need a valid code", (await ownerAfter("POST", "/auth/mfa/recovery-codes", { code: "000000" })).status === 400);
  const regen = await ownerAfter("POST", "/auth/mfa/recovery-codes", { code: recovery[3] });
  check("new recovery codes replace the old ones", regen.status === 200 && regen.data.recovery_codes.length === 8 && (await ownerAfter("GET", "/auth/mfa")).data.recovery_remaining === 8);
  check("an old recovery code no longer works", (await verify((await passwordLogin()).mfa, recovery[4])).status === 401);
  check("turning MFA off needs a valid code", (await ownerAfter("POST", "/auth/mfa/disable", { code: "000000" })).status === 400);
  check("turning MFA off works with a recovery code", (await ownerAfter("POST", "/auth/mfa/disable", { code: regen.data.recovery_codes[0] })).status === 200);
  const l4 = await passwordLogin();
  check("with MFA off, password login gives a session again", l4.data.ok === true && l4.session);
  await call(l4.session)("POST", "/auth/mfa/skip");
  check("skipping is remembered", (await call(l4.session)("GET", "/bootstrap")).data.security.skipped === true);
  sql("DELETE FROM user_settings WHERE user_id = 1 AND key IN ('mfa_skipped', 'totp_secret', 'totp_pending_secret', 'totp_last_step', 'recovery_codes')");

  // 9. The password login still works.
  check("the owner password still works", (await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) })).status === 200);
  await owner("PUT", "/admin/registration", { open: false });
} finally {
  mock.close();
}
console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll sign-in checks passed");
process.exit(failures ? 1 : 0);
