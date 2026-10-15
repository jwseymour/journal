'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { searchPublic, type PublicSearchHit } from '@/lib/api';
import { formatDate } from '@/lib/format';
import styles from './page.module.css';

const DEBOUNCE_MS = 300;

/** Search over exactly what's been published (`requirements.md` §8, §10,
 * `plan.md` M17) — BM25 text only, no vector search, since this app stays
 * minimal and has no embedding model of its own (`apps/public-api`'s own
 * doc comment on `public-search-index.ts` explains why). The only page in
 * this app that isn't a Server Component: a live search box has nothing
 * meaningful to server-render. */
export default function SearchPage() {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<PublicSearchHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestId = useRef(0);

  useEffect(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);

    const trimmed = query.trim();
    if (trimmed.length === 0) {
      // Drop any in-flight search; the input's onChange clears what's on screen.
      requestId.current++;
      return;
    }

    debounceTimer.current = setTimeout(() => {
      const id = ++requestId.current;
      searchPublic(trimmed)
        .then((result) => {
          if (id !== requestId.current) return;
          setHits(result);
          setError(null);
        })
        .catch(() => {
          if (id !== requestId.current) return;
          setError('Search failed.');
        });
    }, DEBOUNCE_MS);

    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [query]);

  return (
    <div>
      <input
        type="text"
        className={styles.field}
        placeholder="Search"
        value={query}
        onChange={(event) => {
          const value = event.target.value;
          setQuery(value);
          if (value.trim().length === 0) {
            setHits(null);
            setError(null);
          }
        }}
        autoFocus
        aria-label="Search"
      />

      {error && <p className={styles.empty}>{error}</p>}

      {!error && hits !== null && hits.length === 0 && <p className={styles.empty}>Nothing found.</p>}

      {hits && hits.length > 0 && (
        <ol className={styles.list}>
          {hits.map((hit, index) => (
            <li key={`${hit.sourceType}-${hit.slug}-${index}`}>
              <Link
                href={hit.sourceType === 'document' ? `/${hit.slug}` : `/entries/${hit.slug}`}
                className={styles.row}
              >
                {hit.sourceType === 'document' ? (
                  <span className={styles.when}>{hit.title}</span>
                ) : (
                  <time dateTime={hit.created} className={styles.when}>
                    {formatDate(hit.created)}
                  </time>
                )}
                <span className={styles.excerpt}>{hit.passage}</span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
