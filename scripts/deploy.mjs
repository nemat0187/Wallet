#!/usr/bin/env node
// One-command deployment to Cloudflare (used by the "Deploy" GitHub Action).
//
// 1. Creates the D1 database "wallet-db" the first time.
// 2. Applies database migrations.
// 3. Deploys the Worker + web app.
// 4. Stores secrets (password, API keys) in Cloudflare.
//
// Needs: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, APP_PASSWORD
// Optional: APP_ORIGINS (origins of a phone app shell allowed to call the API), ANTHROPIC_API_KEY (owner-only fallback; people add their own AI keys in the app), TELEGRAM_BOT_TOKEN, ANTHROPIC_BASE_URL, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const DB_NAME = "wallet-db";
const PLACEHOLDER = "00000000-0000-0000-0000-000000000000";
const GENERATED = "wrangler.generated.jsonc";
const SECRETS_FILE = "secrets.generated.json";

function fail(message) {
  console.error(`\n❌ ${message}\n`);
  process.exit(1);
}

function wrangler(args, { capture = false } = {}) {
  console.log(`\n$ wrangler ${args.join(" ")}`);
  const out = execFileSync("npx", ["wrangler", ...args], {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    env: { ...process.env, CI: "true" },
  });
  return out ?? "";
}

function summary(markdown) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}

// --- Check configuration -----------------------------------------------------
const missing = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "APP_PASSWORD"].filter((k) => !process.env[k]);
if (missing.length) {
  const msg = `These GitHub secrets are missing: ${missing.join(", ")}. Add them under Settings → Secrets and variables → Actions (see docs/SETUP.md, step 3).`;
  summary(`### ⚠️ Not deployed\n\n${msg}`);
  // Automatic runs (on push) skip quietly until setup is done; manual runs fail loudly.
  if (process.env.GITHUB_EVENT_NAME === "push") {
    console.log(msg);
    process.exit(0);
  }
  fail(msg);
}
if (process.env.APP_PASSWORD.length < 10) {
  console.warn("⚠️  APP_PASSWORD is shorter than 10 characters. A longer password is much safer.");
}
if (!existsSync("dist/index.html")) fail("The web app isn't built yet. Run `npm run build` first.");

// --- 1. Database --------------------------------------------------------------
function findDatabase() {
  const list = JSON.parse(wrangler(["d1", "list", "--json"], { capture: true }) || "[]");
  return list.find((db) => db.name === DB_NAME);
}
let db = findDatabase();
if (!db) {
  console.log(`Creating database ${DB_NAME}…`);
  // "eeur" (Eastern Europe) is the closest region to Baku.
  wrangler(["d1", "create", DB_NAME, "--location", "eeur", "--update-config=false"]);
  db = findDatabase();
}
if (!db?.uuid) fail(`Couldn't find or create the D1 database "${DB_NAME}". Check that the API token has the "D1: Edit" permission.`);
console.log(`Using database ${DB_NAME} (${db.uuid})`);

const config = readFileSync("wrangler.jsonc", "utf8");
if (!config.includes(PLACEHOLDER)) fail("wrangler.jsonc no longer contains the database id placeholder.");
writeFileSync(GENERATED, config.replace(PLACEHOLDER, db.uuid));

try {
  // --- 2. Migrations -----------------------------------------------------------
  wrangler(["d1", "migrations", "apply", "DB", "--remote", "--config", GENERATED]);

  // --- 3. Deploy ---------------------------------------------------------------
  const output = wrangler(["deploy", "--config", GENERATED], { capture: true });
  process.stdout.write(output);
  const url = output.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i)?.[0];

  // --- 4. Secrets --------------------------------------------------------------
  const secrets = {};
  for (const key of ["APP_PASSWORD", "ANTHROPIC_API_KEY", "TELEGRAM_BOT_TOKEN", "ANTHROPIC_BASE_URL", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "APP_ORIGINS"]) {
    if (process.env[key]) secrets[key] = process.env[key];
  }
  // The encryption key is created once and never replaced: everything encrypted with it (two-step secrets, later
  // AI keys) would become unreadable. If the list of existing secrets can't be read, no key is created this time.
  try {
    const existing = JSON.parse(wrangler(["secret", "list", "--format", "json", "--config", GENERATED], { capture: true }));
    if (!existing.some((x) => x.name === "ENCRYPTION_KEY")) {
      secrets.ENCRYPTION_KEY = randomBytes(32).toString("base64");
      console.log("Created the app's encryption key (first deploy with this feature).");
    }
  } catch (e) {
    console.warn("Could not check for the encryption key, leaving it as it is:", e.message);
  }
  writeFileSync(SECRETS_FILE, JSON.stringify(secrets), { mode: 0o600 });
  try {
    wrangler(["secret", "bulk", SECRETS_FILE, "--config", GENERATED]);
  } finally {
    rmSync(SECRETS_FILE, { force: true });
  }

  const enabled = [
    "✅ Password login",
    process.env.ANTHROPIC_API_KEY ? "✅ AI (owner key; everyone else adds theirs in Settings → AI)" : "➖ AI — each person adds their own key in Settings → AI",
    process.env.TELEGRAM_BOT_TOKEN ? "✅ Telegram bot" : "➖ Telegram — optional, add TELEGRAM_BOT_TOKEN",
    process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET ? "✅ Sign in with Google" : "➖ Google sign-in — optional, add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET",
  ];
  console.log(`\n🎉 Deployed${url ? `: ${url}` : ""}\n${enabled.join("\n")}`);
  summary(
    `### 🎉 Wallet is live\n\n${url ? `**Open:** ${url}\n\n` : "Find the address in Cloudflare → Workers & Pages → wallet.\n\n"}${enabled.map((e) => `- ${e}`).join("\n")}`,
  );
} finally {
  rmSync(GENERATED, { force: true });
}
