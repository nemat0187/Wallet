import type { Hono } from "hono";

export interface Env {
  DB: D1Database;
  /** Set by forUser(): the user this Env (and its DB) is limited to. */
  userId?: number;
  ASSETS: Fetcher;
  /** Login password for the single owner of this app (Cloudflare secret). */
  APP_PASSWORD?: string;
  /** Anthropic API key — enables AI categorization, reports and chat. */
  ANTHROPIC_API_KEY?: string;
  /** Optional: route Claude requests through a gateway (e.g. Cloudflare AI Gateway). */
  ANTHROPIC_BASE_URL?: string;
  /** Optional: enables "Continue with Google" (Google Cloud OAuth client). */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Testing only: point the Google flow at a local mock. */
  GOOGLE_AUTH_URL?: string;
  GOOGLE_TOKEN_URL?: string;
  /** 32 random bytes (base64) for encrypting secrets and signing tokens. Created once by the deploy script. */
  ENCRYPTION_KEY?: string;
  /** Testing only: send a provider's requests to a local mock instead. */
  AI_TEST_ANTHROPIC_URL?: string;
  AI_TEST_OPENAI_URL?: string;
  AI_TEST_GEMINI_URL?: string;
  /** Optional: comma-separated origins of a phone/desktop app shell that may call the API (e.g. "https://localhost,capacitor://localhost"). */
  APP_ORIGINS?: string;
  /** Optional Telegram bot token for notifications and quick-add. */
  TELEGRAM_BOT_TOKEN?: string;
}

export type AppEnv = { Bindings: Env; Variables: { sessionHash: string; userId: number; role: "admin" | "user" } };
export type App = Hono<AppEnv>;
