'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { Entry } from '@journal/contract';
import { Composer } from '@/components/composer';
import { Markdown } from '@/components/markdown';
import { addAttachment, ApiRequestError, processEntry, updateEntry } from '@/lib/api';
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
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [entry, setEntry] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(initial.body);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [processError, setProcessError] = useState<string | null>(null);

  /**
   * Runs the AI layer for this entry, live (`plan.md` M15) — after
   * finishing writing it for the first time, and again after finishing any
   * later edit. Safe either way: a touched record is never overwritten by
   * this, only offered an update suggestion (`requirements.md` §6.4).
   * Never blocks navigation or saving on its own result — extraction can
   * fail (no `AI_GATEWAY_API_KEY` configured) without that being a reason
   * to lose what was just written.
   */
  const runProcessing = useCallback(async (id: string) => {
    setProcessing(true);
    setProcessError(null);
    try {
      await processEntry(id);
    } catch (cause) {
      setProcessError(cause instanceof ApiRequestError ? cause.message : 'Could not run AI analysis.');
    } finally {
      setProcessing(false);
    }
  }, []);

  // Arrived straight from finishing a new entry (`entry/new/page.tsx`'s
  // `finish()`) — the one moment "process this" fires without an explicit
  // click, because finishing *is* the explicit act. The query flag is
  // stripped immediately so a reload or the back button never re-triggers it.
  const processedOnArrival = useRef(false);
  useEffect(() => {
    if (processedOnArrival.current) return;
    if (searchParams.get('process') !== '1') return;
    processedOnArrival.current = true;
    router.replace(pathname, { scroll: false });
    // Deferred a tick so the state update below isn't synchronous within
    // the effect body itself (`react-hooks/set-state-in-effect`).
    queueMicrotask(() => void runProcessing(entry.id));
    // Only ever runs once, off the entry this page loaded with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // Finishing an edit re-runs the same AI layer pass (`plan.md` M15) — the
  // entry's content just changed, and re-extraction is exactly what keeps
  // derived structure in step with it, touched-safe either way.
  const finishEditing = async (): Promise<void> => {
    const ok = await save();
    if (ok) {
      setEditing(false);
      void runProcessing(entry.id);
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
        {processing && <p className={styles.processing}>Running AI analysis…</p>}
        {processError && !processing && <p className={styles.processError}>{processError}</p>}
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
