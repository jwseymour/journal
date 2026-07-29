'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { OpinionStatement, OpinionSummary } from '@journal/contract';
import { formatDate, formatTime, formatTimestamp } from '@/lib/format';
import { ApiRequestError, deleteOpinionStatement, listOpinionStatements, listOpinionSummaries } from '@/lib/api';
import styles from './page.module.css';

const LIMIT = 200;

interface OpinionsData {
  summaries: OpinionSummary[];
  statements: OpinionStatement[];
}

/**
 * The opinion model (`plan.md` M8b, `requirements.md` §5.2) — two layers,
 * both rendered here, exactly as the API returns them. The regenerated,
 * cited summary per subject is the top layer — never hand-edited, only ever
 * whatever the last `npm run reprocess` wrote (`requirements.md` §9). The
 * full chronological statement record beneath it is what that summary was
 * built from, and the only layer a Discard button touches — correcting a
 * summary means discarding the statement it cites and reprocessing, not
 * editing the summary directly.
 */
export default function OpinionsPage() {
  const [data, setData] = useState<OpinionsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const load = () => {
    Promise.all([listOpinionSummaries(), listOpinionStatements({ limit: LIMIT })])
      .then(([summariesResponse, statementsResponse]) =>
        setData({ summaries: summariesResponse.summaries, statements: statementsResponse.statements }),
      )
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not load opinions.'));
  };

  useEffect(load, []);

  const discard = (id: string) => {
    setRemovingId(id);
    deleteOpinionStatement(id)
      .then(() =>
        setData((current) => current && { ...current, statements: current.statements.filter((s) => s.id !== id) }),
      )
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not discard.'))
      .finally(() => setRemovingId(null));
  };

  if (error) return <p className={styles.error}>{error}</p>;
  if (data === null) return <p className={styles.hint}>Loading…</p>;
  if (data.statements.length === 0) {
    return (
      <p className={styles.empty}>
        Nothing extracted yet. Run <code>npm run reprocess</code> with <code>AI_GATEWAY_API_KEY</code>{' '}
        configured.
      </p>
    );
  }

  return (
    <div>
      <section className={styles.section}>
        <h2 className={styles.heading}>Summaries</h2>
        {data.summaries.length === 0 ? (
          <p className={styles.empty}>
            No summary yet — run <code>npm run reprocess</code> again once statements exist.
          </p>
        ) : (
          data.summaries.map((summary) => (
            <div key={summary.subject} className={styles.summaryGroup}>
              <div className={styles.summaryHeadingRow}>
                <h3 className={styles.subjectHeading}>{summary.subject}</h3>
                {summary.generatedAt && (
                  <span className={styles.generated}>Generated {formatTimestamp(summary.generatedAt)}</span>
                )}
              </div>
              {summary.parts.map((part, index) => (
                <p key={index} className={styles.part}>
                  {part.text}
                  <span className={styles.sources}>
                    {part.sourceEntryIds.map((entryId) => (
                      <Link key={entryId} href={`/entry/${entryId}`} className={styles.link}>
                        Source entry
                      </Link>
                    ))}
                  </span>
                </p>
              ))}
            </div>
          ))
        )}
      </section>

      <section className={styles.section}>
        <h2 className={styles.heading}>Statements</h2>
        <ol className={styles.list}>
          {data.statements.map((statement) => (
            <li key={statement.id} className={styles.row}>
              <div className={styles.main}>
                <span className={styles.when}>
                  <time dateTime={statement.eventTime}>{formatDate(statement.eventTime)}</time>
                  <span>{formatTime(statement.eventTime)}</span>
                  {!statement.eventTimeExplicit && <span>(from the entry’s own time)</span>}
                </span>
                <span className={styles.subject}>{statement.subject}</span>
                <span className={styles.text}>{statement.statement}</span>
                <Link href={`/entry/${statement.entryId}`} className={styles.link}>
                  Source entry
                </Link>
              </div>
              <button
                type="button"
                className={styles.discard}
                onClick={() => discard(statement.id)}
                disabled={removingId === statement.id}
              >
                Discard
              </button>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
