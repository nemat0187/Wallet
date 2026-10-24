import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { z } from "zod";

/** Parse and validate a JSON body; responds 400 with a readable message on failure. */
export async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let data: unknown;
  try {
    data = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Request body must be JSON" });
  }
  const result = schema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new HTTPException(400, { message: `${issue.path.join(".") || "body"}: ${issue.message}` });
  }
  return result.data;
}

export function badRequest(message: string): never {
  throw new HTTPException(400, { message });
}

export function notFound(message = "Not found"): never {
  throw new HTTPException(404, { message });
}

export function intParam(c: Context, name: string): number {
  const n = Number(c.req.param(name));
  if (!Number.isInteger(n) || n <= 0) badRequest(`Invalid ${name}`);
  return n;
}
