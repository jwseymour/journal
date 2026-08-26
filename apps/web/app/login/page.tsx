'use client';

import { useEffect, useState } from 'react';
import { API_BASE } from '@/lib/api';
import styles from './page.module.css';

/**
 * Sign-in (`plan.md` M11) — thin, by design (`requirements.md` §7.1): this
 * page makes no decision about who is authorized. Google sign-in is a plain
 * link, since the whole flow is a browser redirect the API owns end to end;
 * the password form is the one place this page talks to the API directly,
 * and it does nothing but forward what was typed and read back the result.
 */
export default function LoginPage() {
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A failed Google round-trip lands back here with `?error=...` rather
  // than a bare thrown error, which would otherwise render as raw JSON on
  // a full-page navigation — indistinguishable from nothing having
  // happened at all. Read via `window.location` rather than
  // `useSearchParams` so this page can stay statically rendered.
  useEffect(() => {
    const message = new URLSearchParams(window.location.search).get('error');
    if (message) setError(message);
  }, []);

  async function handlePasswordSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (!response.ok) {
        setError('Incorrect password.');
        return;
      }
      window.location.href = '/';
    } catch {
      setError('Could not reach the journal backend.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={styles.wrap}>
      <h1 className={styles.title}>Sign in</h1>

      <a className={styles.googleButton} href={`${API_BASE}/auth/google/start`}>
        Sign in with Google
      </a>

      <p className={styles.divider}>or</p>

      <form className={styles.form} onSubmit={handlePasswordSubmit}>
        <input
          type="password"
          className={styles.field}
          placeholder="Password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoFocus
          aria-label="Password"
        />
        <button type="submit" className={styles.submit} disabled={submitting || password.length === 0}>
          Sign in
        </button>
      </form>

      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
}
