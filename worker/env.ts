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
  /** Optional Telegram bot token for notifications and quick-add. */
  TELEGRAM_BOT_TOKEN?: string;
}

export type AppEnv = { Bindings: Env; Variables: { sessionHash: string; userId: number } };
export type App = Hono<AppEnv>;
