import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PkceFlow } from './google.js';

/**
 * Carries one in-progress Google login attempt's `state`/`codeVerifier`
 * from `/auth/google/start` to `/auth/google/callback`, sealed into a
 * short-lived cookie rather than a server-side store — there is nowhere
 * durable to put it that would not either need a sessions table (exactly
 * what `session.ts` is designed to avoid) or tie this to one process.
 */

const FLOW_TTL_MS = 10 * 60 * 1000;

interface FlowPayload extends PkceFlow {
  exp: number;
}

function sign(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

export function sealFlow(secret: string, flow: PkceFlow): string {
  const payload: FlowPayload = { ...flow, exp: Date.now() + FLOW_TTL_MS };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${sign(secret, body)}`;
}

export function unsealFlow(secret: string, sealed: string): PkceFlow | null {
  const dot = sealed.indexOf('.');
  if (dot < 0) return null;
  const body = sealed.slice(0, dot);
  const signature = sealed.slice(dot + 1);

  const expected = sign(secret, body);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as FlowPayload;
    if (Date.now() > payload.exp) return null;
    return { state: payload.state, codeVerifier: payload.codeVerifier, codeChallenge: payload.codeChallenge };
  } catch {
    return null;
  }
}
