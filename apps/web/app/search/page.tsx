'use client';

import Link from 'next/link';
import { formatDate, formatTime } from '@/lib/format';
import { searchHitHref, searchHitKey } from '@/lib/search-hit';
import { useSearch } from '@/lib/use-search';
import styles from './page.module.css';

/**
 * Search by meaning, not only by word (`plan.md` M6, `requirements.md` §8).
 *
 * A client component because the query is typed live — the ranking itself,
 * the fusion of text and vector search, and every decision about what counts
 * as a match all live behind `GET /search`; this page only renders whatever
 * comes back (`requirements.md` §7.1). The debounce/request-guard logic
 * itself lives in `lib/use-search.ts`, shared with the home page's embedded
 * search box.
 */
export default function SearchPage() {
  const { query, setQuery, trimmedQuery, hits, errorMessage, searching } = useSearch();

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
          {hits.map((hit) => (
            <li key={searchHitKey(hit)}>
              <Link href={searchHitHref(hit)} className={styles.item}>
                {hit.sourceType === 'entry' ? (
                  <span className={styles.when}>
                    <time dateTime={hit.created}>{formatDate(hit.created)}</time>
                    <span>{formatTime(hit.created)}</span>
                  </span>
                ) : (
                  <span className={styles.when}>{hit.title}</span>
                )}
                <span className={styles.passage}>{hit.passage}</span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
