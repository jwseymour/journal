import Link from 'next/link';
import { listPublicEntries } from '@/lib/api';
import { formatDate } from '@/lib/format';
import styles from '../page.module.css';

export const dynamic = 'force-dynamic';

/** Every published entry, newest-written-first (`requirements.md` §10,
 * `plan.md` M15) — same list shape as the documents index, minus a title:
 * an entry never has one. */
export default async function EntriesPage() {
  const entries = await listPublicEntries();

  if (entries.length === 0) {
    return <p className={styles.empty}>Nothing published yet.</p>;
  }

  return (
    <ol className={styles.list}>
      {entries.map((entry) => (
        <li key={entry.slug}>
          <Link href={`/entries/${entry.slug}`} className={styles.row}>
            <time dateTime={entry.created} className={styles.when}>
              {formatDate(entry.created)}
            </time>
            <span className={styles.excerpt}>{entry.excerpt}</span>
          </Link>
        </li>
      ))}
    </ol>
  );
}
