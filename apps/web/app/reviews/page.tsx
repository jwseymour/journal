'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { Review, ReviewUpdateSuggestion } from '@journal/contract';
import { formatDate, formatRating, formatTime } from '@/lib/format';
import {
  ApiRequestError,
  approveReviewUpdateSuggestion,
  deleteReview,
  listReviews,
  listReviewUpdateSuggestions,
  rejectReviewUpdateSuggestion,
  untouchReview,
  updateReview,
  validateReview,
} from '@/lib/api';
import styles from './page.module.css';

const LIMIT = 100;

/**
 * Extracted reviews (`plan.md` M8, `requirements.md` §5.2) — never live,
 * only whatever the last `npm run reprocess` wrote. Same shape as
 * `app/metrics/page.tsx`: a plain list, not an analysis surface, so the
 * data is visible and a wrong record can be discarded
 * (`requirements.md` §6.2) without `curl`.
 *
 * Editing and validating (`requirements.md` §2, §6.4, `plan.md` M10) is
 * scoped to `opinion`, the free-text take — rating, progress, and
 * `eventTime` corrections are not yet surfaced in this UI.
 */
export default function ReviewsPage() {
  const [reviews, setReviews] = useState<Review[] | null>(null);
  const [suggestions, setSuggestions] = useState<ReviewUpdateSuggestion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const load = () => {
    Promise.all([listReviews({ limit: LIMIT }), listReviewUpdateSuggestions('pending')])
      .then(([reviewsResponse, suggestionsResponse]) => {
        setReviews(reviewsResponse.reviews);
        setSuggestions(suggestionsResponse.suggestions);
      })
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not load reviews.'));
  };

  useEffect(load, []);

  const discard = (id: string) => {
    setRemovingId(id);
    deleteReview(id)
      .then(() => setReviews((current) => current?.filter((r) => r.id !== id) ?? current))
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not discard.'))
      .finally(() => setRemovingId(null));
  };

  const toggleTouched = (review: Review) => {
    setBusyId(review.id);
    (review.touched ? untouchReview(review.id) : validateReview(review.id))
      .then(() =>
        setReviews(
          (current) => current?.map((r) => (r.id === review.id ? { ...r, touched: !review.touched } : r)) ?? current,
        ),
      )
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not update.'))
      .finally(() => setBusyId(null));
  };

  const startEdit = (review: Review) => {
    setEditingId(review.id);
    setDraft(review.opinion);
  };

  const saveEdit = (id: string) => {
    setBusyId(id);
    updateReview(id, { opinion: draft })
      .then(() => {
        setReviews((current) => current?.map((r) => (r.id === id ? { ...r, opinion: draft, touched: true } : r)) ?? current);
        setEditingId(null);
      })
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not save.'))
      .finally(() => setBusyId(null));
  };

  const decideSuggestion = (id: string, decision: 'approve' | 'reject') => {
    setBusyId(id);
    (decision === 'approve' ? approveReviewUpdateSuggestion(id) : rejectReviewUpdateSuggestion(id))
      .then(() => {
        setSuggestions((current) => current?.filter((s) => s.id !== id) ?? current);
        if (decision === 'approve') load();
      })
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not decide.'))
      .finally(() => setBusyId(null));
  };

  if (error) return <p className={styles.error}>{error}</p>;
  if (reviews === null || suggestions === null) return <p className={styles.hint}>Loading…</p>;

  return (
    <div>
      {suggestions.length > 0 && (
        <section className={styles.suggestions}>
          <p className={styles.heading}>Reprocessing found changes to records you've reviewed</p>
          <ul className={styles.suggestionList}>
            {suggestions.map((suggestion) => (
              <li key={suggestion.id} className={styles.suggestionRow}>
                <div className={styles.suggestionMain}>
                  <span className={styles.suggestionReason}>{suggestion.reason}</span>
                  <span className={styles.suggestionProposed}>Would become: {suggestion.opinion}</span>
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

      {reviews.length === 0 ? (
        <p className={styles.empty}>
          Nothing extracted yet. Run <code>npm run reprocess</code> with <code>AI_GATEWAY_API_KEY</code>{' '}
          configured.
        </p>
      ) : (
        <ol className={styles.list}>
          {reviews.map((review) => (
            <li key={review.id} className={styles.row}>
              <div className={styles.main}>
                <span className={styles.when}>
                  <time dateTime={review.eventTime}>{formatDate(review.eventTime)}</time>
                  <span>{formatTime(review.eventTime)}</span>
                  {!review.eventTimeExplicit && <span>(from the entry’s own time)</span>}
                  {review.touched && <span className={styles.touched}>touched</span>}
                </span>
                <span className={styles.medium}>{review.medium}</span>
                <span className={styles.title}>
                  {review.title}
                  {review.rating !== null && <span className={styles.rating}>{formatRating(review.rating)}</span>}
                  {review.progress !== null && <span className={styles.progress}>{review.progress}%</span>}
                </span>
                {editingId === review.id ? (
                  <div className={styles.editForm}>
                    <textarea
                      className={styles.textarea}
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      aria-label="Opinion"
                    />
                    <div className={styles.actions}>
                      <button
                        type="button"
                        className={styles.approveButton}
                        onClick={() => saveEdit(review.id)}
                        disabled={busyId === review.id}
                      >
                        Save
                      </button>
                      <button type="button" className={styles.rejectButton} onClick={() => setEditingId(null)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  review.opinion && <span className={styles.opinion}>{review.opinion}</span>
                )}
                <Link href={`/entry/${review.entryId}`} className={styles.link}>
                  Source entry
                </Link>
              </div>
              {editingId !== review.id && (
                <div className={styles.rowActions}>
                  <button type="button" className={styles.editButton} onClick={() => startEdit(review)}>
                    Edit
                  </button>
                  <button
                    type="button"
                    className={styles.editButton}
                    onClick={() => toggleTouched(review)}
                    disabled={busyId === review.id}
                  >
                    {review.touched ? 'Untouch' : 'Validate'}
                  </button>
                  <button
                    type="button"
                    className={styles.discard}
                    onClick={() => discard(review.id)}
                    disabled={removingId === review.id}
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
