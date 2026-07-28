'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { EntrySummary } from '@journal/contract';
import { useGlobalKey } from '@/lib/keyboard';
import { formatDate, formatTime } from '@/lib/format';
import styles from './page.module.css';

/**
 * The list, with `j` / `k` / `↩` navigation (`design.md` §5.2).
 *
 * A client component purely for the keyboard state — the page it renders on
 * stays a server component that fetches the actual data, per
 * `requirements.md` §7.1: nothing here decides what to show, only how to move
 * a selection through what it was given.
 */
export function EntryList({
  entries,
  cursor,
  nextCursor,
}: {
  entries: EntrySummary[];
  cursor?: string;
  nextCursor: string | null;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState(-1);

  useGlobalKey('j', () => setSelected((i) => Math.min(i + 1, entries.length - 1)));
  useGlobalKey('k', () => setSelected((i) => Math.max(i - 1, 0)));
  useGlobalKey('Enter', () => {
    const entry = entries[selected];
    if (entry) router.push(`/entry/${entry.id}`);
  });

  return (
    <>
      <ol className={styles.list}>
        {entries.map((entry, index) => (
          <li key={entry.id}>
            <Link
              href={`/entry/${entry.id}`}
              className={index === selected ? `${styles.item} ${styles.selected}` : styles.item}
              onMouseEnter={() => setSelected(index)}
            >
              <span className={styles.when}>
                <time dateTime={entry.created}>{formatDate(entry.created)}</time>
                <span>{formatTime(entry.created)}</span>
              </span>
              <span className={styles.excerpt}>{entry.excerpt}</span>
            </Link>
          </li>
        ))}
      </ol>

      {(cursor || nextCursor) && (
        <div className={styles.pagination}>
          {cursor && <Link href="/">Most recent</Link>}
          {nextCursor && <Link href={`/?cursor=${encodeURIComponent(nextCursor)}`}>Older</Link>}
        </div>
      )}
    </>
  );
}
