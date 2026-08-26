/**
 * A fixed-window rate limiter, in memory (`plan.md` M11) — good enough for a
 * single-user API on one process; there is no second instance for it to
 * disagree with. Guards `/auth/login` against a brute-force password guess.
 */
export class FixedWindowRateLimiter {
  readonly #windowMs: number;
  readonly #maxAttempts: number;
  readonly #windows = new Map<string, { count: number; windowStart: number }>();

  constructor(maxAttempts: number, windowMs: number) {
    this.#maxAttempts = maxAttempts;
    this.#windowMs = windowMs;
  }

  /** `true` if this attempt is allowed to proceed (and counts against the
   * window); `false` if the caller should be refused outright. */
  attempt(key: string): boolean {
    const now = Date.now();
    const existing = this.#windows.get(key);
    if (!existing || now - existing.windowStart >= this.#windowMs) {
      this.#windows.set(key, { count: 1, windowStart: now });
      return true;
    }
    if (existing.count >= this.#maxAttempts) return false;
    existing.count += 1;
    return true;
  }
}
