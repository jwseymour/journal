import { notFound } from 'next/navigation';
import { Markdown } from '@/components/markdown';
import { getPublicEntry } from '@/lib/api';
import { formatDate } from '@/lib/format';
import styles from '../../[slug]/page.module.css';

export const dynamic = 'force-dynamic';

/** One published entry, read-only (`requirements.md` §10, `plan.md` M15).
 * A slug that doesn't resolve — never published, unpublished since, or
 * simply wrong — renders the ordinary Next.js not-found page. */
export default async function EntryPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const entry = await getPublicEntry(slug);
  if (!entry) notFound();

  return (
    <article>
      <time dateTime={entry.created} className={styles.when}>
        {formatDate(entry.created)}
      </time>
      <Markdown slug={entry.slug}>{entry.body}</Markdown>
    </article>
  );
}
