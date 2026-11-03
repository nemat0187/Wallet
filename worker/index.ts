// Worker entry point: JSON API under /api/*, static web app for everything else
// (served by Cloudflare's asset handling before this code runs), plus the
// hourly cron job.

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv, Env } from "./env";
import { validateSession } from "./auth/session";
import { forUser } from "./lib/scoped";
import { ensureSeeded } from "./services/seed";
import { runScheduled } from "./services/cron";
import authRoutes from "./routes/auth";
import ingestRoutes, { publicIngest } from "./routes/ingest";
import transactionRoutes from "./routes/transactions";
import catalogRoutes from "./routes/catalog";
import accountRoutes from "./routes/accounts";
import budgetRoutes from "./routes/budgets";
import analyticsRoutes from "./routes/analytics";
import aiRoutes from "./routes/ai";
import importRoutes from "./routes/imports";
import settingsRoutes, { telegramWebhook } from "./routes/settings";
import dashboardRoutes from "./routes/dashboards";
import noteRoutes from "./routes/notes";
import { ProviderError } from "./services/aiproviders/types";
import adminRoutes from "./routes/admin";

const app = new Hono<AppEnv>();

app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  // A problem with the person's AI provider: say what happened (400 when they can fix it, 502 for an outage).
  if (err instanceof ProviderError) return c.json({ error: err.message }, err.userFixable ? 400 : 502);
  console.error(err);
  return c.json({ error: "Something went wrong on the server. Please try again." }, 500);
});

// Security headers for every API response.
app.use("/api/*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Frame-Options", "DENY");
});

app.get("/api/health", (c) => c.json({ ok: true }));

// Endpoints that authenticate themselves (phone webhook token, Telegram secret, login form).
app.route("/api/ingest", publicIngest);
app.route("/api/telegram", telegramWebhook);
app.route("/api/auth", authRoutes);

// Everything else requires a signed-in user. Mutations must come from this site.
app.use("/api/*", async (c, next) => {
  const session = await validateSession(c);
  if (!session) throw new HTTPException(401, { message: "Please log in" });
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    const origin = c.req.header("origin");
    if (origin && origin !== new URL(c.req.url).origin) throw new HTTPException(403, { message: "Cross-site request blocked" });
  }
  c.set("sessionHash", session.hash);
  c.set("userId", session.userId);
  c.set("role", session.role);
  // From here on every route sees only this user's rows (worker/lib/scoped.ts).
  c.env = forUser(c.env, session.userId);
  await ensureSeeded(c.env.DB);
  await next();
});

app.route("/api/messages", ingestRoutes);
app.route("/api/transactions", transactionRoutes);
app.route("/api", catalogRoutes);
app.route("/api/accounts", accountRoutes);
app.route("/api/budgets", budgetRoutes);
app.route("/api/analytics", analyticsRoutes);
app.route("/api/dashboards", dashboardRoutes);
app.route("/api/notes", noteRoutes);
app.route("/api/admin", adminRoutes);
app.route("/api/ai", aiRoutes);
app.route("/api/import", importRoutes);
app.route("/api", settingsRoutes);

app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduled(env, new Date(controller.scheduledTime)));
  },
} satisfies ExportedHandler<Env>;
