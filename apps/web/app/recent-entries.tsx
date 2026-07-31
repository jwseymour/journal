import Link from 'next/link';
import type { EntrySummary } from '@journal/contract';
import { formatDate, formatTime } from '@/lib/format';
import styles from './page.module.css';

/**
 * The most recent entry — controlled by `home-browser.tsx`, which owns the
 * one keyboard selection shared with the Year/Month tree below it.
 */
export function RecentEntries({
  entries,
  selectedKey,
  onSelectRow,
  registerRef,
}: {
  entries: EntrySummary[];
  selectedKey: string | null;
  onSelectRow: (key: string) => void;
  registerRef: (key: string) => (el: HTMLElement | null) => void;
}) {
  return (
    <ol className={styles.list}>
      {entries.map((entry) => {
        const key = `entry:${entry.id}`;
        return (
          <li key={entry.id}>
            <Link
              href={`/entry/${entry.id}`}
              ref={registerRef(key)}
              className={key === selectedKey ? `${styles.item} ${styles.selected}` : styles.item}
              onMouseEnter={() => onSelectRow(key)}
            >
              <span className={styles.when}>
                <time dateTime={entry.created}>{formatDate(entry.created)}</time>
                <span>{formatTime(entry.created)}</span>
              </span>
              <span className={styles.excerpt}>{entry.excerpt}</span>
            </Link>
          </li>
        );
      })}
    </ol>
  );
}
