import Link from 'next/link';
import type { EntryPage } from '@journal/contract';
import { Notice } from '@/components/notice';
import { ApiRequestError, listEntries } from '@/lib/api';
import { formatDate, formatTime } from '@/lib/format';
import styles from './page.module.css';

/**
 * The list. Newest first, one page at a time.
 *
 * Never prerendered: what is on disk is the truth, and a journal must not serve
 * a snapshot taken at build time.
 */
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 30;

/**
 * Note what is deliberately absent: any total, any count of entries written,
 * any calendar of activity. Per-entry facts are content and are fine; an
 * aggregate over writing *behaviour* is a streak by another name
 * (`design.md` §4, `plan.md` standing rule 7).
 */
export default async function EntriesPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>;
}) {
  const { cursor } = await searchParams;

  let page: EntryPage;
  try {
    page = await listEntries({ limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) });
  } catch (error) {
    if (error instanceof ApiRequestError && error.code === 'invalid_cursor') {
      return (
        <Notice title="That link is no longer valid.">
          <Link href="/">Back to the most recent entries</Link>
        </Notice>
      );
    }
    return (
      <Notice title="The journal could not be read." tone="danger">
        {error instanceof ApiRequestError ? error.message : 'Something went wrong.'}
      </Notice>
    );
  }

  if (page.entries.length === 0) {
    return (
      <p className={styles.empty}>
        {cursor ? (
          <>
            Nothing older. <Link href="/">Back to the most recent entries</Link>
          </>
        ) : (
          'No entries.'
        )}
      </p>
    );
  }

  return (
    <>
      <ol className={styles.list}>
        {page.entries.map((entry) => (
          <li key={entry.id}>
            <Link href={`/entry/${entry.id}`} className={styles.item}>
              <span className={styles.when}>
                <time dateTime={entry.created}>{formatDate(entry.created)}</time>
                <span>{formatTime(entry.created)}</span>
              </span>
              <span className={styles.excerpt}>{entry.excerpt}</span>
            </Link>
          </li>
        ))}
      </ol>

      {(cursor || page.nextCursor) && (
        <div className={styles.pagination}>
          {cursor && <Link href="/">Most recent</Link>}
          {page.nextCursor && (
            <Link href={`/?cursor=${encodeURIComponent(page.nextCursor)}`}>Older</Link>
          )}
        </div>
      )}
    </>
  );
}
