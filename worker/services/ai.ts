// Claude integration: one place for the client, model choice, cost tracking and
// the monthly spending cap. Every call records its token usage so the app can
// show exactly what AI costs and stop before the cap is reached.

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import type { Env } from "../env";
import type { Settings } from "@shared/types";
import { first, insert, nowIso } from "../lib/db";
import { getSettings } from "./settings";

/** USD per million tokens (input, output, cache read, cache write). */
const PRICING: Record<string, [number, number, number, number]> = {
  "claude-haiku-5-5": [0.1, 0.5, 0.01, 0.125],
  "claude-sonnet-5-5": [2, 10, 0.2, 2.5],
  "claude-opus-5-5": [4, 20, 0.2, 5],
  "claude-opus-5": [5, 25, 0.5, 6.25],
  "claude-opus-4-8": [5, 25, 0.5, 6.25],
};

/** Models that accept server-side refusal fallbacks (`fallbacks: "default"`). */
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5"]);

export type Effort = "low" | "medium" | "high";

export interface UsageLike {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export function costUsd(model: string, u: UsageLike): number {
  const [pin, pout, pread, pwrite] = PRICING[model] ?? PRICING["claude-opus-5"];
  return (
    (u.input_tokens * pin +
      u.output_tokens * pout +
      (u.cache_read_input_tokens ?? 0) * pread +
      (u.cache_creation_input_tokens ?? 0) * pwrite) /
    1_000_000
  );
}

export async function recordUsage(db: D1Database, purpose: string, model: string, u: UsageLike): Promise<number> {
  const cost = costUsd(model, u);
  const now = nowIso();
  await insert(
    db,
    `INSERT INTO ai_usage (created_at, month, purpose, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    now,
    now.slice(0, 7),
    purpose,
    model,
    u.input_tokens,
    u.output_tokens,
    u.cache_read_input_tokens ?? 0,
    u.cache_creation_input_tokens ?? 0,
    cost,
  );
  return cost;
}

export async function monthSpend(db: D1Database): Promise<number> {
  const row = await first<{ total: number | null }>(
    db,
    "SELECT SUM(cost_usd) AS total FROM ai_usage WHERE month = ?",
    nowIso().slice(0, 7),
  );
  return row?.total ?? 0;
}

export type AiUnavailableReason = "no_key" | "disabled" | "cap_reached";

/** Why AI cannot be used right now, or null if it can. */
export async function aiBlocked(env: Env, settings?: Settings): Promise<AiUnavailableReason | null> {
  if (!env.ANTHROPIC_API_KEY) return "no_key";
  const s = settings ?? (await getSettings(env));
  if (!s.ai_enabled) return "disabled";
  if ((await monthSpend(env.DB)) >= s.ai_monthly_cap_usd) return "cap_reached";
  return null;
}

export function aiClient(env: Env): Anthropic {
  return new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    baseURL: env.ANTHROPIC_BASE_URL || undefined,
    maxRetries: 2,
    timeout: 120_000,
  });
}

/** Extra request fields that enable server-side refusal fallbacks where the model supports them. */
export function fallbackParams(model: string): { betas?: Anthropic.Beta.AnthropicBeta[]; fallbacks?: "default" } {
  return FALLBACK_MODELS.has(model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {};
}

export interface StructuredCall<T extends z.ZodType> {
  purpose: string;
  model: string;
  system: string;
  content: string | Anthropic.Beta.BetaContentBlockParam[];
  schema: T;
  maxTokens?: number;
  effort?: Effort;
  timeoutMs?: number;
}

/**
 * One request that must come back as JSON matching `schema` (structured outputs).
 * `data` is null when the model declines; throws on API errors.
 */
export async function structuredCall<T extends z.ZodType>(
  env: Env,
  call: StructuredCall<T>,
): Promise<{ data: z.infer<T> | null; cost: number; model: string }> {
  const client = aiClient(env);
  const res = await client.beta.messages.parse({
    model: call.model,
    max_tokens: call.maxTokens ?? 8000,
    system: call.system,
    messages: [{ role: "user", content: call.content }],
    output_config: { format: betaZodOutputFormat(call.schema), effort: call.effort ?? "low" },
    ...fallbackParams(call.model),
  }, call.timeoutMs ? { timeout: call.timeoutMs } : undefined);
  const model = res.model ?? call.model;
  const cost = await recordUsage(env.DB, call.purpose, model, res.usage);
  const ok = res.stop_reason !== "refusal" && res.stop_reason !== "max_tokens";
  return { data: ok ? ((res.parsed_output as z.infer<T> | null) ?? null) : null, cost, model };
}

/** SQLite datetime modifier for the owner's timezone, e.g. "+240 minutes". */
export function sqlOffset(minutes: number): string {
  return `${minutes >= 0 ? "+" : ""}${minutes} minutes`;
}

/** Human readable explanation for the UI. */
export function describeBlock(reason: AiUnavailableReason): string {
  switch (reason) {
    case "no_key":
      return "AI is not set up yet: add an ANTHROPIC_API_KEY secret (see Settings → AI).";
    case "disabled":
      return "AI features are turned off in Settings.";
    case "cap_reached":
      return "This month's AI spending cap has been reached. Raise it in Settings → AI or wait for next month.";
  }
}
