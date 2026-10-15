'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { ListItem, ListItemUpdateSuggestion } from '@journal/contract';
import { formatDate, formatRating, formatTime } from '@/lib/format';
import {
  ApiRequestError,
  approveListItemUpdateSuggestion,
  deleteListItem,
  listListItems,
  listListItemUpdateSuggestions,
  publishListItem,
  rejectListItemUpdateSuggestion,
  untouchListItem,
  unpublishListItem,
  updateListItem,
  validateListItem,
} from '@/lib/api';
import styles from './page.module.css';

const LIMIT = 100;

/**
 * Extracted atomic list items (`plan.md` M8, `requirements.md` §5.2) — for
 * example quotes. Same shape as `app/metrics/page.tsx`: a plain list of what
 * a past `npm run reprocess` wrote, plus whatever has since been approved
 * from a live `Process` run's popup or `/pending` queue (`plan.md` M18).
 *
 * Editing and validating (`requirements.md` §2, §6.4, `plan.md` M10) is
 * scoped to `text`, the item itself — `context`, `importance`, and
 * `eventTime` corrections are not yet surfaced in this UI.
 */
export default function ListsPage() {
  const [items, setItems] = useState<ListItem[] | null>(null);
  const [suggestions, setSuggestions] = useState<ListItemUpdateSuggestion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const load = () => {
    Promise.all([listListItems({ limit: LIMIT }), listListItemUpdateSuggestions('pending')])
      .then(([itemsResponse, suggestionsResponse]) => {
        setItems(itemsResponse.items);
        setSuggestions(suggestionsResponse.suggestions);
      })
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not load lists.'));
  };

  useEffect(load, []);

  const discard = (id: string) => {
    setRemovingId(id);
    deleteListItem(id)
      .then(() => setItems((current) => current?.filter((i) => i.id !== id) ?? current))
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not discard.'))
      .finally(() => setRemovingId(null));
  };

  const toggleTouched = (item: ListItem) => {
    setBusyId(item.id);
    (item.touched ? untouchListItem(item.id) : validateListItem(item.id))
      .then(() =>
        setItems((current) => current?.map((i) => (i.id === item.id ? { ...i, touched: !item.touched } : i)) ?? current),
      )
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not update.'))
      .finally(() => setBusyId(null));
  };

  const togglePublished = (item: ListItem) => {
    setBusyId(item.id);
    (item.published ? unpublishListItem(item.id) : publishListItem(item.id))
      .then(() =>
        setItems(
          (current) => current?.map((i) => (i.id === item.id ? { ...i, published: !item.published } : i)) ?? current,
        ),
      )
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not update.'))
      .finally(() => setBusyId(null));
  };

  const startEdit = (item: ListItem) => {
    setEditingId(item.id);
    setDraft(item.text);
  };

  const saveEdit = (id: string) => {
    setBusyId(id);
    updateListItem(id, { text: draft })
      .then(() => {
        setItems((current) => current?.map((i) => (i.id === id ? { ...i, text: draft, touched: true } : i)) ?? current);
        setEditingId(null);
      })
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not save.'))
      .finally(() => setBusyId(null));
  };

  const decideSuggestion = (id: string, decision: 'approve' | 'reject') => {
    setBusyId(id);
    (decision === 'approve' ? approveListItemUpdateSuggestion(id) : rejectListItemUpdateSuggestion(id))
      .then(() => {
        setSuggestions((current) => current?.filter((s) => s.id !== id) ?? current);
        if (decision === 'approve') load();
      })
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not decide.'))
      .finally(() => setBusyId(null));
  };

  if (error) return <p className={styles.error}>{error}</p>;
  if (items === null || suggestions === null) return <p className={styles.hint}>Loading…</p>;

  return (
    <div>
      {suggestions.length > 0 && (
        <section className={styles.suggestions}>
          <p className={styles.heading}>Reprocessing found changes to records you&apos;ve reviewed</p>
          <ul className={styles.suggestionList}>
            {suggestions.map((suggestion) => (
              <li key={suggestion.id} className={styles.suggestionRow}>
                <div className={styles.suggestionMain}>
                  <span className={styles.suggestionReason}>{suggestion.reason}</span>
                  <span className={styles.suggestionProposed}>Would become: {suggestion.text}</span>
                </div>
                <div className={styles.actions}>
                  <button
                    type="button"
                    className={styles.approveButton}
                    onClick={() => decideSuggestion(suggestion.id, 'approve')}
                    disabled={busyId === suggestion.id}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className={styles.rejectButton}
                    onClick={() => decideSuggestion(suggestion.id, 'reject')}
                    disabled={busyId === suggestion.id}
                  >
                    Keep mine
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {items.length === 0 ? (
        <p className={styles.empty}>
          Nothing extracted yet. Run <code>npm run reprocess</code> with <code>AI_GATEWAY_API_KEY</code>{' '}
          configured.
        </p>
      ) : (
        <ol className={styles.list}>
          {items.map((item) => (
            <li key={item.id} className={styles.row}>
              <div className={styles.main}>
                <span className={styles.when}>
                  <time dateTime={item.eventTime}>{formatDate(item.eventTime)}</time>
                  <span>{formatTime(item.eventTime)}</span>
                  {!item.eventTimeExplicit && <span>(from the entry’s own time)</span>}
                  {item.touched && <span className={styles.touched}>touched</span>}
                  {item.published && <span className={styles.published}>published</span>}
                </span>
                <span className={styles.type}>{item.listType}</span>
                {editingId === item.id ? (
                  <div className={styles.editForm}>
                    <textarea
                      className={styles.textarea}
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      aria-label="Text"
                    />
                    <div className={styles.actions}>
                      <button
                        type="button"
                        className={styles.approveButton}
                        onClick={() => saveEdit(item.id)}
                        disabled={busyId === item.id}
                      >
                        Save
                      </button>
                      <button type="button" className={styles.rejectButton} onClick={() => setEditingId(null)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <span className={styles.text}>
                    {item.text}
                    {item.importance !== null && <span className={styles.importance}>{formatRating(item.importance)}</span>}
                  </span>
                )}
                {item.context && <span className={styles.context}>{item.context}</span>}
                <Link href={`/entry/${item.entryId}`} className={styles.link}>
                  Source entry
                </Link>
              </div>
              {editingId !== item.id && (
                <div className={styles.rowActions}>
                  <button type="button" className={styles.editButton} onClick={() => startEdit(item)}>
                    Edit
                  </button>
                  <button
                    type="button"
                    className={styles.editButton}
                    onClick={() => toggleTouched(item)}
                    disabled={busyId === item.id}
                  >
                    {item.touched ? 'Untouch' : 'Validate'}
                  </button>
                  <button
                    type="button"
                    className={styles.editButton}
                    onClick={() => togglePublished(item)}
                    disabled={busyId === item.id}
                  >
                    {item.published ? 'Unpublish' : 'Publish'}
                  </button>
                  <button
                    type="button"
                    className={styles.discard}
                    onClick={() => discard(item.id)}
                    disabled={removingId === item.id}
                  >
                    Discard
                  </button>
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
