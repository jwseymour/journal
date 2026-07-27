import { notFound } from 'next/navigation';
import type { Entry } from '@journal/contract';
import { Notice } from '@/components/notice';
import { ApiRequestError, getEntry } from '@/lib/api';
import { formatTimestamp } from '@/lib/format';
import styles from './page.module.css';

export const dynamic = 'force-dynamic';

/**
 * One entry, read only.
 *
 * The body is shown as the plain source it is. Rendered markdown, and the
 * `⌘⇧P` toggle between the two, arrive in M3 — until then this shows exactly
 * what is on disk, which is the more honest thing for the milestone that exists
 * to prove the record is intact (`plan.md` M1, M3).
 *
 * Location is not shown. Coordinates alone are not worth reading, and turning
 * them into a place name needs a geocoder, which is deferred — the coordinates
 * are stored and permanent, so a name can be produced at any point later
 * (`requirements.md` §4.3, §7.5).
 */
export default async function EntryDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let entry: Entry | null;
  try {
    entry = await getEntry(id);
  } catch (error) {
    return (
      <Notice title="That entry could not be read." tone="danger">
        {error instanceof ApiRequestError ? error.message : 'Something went wrong.'}
      </Notice>
    );
  }

  // Outside the try: `notFound()` signals by throwing, and catching it would
  // turn a missing entry into an error.
  if (!entry) notFound();

  return (
    <article className={styles.entry}>
      <header className={styles.head}>
        <time dateTime={entry.created}>{formatTimestamp(entry.created)}</time>
      </header>
      {/* `pre-wrap`, so the writing keeps the shape it was written in. */}
      <div className={styles.body}>{entry.body}</div>
    </article>
  );
}
