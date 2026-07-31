'use client';

import Link from 'next/link';
import { formatDate, formatTime } from '@/lib/format';
import { useSearch } from '@/lib/use-search';
import styles from './home-search.module.css';

const INLINE_LIMIT = 5;

/**
 * The home page's embedded search box (`requirements.md` §8) — results
 * appear inline as you type, capped to a handful of hits so this section
 * stays small next to Recent and the Year/Month browser below it; `/search`
 * remains the uncapped view for a query worth reading through in full.
 *
 * The debounce/request-guard logic itself lives in `lib/use-search.ts`,
 * shared with the dedicated `/search` page.
 */
export function HomeSearch() {
  const { query, setQuery, trimmedQuery, hits, errorMessage, searching } = useSearch(INLINE_LIMIT);

  return (
    <div>
      <input
        type="text"
        className={styles.field}
        placeholder="Search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        aria-label="Search"
      />

      {errorMessage && <p className={styles.error}>{errorMessage}</p>}

      {!errorMessage && searching && <p className={styles.hint}>Searching…</p>}

      {!errorMessage && hits !== null && hits.length === 0 && (
        <p className={styles.empty}>Nothing found.</p>
      )}

      {hits && hits.length > 0 && (
        <>
          <ol className={styles.results}>
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
          <Link href={`/search?q=${encodeURIComponent(trimmedQuery)}`} className={styles.seeAll}>
            See all results →
          </Link>
        </>
      )}
    </div>
  );
}
