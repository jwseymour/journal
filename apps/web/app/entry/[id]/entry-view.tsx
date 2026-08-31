'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Entry, EntryStatusResponse } from '@journal/contract';
import { Composer } from '@/components/composer';
import { Markdown } from '@/components/markdown';
import { PendingItemsPopup } from '@/components/pending-items-popup';
import {
  addAttachment,
  ApiRequestError,
  getEntryStatus,
  processEntry,
  publishEntry,
  unpublishEntry,
  updateEntry,
} from '@/lib/api';
import { formatTimestamp } from '@/lib/format';
import { useGlobalKey } from '@/lib/keyboard';
import styles from './page.module.css';

const STATUS_LABEL: Record<EntryStatusResponse['state'], string> = {
  never_processed: 'Never processed',
  stale: 'Stale — reprocess to update',
  up_to_date: 'Up to date',
};

/**
 * Read, and edit (`requirements.md` §4.4, `design.md` §5.1, §5.2).
 *
 * Reading an existing entry always shows it rendered — there is no source
 * toggle here at all, only in the composer, because reading is not writing
 * (`design.md` §5.1). Editing reuses the shared `Composer`, so the toggle,
 * `⌘B`/`⌘I`, and the rest of the scheme behave identically to drafting a new
 * entry rather than being a second, slightly different implementation.
 *
 * Processing is no longer automatic (`plan.md` M18) — neither on arrival
 * from finishing a new entry nor after an edit. A visible **Process**
 * button is now the only trigger, and its status indicator only ever
 * compares content hashes; it says nothing about whether what a past run
 * found has actually been reviewed (`GET /entries/:id/status`'s own
 * comment).
 */
export function EntryView({ entry: initial }: { entry: Entry }) {
  const [entry, setEntry] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(initial.body);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [processError, setProcessError] = useState<string | null>(null);
  const [status, setStatus] = useState<EntryStatusResponse['state'] | null>(null);
  const [showPopup, setShowPopup] = useState(false);
  const [foundNothing, setFoundNothing] = useState(false);
  const [confirmingPublish, setConfirmingPublish] = useState(false);
  const [publishing, setPublishing] = useState(false);

  const loadStatus = useCallback(() => {
    getEntryStatus(entry.id)
      .then((response) => setStatus(response.state))
      .catch(() => {
        /* the status pill just stays blank — not worth a user-facing error */
      });
  }, [entry.id]);

  useEffect(loadStatus, [loadStatus]);

  /**
   * Runs the AI layer for this entry, on demand only (`plan.md` M18) —
   * nothing it finds is committed directly anymore. A pending-item count of
   * zero needs no popup; anything else opens one immediately so review can
   * happen right where the writing just happened, with `/pending` as the
   * fallback for whatever is left over later.
   */
  const runProcessing = useCallback(async () => {
    setProcessing(true);
    setProcessError(null);
    setFoundNothing(false);
    try {
      const result = await processEntry(entry.id);
      loadStatus();
      if (result.pendingItemCount > 0) setShowPopup(true);
      else setFoundNothing(true);
    } catch (cause) {
      setProcessError(cause instanceof ApiRequestError ? cause.message : 'Could not run AI analysis.');
    } finally {
      setProcessing(false);
    }
  }, [entry.id, loadStatus]);

  const closePopup = () => {
    setShowPopup(false);
    loadStatus();
  };

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

  const finishEditing = async (): Promise<void> => {
    const ok = await save();
    if (ok) setEditing(false);
  };

  const attachAudio = async (blob: Blob, filename: string): Promise<string> => {
    const { relativeLink } = await addAttachment(entry.id, blob, filename);
    return relativeLink;
  };

  const confirmPublish = async (): Promise<void> => {
    setPublishing(true);
    try {
      await publishEntry(entry.id);
      setEntry((current) => ({ ...current, published: true }));
      setConfirmingPublish(false);
    } catch (cause) {
      setError(cause instanceof ApiRequestError ? cause.message : 'Could not publish.');
    } finally {
      setPublishing(false);
    }
  };

  const unpublish = async (): Promise<void> => {
    setPublishing(true);
    try {
      await unpublishEntry(entry.id);
      setEntry((current) => ({ ...current, published: false }));
    } catch (cause) {
      setError(cause instanceof ApiRequestError ? cause.message : 'Could not unpublish.');
    } finally {
      setPublishing(false);
    }
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

        <div className={styles.statusRow}>
          <span className={styles.statusPill}>{status ? STATUS_LABEL[status] : ' '}</span>
          <button type="button" className={styles.processButton} onClick={() => void runProcessing()} disabled={processing}>
            {processing ? 'Processing…' : 'Process'}
          </button>
          {entry.published ? (
            <>
              <span className={styles.publishedPill}>Published</span>
              <button type="button" className={styles.processButton} onClick={() => void unpublish()} disabled={publishing}>
                Unpublish
              </button>
            </>
          ) : (
            <button
              type="button"
              className={styles.processButton}
              onClick={() => setConfirmingPublish(true)}
              disabled={publishing}
            >
              Publish
            </button>
          )}
        </div>
        {processError && <p className={styles.processError}>{processError}</p>}
        {foundNothing && !processError && <p className={styles.processError}>Nothing new found.</p>}
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}

        <Markdown>{entry.body}</Markdown>

        {showPopup && <PendingItemsPopup entryId={entry.id} onClose={closePopup} />}

        {confirmingPublish && (
          <div className={styles.confirmBackdrop} role="presentation" onMouseDown={() => setConfirmingPublish(false)}>
            <div
              className={styles.confirmPanel}
              role="dialog"
              aria-modal="true"
              aria-label="Confirm publish"
              onMouseDown={(event) => event.stopPropagation()}
            >
              <p className={styles.confirmText}>
                Publish this entry to the public site? Anyone with the link will be able to read it,
                exactly as it stands right now.
              </p>
              <div className={styles.actions}>
                <button
                  type="button"
                  className={styles.cancelButton}
                  onClick={() => setConfirmingPublish(false)}
                  disabled={publishing}
                >
                  Cancel
                </button>
                <button type="button" className={styles.saveButton} onClick={() => void confirmPublish()} disabled={publishing}>
                  {publishing ? 'Publishing' : 'Publish'}
                </button>
              </div>
            </div>
          </div>
        )}
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
        onFinish={() => void finishEditing()}
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
