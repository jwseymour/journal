'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { SearchHit } from '@journal/contract';
import { formatDate, formatTime } from '@/lib/format';
import { ApiRequestError, search } from '@/lib/api';
import styles from './page.module.css';

/**
 * Search by meaning, not only by word (`plan.md` M6, `requirements.md` §8).
 *
 * A client component because the query is typed live — the ranking itself,
 * the fusion of text and vector search, and every decision about what counts
 * as a match all live behind `GET /search`; this page only renders whatever
 * comes back (`requirements.md` §7.1).
 *
 * Debounced rather than fired on every keystroke, the same shape as autosave
 * in `entry/new/page.tsx` — a query is a sentence someone is still typing,
 * not a single character worth a round trip on its own.
 *
 * `result`/`failure` are each keyed by the query they answer, the same
 * pattern `components/reference-pane.tsx` uses for its detail fetch — a
 * response for a query that has since changed is simply not for the current
 * query, rather than a separate "loading" flag that has to be reset by hand
 * (and that a `useEffect` may not set synchronously in the first place).
 */
const SEARCH_DEBOUNCE_MS = 300;

interface Result {
  query: string;
  hits: SearchHit[];
}

interface Failure {
  query: string;
  message: string;
}

export default function SearchPage() {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);

  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guards a reply from an earlier, slower request overwriting a later one.
  const requestId = useRef(0);

  useEffect(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);

    const trimmed = query.trim();
    if (trimmed.length === 0) return;

    debounceTimer.current = setTimeout(() => {
      const id = ++requestId.current;
      search(trimmed)
        .then((response) => {
          if (id !== requestId.current) return;
          setResult({ query: trimmed, hits: response.hits });
          setFailure(null);
        })
        .catch((cause: unknown) => {
          if (id !== requestId.current) return;
          setFailure({
            query: trimmed,
            message: cause instanceof ApiRequestError ? cause.message : 'Search failed.',
          });
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [query]);

  const trimmedQuery = query.trim();
  const hits = result?.query === trimmedQuery ? result.hits : null;
  const errorMessage = failure?.query === trimmedQuery ? failure.message : null;
  const searching = trimmedQuery !== '' && hits === null && errorMessage === null;

  return (
    <div>
      <input
        type="text"
        className={styles.field}
        placeholder="Search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        autoFocus
        aria-label="Search"
      />

      {trimmedQuery === '' && <p className={styles.hint}>Describing what you are looking for finds it.</p>}

      {errorMessage && <p className={styles.error}>{errorMessage}</p>}

      {!errorMessage && searching && <p className={styles.hint}>Searching…</p>}

      {!errorMessage && hits !== null && hits.length === 0 && <p className={styles.empty}>Nothing found.</p>}

      {hits && hits.length > 0 && (
        <ol className={styles.list}>
          {hits.map((hit, index) => (
            <li key={`${hit.entryId}-${index}`}>
              <Link href={`/entry/${hit.entryId}`} className={styles.item}>
                <span className={styles.when}>
                  <time dateTime={hit.created}>{formatDate(hit.created)}</time>
                  <span>{formatTime(hit.created)}</span>
                </span>
                <span className={styles.passage}>{hit.passage}</span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
