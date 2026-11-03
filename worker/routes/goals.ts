// Savings goals.

import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import type { Goal } from "@shared/goals";
import { body, intParam, notFound } from "../lib/http";
import { all, first, insert, nowIso, run } from "../lib/db";

const app = new Hono<AppEnv>();

const GoalInput = z.object({
  name: z.string().trim().min(1).max(80),
  target: z.number().int().min(1).max(100_000_000_000),
  deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
});

app.get("/", async (c) => c.json(await all<Goal>(c.env.DB, "SELECT id, name, target, saved, deadline, created_at, updated_at FROM goals ORDER BY (saved >= target), COALESCE(deadline, '9999'), id LIMIT 200")));

app.post("/", async (c) => {
  const g = await body(c, GoalInput.extend({ saved: z.number().int().min(0).default(0) }));
  const now = nowIso();
  const id = await insert(c.env.DB, "INSERT INTO goals (name, target, saved, deadline, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", g.name, g.target, g.saved, g.deadline, now, now);
  return c.json({ id });
});

app.put("/:id", async (c) => {
  const id = intParam(c, "id");
  const g = await body(c, GoalInput);
  if (!(await first(c.env.DB, "SELECT id FROM goals WHERE id = ?", id))) notFound();
  await run(c.env.DB, "UPDATE goals SET name = ?, target = ?, deadline = ?, updated_at = ? WHERE id = ?", g.name, g.target, g.deadline, nowIso(), id);
  return c.json({ ok: true });
});

/** Put money aside (positive) or take some back (negative). */
app.post("/:id/contribute", async (c) => {
  const id = intParam(c, "id");
  const { amount } = await body(c, z.object({ amount: z.number().int().min(-100_000_000_000).max(100_000_000_000) }));
  const row = await first<{ saved: number }>(c.env.DB, "SELECT saved FROM goals WHERE id = ?", id);
  if (!row) notFound();
  const saved = Math.max(0, row.saved + amount);
  await run(c.env.DB, "UPDATE goals SET saved = ?, updated_at = ? WHERE id = ?", saved, nowIso(), id);
  return c.json({ saved });
});

app.delete("/:id", async (c) => {
  await run(c.env.DB, "DELETE FROM goals WHERE id = ?", intParam(c, "id"));
  return c.json({ ok: true });
});

export default app;
