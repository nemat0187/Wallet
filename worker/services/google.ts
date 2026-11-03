// "Continue with Google": the server-side authorization-code flow. The browser is redirected to Google and back;
// the id_token comes straight from Google's token endpoint over TLS, so only its claims are checked here.

import type { Env } from "../env";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export const googleConfigured = (env: Env) => Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);

/** Where Google sends the browser back to (must be listed as an authorized redirect URI in Google Cloud). */
export const redirectUri = (origin: string) => `${origin}/api/auth/google/callback`;

export function authUrl(env: Env, origin: string, state: string, nonce: string): string {
  const url = new URL(env.GOOGLE_AUTH_URL || AUTH_URL);
  url.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID ?? "",
    redirect_uri: redirectUri(origin),
    response_type: "code",
    scope: "openid email profile",
    state,
    nonce,
    prompt: "select_account",
  }).toString();
  return url.toString();
}

export interface GoogleClaims {
  iss: string;
  aud: string;
  sub: string;
  email: string;
  email_verified: boolean | string;
  name?: string;
  nonce?: string;
  exp: number;
}

/** Decode (not verify) the payload of a JWT. */
export function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const part = jwt.split(".")[1];
  if (!part) throw new Error("Malformed id_token");
  const b64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** Throws a short reason when the claims are not acceptable for this app. */
export function checkClaims(claims: Partial<GoogleClaims>, clientId: string, nonce: string, nowSeconds = Math.floor(Date.now() / 1000)): GoogleClaims {
  if (claims.iss !== "https://accounts.google.com" && claims.iss !== "accounts.google.com") throw new Error("Unexpected issuer");
  if (claims.aud !== clientId) throw new Error("Wrong audience");
  if (!claims.exp || claims.exp < nowSeconds) throw new Error("Token expired");
  if (!claims.nonce || claims.nonce !== nonce) throw new Error("Nonce mismatch");
  if (!claims.sub) throw new Error("Missing subject");
  if (!claims.email) throw new Error("No email address");
  if (claims.email_verified !== true && claims.email_verified !== "true") throw new Error("Email is not verified by Google");
  return claims as GoogleClaims;
}

/** Exchange the authorization code for the user's claims. */
export async function exchangeCode(env: Env, origin: string, code: string, nonce: string): Promise<GoogleClaims> {
  const res = await fetch(env.GOOGLE_TOKEN_URL || TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID ?? "",
      client_secret: env.GOOGLE_CLIENT_SECRET ?? "",
      redirect_uri: redirectUri(origin),
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new Error(`Google refused the sign-in (${res.status})`);
  const data = (await res.json()) as { id_token?: string };
  if (!data.id_token) throw new Error("Google sent no id_token");
  return checkClaims(decodeJwtPayload(data.id_token) as Partial<GoogleClaims>, env.GOOGLE_CLIENT_ID ?? "", nonce);
}
