import { Hono } from "hono";
import type { AppEnv } from "../env";
import { addDays, periodFor } from "@shared/money";
import { anomalies, categoryReport, dashboard, heatmap, merchantReport, recurring, today, trends } from "../services/analytics";
import { getSettings } from "../services/settings";

const app = new Hono<AppEnv>();

/** Resolve ?from=&to= (defaults to the current budget period). */
async function range(c: { env: AppEnv["Bindings"]; req: { query: (k: string) => string | undefined } }) {
  const settings = await getSettings(c.env);
  const now = today(settings);
  const p = periodFor(now, settings.month_start_day);
  return { from: c.req.query("from") ?? p.start, to: c.req.query("to") ?? now };
}

app.get("/dashboard", async (c) => c.json(await dashboard(c.env, c.req.query("date"))));
app.get("/trends", async (c) => c.json(await trends(c.env, Math.min(Number(c.req.query("periods")) || 12, 36))));
app.get("/categories", async (c) => {
  const { from, to } = await range(c);
  return c.json(await categoryReport(c.env, from, to));
});
app.get("/merchants", async (c) => {
  const { from, to } = await range(c);
  return c.json(await merchantReport(c.env, from, to));
});
app.get("/heatmap", async (c) => {
  const settings = await getSettings(c.env);
  const now = today(settings);
  return c.json(await heatmap(c.env, c.req.query("from") ?? addDays(now, -90), c.req.query("to") ?? now));
});
app.get("/recurring", async (c) => c.json(await recurring(c.env)));
app.get("/anomalies", async (c) => {
  const { from, to } = await range(c);
  return c.json(await anomalies(c.env, from, to));
});

export default app;
