// A person's own AI keys: validated against the provider, stored encrypted, never shown again (only the last 4
// characters). The model list the provider returns for the key is cached for an hour.

import type { Env } from "../env";
import { seal } from "../lib/secretbox";
import { getSetting, setSetting } from "./settings";
import { credentialsFor, selectedProvider } from "./ai";
import { listModels, pickDefaults } from "./aiproviders/models";
import { PROVIDERS, PROVIDER_LABEL, ProviderError, type Credentials, type Provider } from "./aiproviders/types";
import { OWNER_ID } from "../lib/userkeys";
import { userIdOf } from "../lib/scoped";

const CACHE_MS = 3600_000;

/** Pasted keys often carry spaces, line breaks or quotes. API keys never contain any of those. */
export function cleanKey(input: string): string {
  return input.replace(/\s+/g, "").replace(/^["'`]+|["'`]+$/g, "");
}

export function validKeyShape(key: string): boolean {
  return key.length >= 16 && key.length <= 400 && /^[A-Za-z0-9_\-.]+$/.test(key);
}

function testBase(env: Env, provider: Provider): string | undefined {
  return { anthropic: env.AI_TEST_ANTHROPIC_URL, openai: env.AI_TEST_OPENAI_URL, gemini: env.AI_TEST_GEMINI_URL }[provider] || undefined;
}

export interface ProviderStatus {
  provider: Provider;
  label: string;
  has_key: boolean;
  last4: string | null;
  /** "installation" = the owner's shared Claude key (owner only) */
  source: "own" | "installation" | null;
  models: string[];
  selected: boolean;
}

async function cachedModels(env: Env, provider: Provider): Promise<{ at: number; models: string[] } | null> {
  try {
    const v = JSON.parse((await getSetting(env.DB, `ai_models_${provider}`)) ?? "null");
    return v && Array.isArray(v.models) ? v : null;
  } catch {
    return null;
  }
}

export async function providerStatuses(env: Env): Promise<ProviderStatus[]> {
  const selected = await selectedProvider(env);
  const out: ProviderStatus[] = [];
  for (const provider of PROVIDERS) {
    const own = Boolean(await getSetting(env.DB, `ai_key_${provider}`));
    const installation = !own && provider === "anthropic" && userIdOf(env) === OWNER_ID && Boolean(env.ANTHROPIC_API_KEY);
    out.push({
      provider,
      label: PROVIDER_LABEL[provider],
      has_key: own || installation,
      last4: own ? await getSetting(env.DB, `ai_key_last4_${provider}`) : null,
      source: own ? "own" : installation ? "installation" : null,
      models: (await cachedModels(env, provider))?.models ?? [],
      selected: provider === selected,
    });
  }
  return out;
}

async function storeModels(env: Env, provider: Provider, models: string[]) {
  await setSetting(env.DB, `ai_models_${provider}`, JSON.stringify({ at: Date.now(), models }));
}

/** Check the key with the provider, store it encrypted, make this provider the active one and pick default models. */
export async function saveKey(env: Env, provider: Provider, input: string): Promise<ProviderStatus[]> {
  const key = cleanKey(input);
  if (!validKeyShape(key)) throw new ProviderError(provider, "bad_request", "That doesn't look like an API key. Copy the whole key from your provider and paste it again.");
  const creds: Credentials = { provider, apiKey: key, baseUrl: testBase(env, provider) };
  const models = await listModels(creds); // throws a friendly error for a wrong key
  if (models.length === 0) throw new ProviderError(provider, "model", `This key works but ${PROVIDER_LABEL[provider]} lists no models for it. Check that your account can use the API.`);
  await setSetting(env.DB, `ai_key_${provider}`, await seal(env, key));
  await setSetting(env.DB, `ai_key_last4_${provider}`, key.slice(-4));
  await storeModels(env, provider, models);
  await setSetting(env.DB, "ai_key_error", null);
  await setSetting(env.DB, "ai_provider", provider);
  const picked = pickDefaults(provider, models);
  const wrong = (m: string | null) => !m || !models.includes(m);
  if (wrong(await getSetting(env.DB, "ai_fast_model")) && picked.fast) await setSetting(env.DB, "ai_fast_model", picked.fast);
  if (wrong(await getSetting(env.DB, "ai_smart_model")) && picked.smart) await setSetting(env.DB, "ai_smart_model", picked.smart);
  return providerStatuses(env);
}

export async function removeKey(env: Env, provider: Provider): Promise<ProviderStatus[]> {
  for (const k of [`ai_key_${provider}`, `ai_key_last4_${provider}`, `ai_models_${provider}`]) await setSetting(env.DB, k, null);
  if ((await getSetting(env.DB, "ai_key_error")) === provider) await setSetting(env.DB, "ai_key_error", null);
  return providerStatuses(env);
}

/** Ask the provider again which models the key can use (the cached list is also refreshed after an hour). */
export async function refreshModels(env: Env, provider: Provider, force = true): Promise<string[]> {
  const cached = await cachedModels(env, provider);
  if (!force && cached && Date.now() - cached.at < CACHE_MS) return cached.models;
  const creds = await credentialsFor(env, provider);
  if (!creds) throw new ProviderError(provider, "auth", "Add your API key first.");
  const models = await listModels(creds);
  await storeModels(env, provider, models);
  return models;
}

/** Choose models for a provider from its list when the current choice does not belong to it (e.g. after switching). */
export async function ensureModelsFor(env: Env, provider: Provider): Promise<void> {
  const models = (await cachedModels(env, provider))?.models ?? [];
  if (!models.length) return;
  const picked = pickDefaults(provider, models);
  const fast = await getSetting(env.DB, "ai_fast_model");
  const smart = await getSetting(env.DB, "ai_smart_model");
  if ((!fast || !models.includes(fast)) && picked.fast) await setSetting(env.DB, "ai_fast_model", picked.fast);
  if ((!smart || !models.includes(smart)) && picked.smart) await setSetting(env.DB, "ai_smart_model", picked.smart);
}
