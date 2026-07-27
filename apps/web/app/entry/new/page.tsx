'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiRequestError, createEntry } from '@/lib/api';
import { nowRfc3339 } from '@/lib/format';
import styles from './page.module.css';

/**
 * The writing surface, in its M1 form: a page to type on, and one way to
 * finish. Autosave, drafts and hash preconditions are M2; the full keyboard
 * scheme, rendered markdown, the reference pane and toggleable chrome are M3
 * (`plan.md` M1–M3).
 *
 * Three things here are not deferrable, because each one protects writing:
 *
 * - **`created` is the first keystroke**, not the save. It marks when the
 *   session began (`format.md` §3).
 * - **A failed save never clears the text.** The one thing this surface must
 *   never do is lose what was typed.
 * - **Leaving with unsaved writing is confirmed**, until autosave exists.
 *
 * There is no placeholder. A prompt in an empty journal page would be a writing
 * prompt, and those are prohibited (`design.md` §4).
 */
export default function NewEntryPage() {
  const router = useRouter();
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** When the session began. Set once, on the first keystroke. */
  const startedAt = useRef<string | null>(null);
  /** Suppresses the unload guard once the writing is safely on disk. */
  const committed = useRef(false);

  const hasWriting = body.trim().length > 0;

  const finish = useCallback(async () => {
    if (saving || !hasWriting) return;
    setSaving(true);
    setError(null);
    try {
      const created = await createEntry({ body, created: startedAt.current ?? nowRfc3339() });
      committed.current = true;
      router.push(`/entry/${created.id}`);
    } catch (cause) {
      // The text stays exactly where it is. Nothing is cleared, nothing is
      // retried behind the user's back.
      setError(
        cause instanceof ApiRequestError ? cause.message : 'The entry could not be saved.',
      );
      setSaving(false);
    }
  }, [body, hasWriting, router, saving]);

  useEffect(() => {
    if (!hasWriting) return;
    const guard = (event: BeforeUnloadEvent) => {
      if (committed.current) return;
      event.preventDefault();
      // Still required by some browsers alongside `preventDefault`.
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [hasWriting]);

  return (
    <div className={styles.composer}>
      <textarea
        className={styles.input}
        value={body}
        autoFocus
        spellCheck
        aria-label="Entry"
        onChange={(event) => {
          startedAt.current ??= nowRfc3339();
          setBody(event.target.value);
        }}
        onKeyDown={(event) => {
          // `⌘↩` — finish the entry (`design.md` §5.2). The rest of the scheme
          // is implemented whole in M3 rather than accumulated here.
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault();
            void finish();
          }
        }}
      />

      <footer className={styles.footer}>
        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : (
          <span />
        )}
        <div className={styles.actions}>
          <kbd className={styles.hint}>⌘↩</kbd>
          <button
            type="button"
            className={styles.finish}
            onClick={() => void finish()}
            disabled={!hasWriting || saving}
          >
            {saving ? 'Saving' : 'Finish'}
          </button>
        </div>
      </footer>
    </div>
  );
}
