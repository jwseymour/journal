import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * A stateless, signed session token (`plan.md` M11) — the same value works
 * both as the cookie the browser carries and as an `Authorization: Bearer`
 * token a non-browser caller sends directly. Deliberately not a JWT: there
 * is exactly one issuer, one algorithm, and one claim shape, so there is
 * nothing for a header-driven `alg` negotiation to protect against — a
 * fixed-format `payload.signature` pair is simpler and has no "alg: none"
 * class of bug to worry about.
 *
 * No sessions table, anywhere — the entire point (`plan.md` M11's reasoning
 * for this choice): auth state must never be treated as disposable the way
 * `index.db`'s cache rows are. A stateless token sidesteps that question
 * rather than adding another durable-row case to the derived store.
 * "Logout everywhere" is rotating `SESSION_SECRET`, which invalidates every
 * outstanding token in one move — coarse, but entirely adequate for a
 * single-user system.
 */

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, rolling.

export interface SessionPayload {
  /** The authorized email this token was issued to. */
  sub: string;
  iat: number;
  exp: number;
}

function sign(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

export function createSessionToken(secret: string, subject: string, ttlMs = DEFAULT_TTL_MS): string {
  const now = Date.now();
  const payload: SessionPayload = { sub: subject, iat: now, exp: now + ttlMs };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${sign(secret, body)}`;
}

/** `null` for anything malformed, unsigned by this secret, or expired —
 * callers never need to distinguish why a token failed. */
export function verifySessionToken(secret: string, token: string): SessionPayload | null {
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  const expected = sign(secret, body);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionPayload;
  } catch {
    return null;
  }
  if (typeof payload.exp !== 'number' || Date.now() > payload.exp) return null;
  if (typeof payload.sub !== 'string' || typeof payload.iat !== 'number') return null;
  return payload;
}
