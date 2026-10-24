#!/usr/bin/env node
// One-command deployment to Cloudflare (used by the "Deploy" GitHub Action).
//
// 1. Creates the D1 database "wallet-db" the first time.
// 2. Applies database migrations.
// 3. Deploys the Worker + web app.
// 4. Stores secrets (password, API keys) in Cloudflare.
//
// Needs: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, APP_PASSWORD
// Optional: ANTHROPIC_API_KEY, TELEGRAM_BOT_TOKEN, ANTHROPIC_BASE_URL

import { execFileSync } from "node:child_process";
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
  for (const key of ["APP_PASSWORD", "ANTHROPIC_API_KEY", "TELEGRAM_BOT_TOKEN", "ANTHROPIC_BASE_URL"]) {
    if (process.env[key]) secrets[key] = process.env[key];
  }
  writeFileSync(SECRETS_FILE, JSON.stringify(secrets), { mode: 0o600 });
  try {
    wrangler(["secret", "bulk", SECRETS_FILE, "--config", GENERATED]);
  } finally {
    rmSync(SECRETS_FILE, { force: true });
  }

  const enabled = [
    "✅ Password login",
    process.env.ANTHROPIC_API_KEY ? "✅ AI (Claude)" : "➖ AI — add ANTHROPIC_API_KEY to enable",
    process.env.TELEGRAM_BOT_TOKEN ? "✅ Telegram bot" : "➖ Telegram — optional, add TELEGRAM_BOT_TOKEN",
  ];
  console.log(`\n🎉 Deployed${url ? `: ${url}` : ""}\n${enabled.join("\n")}`);
  summary(
    `### 🎉 Wallet is live\n\n${url ? `**Open:** ${url}\n\n` : "Find the address in Cloudflare → Workers & Pages → wallet.\n\n"}${enabled.map((e) => `- ${e}`).join("\n")}`,
  );
} finally {
  rmSync(GENERATED, { force: true });
}
