'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { ListItem } from '@journal/contract';
import { formatDate, formatTime } from '@/lib/format';
import { ApiRequestError, deleteListItem, listListItems } from '@/lib/api';
import styles from './page.module.css';

const LIMIT = 100;

/**
 * Extracted atomic list items (`plan.md` M8, `requirements.md` §5.2) — for
 * example quotes. Same shape as `app/metrics/page.tsx`: a plain list, never
 * live, only whatever the last `npm run reprocess` wrote.
 */
export default function ListsPage() {
  const [items, setItems] = useState<ListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  useEffect(() => {
    listListItems({ limit: LIMIT })
      .then((response) => setItems(response.items))
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not load lists.'));
  }, []);

  const discard = (id: string) => {
    setRemovingId(id);
    deleteListItem(id)
      .then(() => setItems((current) => current?.filter((i) => i.id !== id) ?? current))
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not discard.'))
      .finally(() => setRemovingId(null));
  };

  if (error) return <p className={styles.error}>{error}</p>;
  if (items === null) return <p className={styles.hint}>Loading…</p>;
  if (items.length === 0) {
    return (
      <p className={styles.empty}>
        Nothing extracted yet. Run <code>npm run reprocess</code> with <code>AI_GATEWAY_API_KEY</code>{' '}
        configured.
      </p>
    );
  }

  return (
    <ol className={styles.list}>
      {items.map((item) => (
        <li key={item.id} className={styles.row}>
          <div className={styles.main}>
            <span className={styles.when}>
              <time dateTime={item.eventTime}>{formatDate(item.eventTime)}</time>
              <span>{formatTime(item.eventTime)}</span>
              {!item.eventTimeExplicit && <span>(from the entry’s own time)</span>}
            </span>
            <span className={styles.type}>{item.listType}</span>
            <span className={styles.text}>{item.text}</span>
            {item.context && <span className={styles.context}>{item.context}</span>}
            <Link href={`/entry/${item.entryId}`} className={styles.link}>
              Source entry
            </Link>
          </div>
          <button
            type="button"
            className={styles.discard}
            onClick={() => discard(item.id)}
            disabled={removingId === item.id}
          >
            Discard
          </button>
        </li>
      ))}
    </ol>
  );
}
