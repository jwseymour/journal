'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Composer } from '@/components/composer';
import { ApiRequestError, createDocument } from '@/lib/api';
import styles from './page.module.css';

/**
 * Creating a document (`requirements.md` §9, `plan.md` M12).
 *
 * Deliberately **not** the entry composer's autosave-from-first-keystroke
 * lifecycle. A document requires a title, so — unlike an entry, which
 * exists the instant there is any content at all — there is nothing to
 * create until the title is filled in. Creation here is one explicit
 * action, gated on that title, not something incidental to typing; there is
 * no abandoned-blank-draft case to clean up on the way out, so none of
 * `entry/new`'s ref-heavy debounce/pagehide machinery is needed.
 */
export default function NewDocumentPage() {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [citedEntriesInput, setCitedEntriesInput] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canCreate = title.trim().length > 0 && !creating;

  const create = async () => {
    if (!canCreate) return;
    setCreating(true);
    setError(null);
    try {
      const citedEntries = citedEntriesInput
        .split(/[\s,]+/)
        .map((id) => id.trim())
        .filter((id) => id.length > 0);
      const created = await createDocument({
        title: title.trim(),
        body,
        ...(citedEntries.length > 0 ? { citedEntries } : {}),
      });
      router.push(`/documents/${created.id}`);
    } catch (cause) {
      setError(cause instanceof ApiRequestError ? cause.message : 'Could not create the document.');
      setCreating(false);
    }
  };

  return (
    <div className={styles.form}>
      <input
        className={styles.title}
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder="Title"
        aria-label="Title"
        autoFocus
      />
      <Composer
        value={body}
        onChange={setBody}
        onSave={() => void create()}
        onFinish={() => void create()}
        disabled={creating}
        ariaLabel="Document body"
      />
      <input
        className={styles.citations}
        value={citedEntriesInput}
        onChange={(event) => setCitedEntriesInput(event.target.value)}
        placeholder="Cited entries (ids, optional)"
        aria-label="Cited entries"
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
          <kbd className={styles.hint}>⌘S / ⌘↩ create</kbd>
          <button type="button" className={styles.create} onClick={() => void create()} disabled={!canCreate}>
            {creating ? 'Creating' : 'Create'}
          </button>
        </div>
      </footer>
    </div>
  );
}
