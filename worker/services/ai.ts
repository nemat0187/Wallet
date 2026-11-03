// The AI layer used by the rest of the app. Whatever provider a person chose (Claude, ChatGPT or Gemini), callers use
// `structuredCall`, `chatWithTools` and `aiBlocked`; this file finds that person's key, applies their limits, records
// usage and turns provider failures into messages they can act on.

import type { z } from "zod";
import type { Env } from "../env";
import type { Settings } from "@shared/types";
import { first, insert, nowIso } from "../lib/db";
import { open } from "../lib/secretbox";
import { userIdOf } from "../lib/scoped";
import { OWNER_ID } from "../lib/userkeys";
import { getSetting, getSettings, setSetting } from "./settings";
import { anthropicAdapter } from "./aiproviders/anthropic";
import type { Adapter, ChatTool, Credentials, Effort, Part, Provider, Usage } from "./aiproviders/types";
import { PROVIDER_LABEL, ProviderError, httpError, isProvider } from "./aiproviders/types";

export type { Effort, Part, ChatTool, Provider };

/** USD per million tokens (input, output, cache read, cache write). Only Claude prices are known here. */
const PRICING: Record<string, [number, number, number, number]> = {
  "claude-haiku-5-5": [0.1, 0.5, 0.01, 0.125],
  "claude-sonnet-5-5": [2, 10, 0.2, 2.5],
  "claude-opus-5-5": [4, 20, 0.2, 5],
  "claude-opus-5": [5, 25, 0.5, 6.25],
  "claude-opus-4-8": [5, 25, 0.5, 6.25],
};

export type UsageLike = Usage;

/** The dollar cost, or null when the price of this model is not known (only tokens are counted then). */
export function costUsd(provider: Provider, model: string, u: Usage): number | null {
  if (provider !== "anthropic") return null;
  const [pin, pout, pread, pwrite] = PRICING[model] ?? PRICING["claude-opus-5"];
  return (u.input_tokens * pin + u.output_tokens * pout + (u.cache_read_input_tokens ?? 0) * pread + (u.cache_creation_input_tokens ?? 0) * pwrite) / 1_000_000;
}

