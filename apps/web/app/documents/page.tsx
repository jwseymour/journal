'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { DocumentSummary } from '@journal/contract';
import { formatDate } from '@/lib/format';
import { ApiRequestError, listDocuments } from '@/lib/api';
import styles from './page.module.css';

const LIMIT = 100;

/**
 * Documents (`requirements.md` §9, `plan.md` M12) — directly authored, not
 * AI-derived, so unlike the M10 record pages this list has no touched pill
 * and no pending-suggestions section: nothing here was ever proposed by
 * extraction, and nothing here is ever silently regenerated.
 */
export default function DocumentsPage() {
  const [documents, setDocuments] = useState<DocumentSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listDocuments({ limit: LIMIT })
      .then((page) => setDocuments(page.documents))
      .catch((cause: unknown) =>
        setError(cause instanceof ApiRequestError ? cause.message : 'Could not load documents.'),
      );
  }, []);

  if (error) return <p className={styles.error}>{error}</p>;
  if (documents === null) return <p className={styles.hint}>Loading…</p>;

  return (
    <div>
      <div className={styles.head}>
        <Link href="/documents/new" className={styles.newLink}>
          New document
        </Link>
      </div>

      {documents.length === 0 ? (
        <p className={styles.empty}>No documents yet.</p>
      ) : (
        <ol className={styles.list}>
          {documents.map((document) => (
            <li key={document.id} className={styles.row}>
              <Link href={`/documents/${document.id}`} className={styles.main}>
                <span className={styles.title}>{document.title}</span>
                <span className={styles.excerpt}>{document.excerpt}</span>
                <span className={styles.when}>Updated {formatDate(document.updated)}</span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
