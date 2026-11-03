// The owner's own notes (free text, optional "- [ ]" checklist lines).

import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { body, intParam, notFound } from "../lib/http";
import { all, first, insert, nowIso, run } from "../lib/db";

const app = new Hono<AppEnv>();

const NoteInput = z.object({
  title: z.string().max(120).default(""),
  body: z.string().max(20000).default(""),
  pinned: z.boolean().default(false),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
});

interface Row {
  id: number;
  title: string;
  body: string;
  pinned: number;
  color: string | null;
  created_at: string;
  updated_at: string;
}
const decode = (r: Row) => ({ ...r, pinned: Boolean(r.pinned) });

app.get("/", async (c) => c.json((await all<Row>(c.env.DB, "SELECT * FROM notes ORDER BY pinned DESC, updated_at DESC, id DESC LIMIT 500")).map(decode)));

app.post("/", async (c) => {
  const n = await body(c, NoteInput);
  const now = nowIso();
  const id = await insert(
    c.env.DB,
    "INSERT INTO notes (title, body, pinned, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    n.title.trim(),
    n.body,
    n.pinned ? 1 : 0,
    n.color ?? null,
    now,
    now,
  );
  return c.json({ id });
});

app.put("/:id", async (c) => {
  const id = intParam(c, "id");
  const n = await body(c, NoteInput);
  if (!(await first(c.env.DB, "SELECT id FROM notes WHERE id = ?", id))) notFound();
  await run(c.env.DB, "UPDATE notes SET title = ?, body = ?, pinned = ?, color = ?, updated_at = ? WHERE id = ?", n.title.trim(), n.body, n.pinned ? 1 : 0, n.color ?? null, nowIso(), id);
  return c.json({ ok: true });
});

app.delete("/:id", async (c) => {
  await run(c.env.DB, "DELETE FROM notes WHERE id = ?", intParam(c, "id"));
  return c.json({ ok: true });
});

export default app;
