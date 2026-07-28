'use client';

import { useState } from 'react';
import type { Entry } from '@journal/contract';
import { Composer } from '@/components/composer';
import { Markdown } from '@/components/markdown';
import { addAttachment, ApiRequestError, updateEntry } from '@/lib/api';
import { formatTimestamp } from '@/lib/format';
import { useGlobalKey } from '@/lib/keyboard';
import styles from './page.module.css';

/**
 * Read, and edit (`requirements.md` §4.4, `design.md` §5.1, §5.2).
 *
 * Reading an existing entry always shows it rendered — there is no source
 * toggle here at all, only in the composer, because reading is not writing
 * (`design.md` §5.1). Editing reuses the shared `Composer`, so the toggle,
 * `⌘B`/`⌘I`, and the rest of the scheme behave identically to drafting a new
 * entry rather than being a second, slightly different implementation.
 */
export function EntryView({ entry: initial }: { entry: Entry }) {
  const [entry, setEntry] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(initial.body);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  const startEditing = () => {
    setDraft(entry.body);
    setError(null);
    setConflict(false);
    setEditing(true);
  };

  const cancel = () => {
    setEditing(false);
    setError(null);
  };

  const save = async (): Promise<boolean> => {
    if (saving) return false;
    setSaving(true);
    setError(null);
    try {
      const updated = await updateEntry(entry.id, { body: draft, contentHash: entry.contentHash });
      setEntry(updated);
      return true;
    } catch (cause) {
      if (cause instanceof ApiRequestError && cause.code === 'edit_conflict') {
        // Nothing is overwritten and the draft stays exactly as typed — there
        // is no merge UI to offer, so the honest option is a plain reload.
        setConflict(true);
      } else {
        setError(cause instanceof ApiRequestError ? cause.message : 'Could not save.');
      }
      return false;
    } finally {
      setSaving(false);
    }
  };

  const attachAudio = async (blob: Blob, filename: string): Promise<string> => {
    const { relativeLink } = await addAttachment(entry.id, blob, filename);
    return relativeLink;
  };

  // `e`, outside a text field: edit the open entry (`design.md` §5.2). Only
  // claimed while there is something to switch into — editing itself is a
  // text field, so the global scheme already stops listening once it opens.
  useGlobalKey('e', startEditing, !editing);

  if (!editing) {
    return (
      <article className={styles.entry}>
        <header className={styles.head}>
          <time dateTime={entry.created}>{formatTimestamp(entry.created)}</time>
          <button type="button" className={styles.editButton} onClick={startEditing}>
            Edit
          </button>
        </header>
        <Markdown>{entry.body}</Markdown>
      </article>
    );
  }

  return (
    <div className={styles.entry}>
      {conflict && (
        <p className={styles.conflict} role="alert">
          This entry changed outside the app since it was opened — most likely edited
          elsewhere. Nothing has been overwritten. Copy anything above you want to keep, then
          reload the page to see the current version.
        </p>
      )}
      <Composer
        value={draft}
        onChange={setDraft}
        onSave={() => void save()}
        onFinish={() => void save().then((ok) => ok && setEditing(false))}
        onAttachAudio={attachAudio}
        disabled={conflict}
        autoFocus
        ariaLabel="Edit entry"
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
          <kbd className={styles.hint}>⌘⌥R voice</kbd>
          <kbd className={styles.hint}>⌘⇧P preview</kbd>
          <kbd className={styles.hint}>⌘S save</kbd>
          <kbd className={styles.hint}>⌘↩ done</kbd>
          <button type="button" className={styles.cancelButton} onClick={cancel} disabled={saving}>
            Cancel
          </button>
          <button
            type="button"
            className={styles.saveButton}
            onClick={() => void save()}
            disabled={saving || conflict}
          >
            {saving ? 'Saving' : 'Save'}
          </button>
        </div>
      </footer>
    </div>
  );
}
