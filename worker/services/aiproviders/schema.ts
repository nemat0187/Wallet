// Turning the app's zod schemas into what ChatGPT and Gemini understand, and reading JSON back out of their answers.

import { z } from "zod";

type Json = Record<string, unknown>;

/** JSON Schema for a zod schema, without the `$schema` marker. */
export function jsonSchemaOf(schema: z.ZodType): Json {
  const js = z.toJSONSchema(schema, { target: "draft-7", unrepresentable: "any" }) as Json;
  delete js.$schema;
  return js;
}

/** Appended to the instructions when a provider is asked for JSON in plain "JSON mode". */
export function schemaInstruction(schema: z.ZodType): string {
  return [
    "Reply with a single JSON object and nothing else: no explanations, no code fences.",
    "It must match this JSON Schema exactly (use null for unknown optional values):",
    JSON.stringify(jsonSchemaOf(schema)),
  ].join("\n");
}

/** The JSON inside a model's text answer (tolerates code fences and a sentence before or after). */
export function extractJson(text: string): unknown {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    const a = cleaned.indexOf("{");
    const b = cleaned.lastIndexOf("}");
    if (a !== -1 && b > a) return JSON.parse(cleaned.slice(a, b + 1));
    throw new Error("The answer contained no JSON");
  }
}

export function validate<T extends z.ZodType>(schema: T, text: string): { ok: true; data: z.infer<T> } | { ok: false; error: string } {
  try {
    const r = schema.safeParse(extractJson(text));
    if (r.success) return { ok: true, data: r.data };
    return { ok: false, error: r.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ") };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * Gemini accepts only an OpenAPI-like subset: nullable instead of anyOf-with-null, no additionalProperties, no
 * defaults, no formats. Everything else is kept (type, description, enum, properties, required, items, limits).
 */
export function toGeminiSchema(node: unknown): Json {
  if (!node || typeof node !== "object") return {};
  const src = node as Json;
  const out: Json = {};

  // anyOf [X, null] -> X + nullable
  const variants = (src.anyOf ?? src.oneOf) as Json[] | undefined;
  if (Array.isArray(variants)) {
    const real = variants.filter((v) => v.type !== "null");
    const nullable = real.length !== variants.length;
    const base = real.length === 1 ? toGeminiSchema(real[0]) : real.length > 1 ? { type: "string" } : { type: "string" };
    if (nullable) base.nullable = true;
    if (typeof src.description === "string") base.description = src.description;
    return base;
  }

  let type = src.type;
  if (Array.isArray(type)) {
    if (type.includes("null")) out.nullable = true;
    type = type.find((t) => t !== "null") ?? "string";
  }
  if (typeof type === "string") out.type = type;
  if (typeof src.description === "string") out.description = src.description;
  if (Array.isArray(src.enum)) out.enum = (src.enum as unknown[]).filter((v) => v !== null);
  if (src.const !== undefined && src.const !== null) out.enum = [src.const];
  for (const k of ["minItems", "maxItems", "minimum", "maximum"]) if (typeof src[k] === "number") out[k] = src[k];
  if (src.properties && typeof src.properties === "object") {
    out.properties = Object.fromEntries(Object.entries(src.properties as Json).map(([k, v]) => [k, toGeminiSchema(v)]));
    out.type ??= "object";
  }
  if (Array.isArray(src.required) && src.required.length) out.required = src.required;
  if (src.items) out.items = toGeminiSchema(src.items);
  return out;
}