export async function recordUsage(db: D1Database, purpose: string, model: string, u: Usage, provider: Provider = "anthropic"): Promise<number> {
  const cost = costUsd(provider, model, u);
  const now = nowIso();
  await insert(
    db,
    `INSERT INTO ai_usage (created_at, month, purpose, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, provider, cost_known)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    now,
    now.slice(0, 7),
    purpose,
    model,
    u.input_tokens,
    u.output_tokens,
    u.cache_read_input_tokens ?? 0,
    u.cache_creation_input_tokens ?? 0,
    cost ?? 0,
    provider,
    cost === null ? 0 : 1,
  );
  return cost ?? 0;
}

export async function monthSpend(db: D1Database): Promise<number> {
  const row = await first<{ total: number | null }>(db, "SELECT SUM(cost_usd) AS total FROM ai_usage WHERE month = ?", nowIso().slice(0, 7));
  return row?.total ?? 0;
}

export async function monthTokens(db: D1Database): Promise<number> {
  const row = await first<{ total: number | null }>(db, "SELECT SUM(input_tokens + output_tokens) AS total FROM ai_usage WHERE month = ?", nowIso().slice(0, 7));
  return row?.total ?? 0;
}

// --- keys ----------------------------------------------------------------------------------------------------------

/** Local testing only: send a provider's requests to a mock server. */
function testBase(env: Env, provider: Provider): string | undefined {
  return { anthropic: env.AI_TEST_ANTHROPIC_URL, openai: env.AI_TEST_OPENAI_URL, gemini: env.AI_TEST_GEMINI_URL }[provider] || undefined;
}

export async function selectedProvider(env: Env): Promise<Provider> {
  const v = await getSetting(env.DB, "ai_provider");
  return isProvider(v) ? v : "anthropic";
}

/** The key to use for a provider: the person's own, or (owner only) the installation's Claude key. */
export async function credentialsFor(env: Env, provider: Provider): Promise<Credentials | null> {
  const sealed = await getSetting(env.DB, `ai_key_${provider}`);
  if (sealed) return { provider, apiKey: await open(env, sealed), baseUrl: testBase(env, provider) };
  if (provider === "anthropic" && userIdOf(env) === OWNER_ID && env.ANTHROPIC_API_KEY) {
    return { provider, apiKey: env.ANTHROPIC_API_KEY, baseUrl: testBase(env, provider) ?? (env.ANTHROPIC_BASE_URL || undefined) };
  }
  return null;
}

// --- limits --------------------------------------------------------------------------------------------------------

export type AiUnavailableReason = "no_key" | "key_rejected" | "no_model" | "disabled" | "cap_reached" | "tokens_reached";

/** Why AI cannot be used right now, or null if it can. */
export async function aiBlocked(env: Env, settings?: Settings): Promise<AiUnavailableReason | null> {
  const s = settings ?? (await getSettings(env));
  if (!s.ai_configured) return "no_key";
  if (!s.ai_enabled) return "disabled";
  if ((await getSetting(env.DB, "ai_key_error")) === s.ai_provider) return "key_rejected";
  const claudeName = (m: string) => /^claude/i.test(m);
  const wrongModel = (m: string) => !m || (s.ai_provider === "anthropic" ? !claudeName(m) : claudeName(m));
  if (wrongModel(s.ai_fast_model) || wrongModel(s.ai_smart_model)) return "no_model";
  if ((await monthSpend(env.DB)) >= s.ai_monthly_cap_usd) return "cap_reached";
  if ((await monthTokens(env.DB)) >= s.ai_monthly_token_cap) return "tokens_reached";
  return null;
}

/** Human readable explanation for the UI. */
export function describeBlock(reason: AiUnavailableReason): string {
  switch (reason) {
    case "no_key":
      return "AI is not set up yet: add your own API key in Settings → AI.";
    case "key_rejected":
      return "Your AI provider rejected the API key. Paste a new one in Settings → AI.";
    case "no_model":
      return "Choose which AI models to use in Settings → AI.";
    case "disabled":
      return "AI features are turned off in Settings.";
    case "cap_reached":
      return "This month's AI spending cap has been reached. Raise it in Settings → AI or wait for next month.";
    case "tokens_reached":
      return "This month's AI usage limit has been reached. Raise it in Settings → AI or wait for next month.";
  }
}

// --- calls ---------------------------------------------------------------------------------------------------------

function adapterFor(provider: Provider): Adapter {
  if (provider === "anthropic") return anthropicAdapter;
  throw new ProviderError(provider, "bad_request", `${PROVIDER_LABEL[provider]} support is not available in this version yet.`);
}

/** Anything a provider SDK or fetch can throw, as a ProviderError with a friendly message. */
function normalize(provider: Provider, e: unknown): ProviderError {
  if (e instanceof ProviderError) return e;
  const err = e as { status?: number; name?: string; message?: string };
  if (typeof err?.status === "number") return httpError(provider, err.status, err.message);
  if (err?.name === "AbortError" || /timeout|timed out/i.test(`${err?.name} ${err?.message}`)) {
    return new ProviderError(provider, "timeout", `${PROVIDER_LABEL[provider]} took too long to answer. Please try again.`);
  }
  return new ProviderError(provider, "server", `${PROVIDER_LABEL[provider]} could not be reached. Please try again in a moment.`);
}

async function run<R>(env: Env, creds: Credentials, work: (adapter: Adapter) => Promise<R>): Promise<R> {
  try {
    return await work(adapterFor(creds.provider));
  } catch (e) {
    const err = normalize(creds.provider, e);
    // A rejected key is remembered, so background jobs stop calling until the person pastes a new one.
    if (err.kind === "auth") await setSetting(env.DB, "ai_key_error", creds.provider);
    throw err;
  }
}

async function needCredentials(env: Env): Promise<Credentials> {
  const provider = await selectedProvider(env);
  const creds = await credentialsFor(env, provider);
  if (!creds) throw new ProviderError(provider, "auth", describeBlock("no_key"));
  return creds;
}

export interface StructuredCall<T extends z.ZodType> {
  purpose: string;
  model: string;
  system: string;
  content: string | Part[];
  schema: T;
  maxTokens?: number;
  effort?: Effort;
  timeoutMs?: number;
}

/**
 * One request that must come back as JSON matching `schema`.
 * `data` is null when the model declines; throws a ProviderError when the provider fails.
 */
export async function structuredCall<T extends z.ZodType>(env: Env, call: StructuredCall<T>): Promise<{ data: z.infer<T> | null; cost: number; model: string }> {
  const creds = await needCredentials(env);
  const res = await run(env, creds, (a) =>
    a.structured(creds, {
      model: call.model,
      system: call.system,
      content: call.content,
      schema: call.schema,
      maxTokens: call.maxTokens ?? 8000,
      effort: call.effort ?? "low",
      timeoutMs: call.timeoutMs,
    }),
  );
  const cost = await recordUsage(env.DB, call.purpose, res.model, res.usage, creds.provider);
  return { data: res.data, cost, model: res.model };
}

/** A conversation where the assistant may look things up with `tools`. */
export async function chatWithTools(
  env: Env,
  call: { model: string; system: string; context: string; history: { role: "user" | "assistant"; content: string }[]; tools: ChatTool[]; maxIterations?: number },
): Promise<{ reply: string } | { error: string }> {
  const creds = await needCredentials(env);
  const result = await run(env, creds, (a) =>
    a.chat(creds, {
      ...call,
      maxIterations: call.maxIterations ?? 6,
      onUsage: async (model, usage) => {
        await recordUsage(env.DB, "chat", model, usage, creds.provider);
      },
    }),
  );
  if ("refused" in result) return { error: "The AI declined to answer that question." };
  return { reply: result.reply || "I couldn't find an answer to that." };
}

/** SQLite datetime modifier for the owner's timezone, e.g. "+240 minutes". */
export function sqlOffset(minutes: number): string {
  return `${minutes >= 0 ? "+" : ""}${minutes} minutes`;
}
