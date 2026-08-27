import { notFound } from 'next/navigation';
import { Markdown } from '@/components/markdown';
import { getPublicDocument } from '@/lib/api';
import { formatDate } from '@/lib/format';
import styles from './page.module.css';

export const dynamic = 'force-dynamic';

/** One public document, read-only (`requirements.md` §10, `plan.md` M14).
 * A slug that doesn't resolve — never published, unpublished since, or
 * simply wrong — renders the ordinary Next.js not-found page; there is
 * nothing here to distinguish those cases from one another. */
export default async function DocumentPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const document = await getPublicDocument(slug);
  if (!document) notFound();

  return (
    <article>
      <h1 className={styles.title}>{document.title}</h1>
      <time dateTime={document.created} className={styles.when}>
        {formatDate(document.created)}
      </time>
      <Markdown>{document.body}</Markdown>
    </article>
  );
}
