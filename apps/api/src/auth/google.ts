import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';

/**
 * Google sign-in, contained to this one file (`plan.md` M11) — the same
 * single-interface discipline `model-client.ts` and `transcriber.ts` already
 * apply to every other external provider (`requirements.md` §7.6). Nothing
 * outside this module names a Google endpoint or parses a Google token
 * shape.
 *
 * Authorization Code + PKCE, hand-rolled against plain `fetch` rather than a
 * client SDK — Google's OAuth endpoints are simple enough that a dependency
 * bought little beyond what `jose` already gives this file for the one part
 * (verifying the returned `id_token`'s signature) that is actually worth not
 * hand-rolling.
 */

const AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const JWKS_URI = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

// Fetched once and cached for the life of the process — this is exactly what
// `createRemoteJWKSet` is for, including its own key-rotation handling.
const jwks = createRemoteJWKSet(new URL(JWKS_URI));

function base64url(input: Buffer): string {
  return input.toString('base64url');
}

export interface PkceFlow {
  state: string;
  codeVerifier: string;
  codeChallenge: string;
}

/** A fresh `state` and PKCE pair for one login attempt. The caller is
 * responsible for remembering `state`/`codeVerifier` until the callback —
 * see `auth/flow-cookie.ts`, which does that without a server-side store. */
export function beginFlow(): PkceFlow {
  const state = base64url(randomBytes(24));
  const codeVerifier = base64url(randomBytes(32));
  const codeChallenge = base64url(createHash('sha256').update(codeVerifier).digest());
  return { state, codeVerifier, codeChallenge };
}

export function authorizationUrl(clientId: string, redirectUri: string, flow: PkceFlow): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email',
    state: flow.state,
    code_challenge: flow.codeChallenge,
    code_challenge_method: 'S256',
    // Never re-prompt for a returning single user; this account is the only
    // one that will ever be offered.
    prompt: 'select_account',
  });
  return `${AUTHORIZATION_ENDPOINT}?${params.toString()}`;
}

export interface VerifiedIdentity {
  email: string;
  emailVerified: boolean;
}

/**
 * Exchanges an authorization `code` for tokens and verifies the returned
 * `id_token`'s signature, issuer, audience and expiry. Throws on anything
 * that does not check out — a caller that gets a return value can trust it
 * completely; there is no partial-success state to handle.
 */
export async function exchangeCodeForIdentity(
  clientId: string,
  clientSecret: string,
  redirectUri: string,
  code: string,
  codeVerifier: string,
): Promise<VerifiedIdentity> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      code_verifier: codeVerifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }),
  });
  if (!response.ok) {
    throw new Error(`Google token exchange failed (${response.status}): ${await response.text()}`);
  }
  const body = (await response.json()) as { id_token?: string };
  if (!body.id_token) throw new Error('Google token exchange did not return an id_token.');

  const { payload } = await jwtVerify(body.id_token, jwks, {
    issuer: ISSUERS,
    audience: clientId,
  });

  const email = payload['email'];
  if (typeof email !== 'string') throw new Error('Google id_token carried no email claim.');
  return { email, emailVerified: payload['email_verified'] === true };
}
