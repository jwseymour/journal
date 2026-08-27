import Link from 'next/link';
import { listPublicDocuments } from '@/lib/api';
import { formatDate } from '@/lib/format';
import styles from './page.module.css';

export const dynamic = 'force-dynamic';

/** The whole front page: every public document, newest-written-first
 * (`requirements.md` §10, `plan.md` M14). */
export default async function HomePage() {
  const documents = await listPublicDocuments();

  if (documents.length === 0) {
    return <p className={styles.empty}>Nothing published yet.</p>;
  }

  return (
    <ol className={styles.list}>
      {documents.map((document) => (
        <li key={document.slug}>
          <Link href={`/${document.slug}`} className={styles.row}>
            <span className={styles.title}>{document.title}</span>
            <time dateTime={document.created} className={styles.when}>
              {formatDate(document.created)}
            </time>
            <span className={styles.excerpt}>{document.excerpt}</span>
          </Link>
        </li>
      ))}
    </ol>
  );
}
