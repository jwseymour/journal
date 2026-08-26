import argon2 from 'argon2';

/**
 * The password fallback login (`plan.md` M11) — for a device or browser
 * where Google sign-in is inconvenient. `hash` is generated once, offline,
 * via `npm run set-password`, and lives in `AUTH_PASSWORD_HASH`; nothing
 * about a plaintext password is ever stored.
 */
export async function verifyPassword(hash: string, candidate: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, candidate);
  } catch {
    // A malformed stored hash (e.g. `AUTH_PASSWORD_HASH` pasted wrong) fails
    // closed, the same as any other mismatch — never throws past this point.
    return false;
  }
}

export function hashPassword(candidate: string): Promise<string> {
  return argon2.hash(candidate, { type: argon2.argon2id });
}
