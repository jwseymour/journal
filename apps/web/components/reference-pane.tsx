'use client';

import { useEffect, useState } from 'react';
import type { Entry, EntrySummary } from '@journal/contract';
import { ApiRequestError, getEntry, listEntries } from '@/lib/api';
import { formatDate, formatTime } from '@/lib/format';
import { useReferencePane } from '@/lib/reference-pane';
import { Markdown } from './markdown';
import styles from './reference-pane.module.css';

/**
 * Previous entries, visible while writing (`requirements.md` §4.5,
 * `design.md` §5.1, §5.2 — `⌘⇧\`).
 *
 * A fixed side panel rather than a second column squeezed into the measured
 * text width — the comfortable measure is what makes the writing surface
 * calm (`design.md` §1.4), and this is an occasional reference tool, not
 * something that should permanently narrow the thing it is there to support.
 *
 * Read only. Nothing here writes back to an entry, and opening one for
 * reference is not the same act as editing it — that stays on its own page.
 */
/** What's known about the currently-selected reference entry, keyed by its id
 * so a stale fetch can never clobber a newer selection, and so "loading" is
 * simply "no detail yet matches the current id" rather than a separately
 * tracked flag that has to be reset by hand. */
interface Detail {
  id: string;
  entry: Entry | null;
  error: string | null;
}

export function ReferencePane() {
  const { open, close } = useReferencePane();
  const [entries, setEntries] = useState<EntrySummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);

  useEffect(() => {
    if (!open || entries !== null) return;
    listEntries({ limit: 20 })
      .then((page) => setEntries(page.entries))
      .catch((cause) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not load entries.'));
  }, [open, entries]);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    getEntry(selectedId)
      .then((entry) => {
        if (!cancelled) setDetail({ id: selectedId, entry, error: null });
      })
      .catch((cause) => {
        if (cancelled) return;
        const message = cause instanceof ApiRequestError ? cause.message : 'Could not load.';
        setDetail({ id: selectedId, entry: null, error: message });
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  if (!open) return null;

  const selected = detail?.id === selectedId ? detail.entry : null;
  const selectedError = detail?.id === selectedId ? detail.error : null;
  const selectedLoading = selectedId !== null && detail?.id !== selectedId;

  return (
    <aside className={styles.pane} aria-label="Reference: previous entries">
      <header className={styles.header}>
        <span className={styles.title}>Reference</span>
        <button type="button" className={styles.close} onClick={close} aria-label="Close reference pane">
          ⌘⇧\
        </button>
      </header>

      {selectedId ? (
        <div className={styles.detail}>
          <button type="button" className={styles.back} onClick={() => setSelectedId(null)}>
            ← Back
          </button>
          {selectedError && <p className={styles.error}>{selectedError}</p>}
          {selectedLoading && <p className={styles.loading}>Loading…</p>}
          {selected && (
            <>
              <p className={styles.when}>{formatDate(selected.created)}</p>
              <Markdown>{selected.body}</Markdown>
            </>
          )}
        </div>
      ) : (
        <ul className={styles.list}>
          {error && <li className={styles.error}>{error}</li>}
          {!error && entries === null && <li className={styles.loading}>Loading…</li>}
          {entries?.length === 0 && <li className={styles.loading}>No entries yet.</li>}
          {entries?.map((entry) => (
            <li key={entry.id}>
              <button type="button" className={styles.item} onClick={() => setSelectedId(entry.id)}>
                <span className={styles.itemWhen}>
                  {formatDate(entry.created)} · {formatTime(entry.created)}
                </span>
                <span className={styles.itemExcerpt}>{entry.excerpt}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
