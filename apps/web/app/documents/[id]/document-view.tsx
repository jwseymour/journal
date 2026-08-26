'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { Document } from '@journal/contract';
import { Composer } from '@/components/composer';
import { Markdown } from '@/components/markdown';
import { ApiRequestError, updateDocument } from '@/lib/api';
import { formatTimestamp } from '@/lib/format';
import { useGlobalKey } from '@/lib/keyboard';
import styles from './page.module.css';

/**
 * Read, and edit (`requirements.md` §9). Mirrors `entry-view.tsx`'s
 * read/edit toggle and conflict-banner UX exactly — a document is directly
 * authored just as an entry is, so the same explicit Save/Cancel model
 * applies, not the touch/validate/suggestions machinery the M10 record
 * pages use.
 */
export function DocumentView({ document: initial }: { document: Document }) {
  const [document, setDocument] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState(initial.title);
  const [bodyDraft, setBodyDraft] = useState(initial.body);
  const [citationsDraft, setCitationsDraft] = useState((initial.citedEntries ?? []).join(', '));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  const startEditing = () => {
    setTitleDraft(document.title);
    setBodyDraft(document.body);
    setCitationsDraft((document.citedEntries ?? []).join(', '));
    setError(null);
    setConflict(false);
    setEditing(true);
  };

  const cancel = () => {
    setEditing(false);
    setError(null);
  };

  const save = async (): Promise<boolean> => {
    if (saving || titleDraft.trim().length === 0) return false;
    setSaving(true);
    setError(null);
    try {
      const citedEntries = citationsDraft
        .split(/[\s,]+/)
        .map((id) => id.trim())
        .filter((id) => id.length > 0);
      const updated = await updateDocument(document.id, {
        title: titleDraft.trim(),
        body: bodyDraft,
        contentHash: document.contentHash,
        ...(citedEntries.length > 0 ? { citedEntries } : {}),
      });
      setDocument(updated);
      return true;
    } catch (cause) {
      if (cause instanceof ApiRequestError && cause.code === 'edit_conflict') {
        setConflict(true);
      } else {
        setError(cause instanceof ApiRequestError ? cause.message : 'Could not save.');
      }
      return false;
    } finally {
      setSaving(false);
    }
  };

  // `e`, outside a text field: edit the open document — same key entries use.
  useGlobalKey('e', startEditing, !editing);

  if (!editing) {
    return (
      <article className={styles.document}>
        <header className={styles.head}>
          <div>
            <h1 className={styles.title}>{document.title}</h1>
            <time dateTime={document.updated} className={styles.when}>
              Updated {formatTimestamp(document.updated)}
            </time>
          </div>
          <button type="button" className={styles.editButton} onClick={startEditing}>
            Edit
          </button>
        </header>
        <Markdown>{document.body}</Markdown>
        {document.citedEntries && document.citedEntries.length > 0 && (
          <footer className={styles.citations}>
            <span className={styles.citationsLabel}>Cites</span>
            {document.citedEntries.map((entryId) => (
              <Link key={entryId} href={`/entry/${entryId}`} className={styles.citationLink}>
                {entryId}
              </Link>
            ))}
          </footer>
        )}
      </article>
    );
  }

  return (
    <div className={styles.document}>
      {conflict && (
        <p className={styles.conflict} role="alert">
          This document changed outside the app since it was opened — most likely edited
          elsewhere. Nothing has been overwritten. Copy anything above you want to keep, then
          reload the page to see the current version.
        </p>
      )}
      <input
        className={styles.titleInput}
        value={titleDraft}
        onChange={(event) => setTitleDraft(event.target.value)}
        aria-label="Title"
      />
      <Composer
        value={bodyDraft}
        onChange={setBodyDraft}
        onSave={() => void save()}
        onFinish={() => void save().then((ok) => ok && setEditing(false))}
        disabled={conflict}
        autoFocus
        ariaLabel="Edit document"
      />
      <input
        className={styles.citationsInput}
        value={citationsDraft}
        onChange={(event) => setCitationsDraft(event.target.value)}
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
          <kbd className={styles.hint}>⌘S save</kbd>
          <kbd className={styles.hint}>⌘↩ done</kbd>
          <button type="button" className={styles.cancelButton} onClick={cancel} disabled={saving}>
            Cancel
          </button>
          <button
            type="button"
            className={styles.saveButton}
            onClick={() => void save()}
            disabled={saving || conflict || titleDraft.trim().length === 0}
          >
            {saving ? 'Saving' : 'Save'}
          </button>
        </div>
      </footer>
    </div>
  );
}
