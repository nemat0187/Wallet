// Everything a request or background job needs to act for one user.

import type { Env } from "../env";
import { OWNER_ID } from "./userkeys";

export interface UserCtx {
  env: Env;
  db: D1Database;
  userId: number;
}

export function userCtx(env: Env, userId: number): UserCtx {
  return { env, db: env.DB, userId };
}

/** The owner's context, for code paths that are not yet user-aware. Removed once every caller passes a user. */
export const ownerCtx = (env: Env): UserCtx => userCtx(env, OWNER_ID);
