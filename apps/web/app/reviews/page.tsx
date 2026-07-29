'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { Review } from '@journal/contract';
import { formatDate, formatRating, formatTime } from '@/lib/format';
import { ApiRequestError, deleteReview, listReviews } from '@/lib/api';
import styles from './page.module.css';

const LIMIT = 100;

/**
 * Extracted reviews (`plan.md` M8, `requirements.md` §5.2) — never live,
 * only whatever the last `npm run reprocess` wrote. Same shape as
 * `app/metrics/page.tsx`: a plain list, not an analysis surface, so the
 * data is visible and a wrong record can be discarded
 * (`requirements.md` §6.2) without `curl`.
 */
export default function ReviewsPage() {
  const [reviews, setReviews] = useState<Review[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  useEffect(() => {
    listReviews({ limit: LIMIT })
      .then((response) => setReviews(response.reviews))
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not load reviews.'));
  }, []);

  const discard = (id: string) => {
    setRemovingId(id);
    deleteReview(id)
      .then(() => setReviews((current) => current?.filter((r) => r.id !== id) ?? current))
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not discard.'))
      .finally(() => setRemovingId(null));
  };

  if (error) return <p className={styles.error}>{error}</p>;
  if (reviews === null) return <p className={styles.hint}>Loading…</p>;
  if (reviews.length === 0) {
    return (
      <p className={styles.empty}>
        Nothing extracted yet. Run <code>npm run reprocess</code> with <code>AI_GATEWAY_API_KEY</code>{' '}
        configured.
      </p>
    );
  }

  return (
    <ol className={styles.list}>
      {reviews.map((review) => (
        <li key={review.id} className={styles.row}>
          <div className={styles.main}>
            <span className={styles.when}>
              <time dateTime={review.eventTime}>{formatDate(review.eventTime)}</time>
              <span>{formatTime(review.eventTime)}</span>
              {!review.eventTimeExplicit && <span>(from the entry’s own time)</span>}
            </span>
            <span className={styles.medium}>{review.medium}</span>
            <span className={styles.title}>
              {review.title}
              {review.rating !== null && <span className={styles.rating}>{formatRating(review.rating)}</span>}
            </span>
            {review.opinion && <span className={styles.opinion}>{review.opinion}</span>}
            <Link href={`/entry/${review.entryId}`} className={styles.link}>
              Source entry
            </Link>
          </div>
          <button
            type="button"
            className={styles.discard}
            onClick={() => discard(review.id)}
            disabled={removingId === review.id}
          >
            Discard
          </button>
        </li>
      ))}
    </ol>
  );
}
