'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { OpenQuestion } from '@journal/contract';
import { formatDate, formatTime } from '@/lib/format';
import { ApiRequestError, deleteQuestion, listQuestions, reopenQuestion } from '@/lib/api';
import styles from './page.module.css';

const LIMIT = 200;

interface QuestionsData {
  open: OpenQuestion[];
  resolved: OpenQuestion[];
}

/**
 * Open questions (`plan.md` M8c) — something raised in one entry, and
 * possibly resolved by a later one. Never live, only whatever the last
 * `npm run reprocess` wrote. Two sections rather than one list split on
 * this side of the boundary: the backend's `status` filter already does
 * the splitting (`requirements.md` §7.1).
 */
export default function QuestionsPage() {
  const [data, setData] = useState<QuestionsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = () => {
    Promise.all([
      listQuestions({ status: 'open', limit: LIMIT }),
      listQuestions({ status: 'resolved', limit: LIMIT }),
    ])
      .then(([openResponse, resolvedResponse]) =>
        setData({ open: openResponse.questions, resolved: resolvedResponse.questions }),
      )
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not load questions.'));
  };

  useEffect(load, []);

  const discard = (id: string) => {
    setBusyId(id);
    deleteQuestion(id)
      .then(() =>
        setData(
          (current) =>
            current && {
              open: current.open.filter((q) => q.id !== id),
              resolved: current.resolved.filter((q) => q.id !== id),
            },
        ),
      )
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not discard.'))
      .finally(() => setBusyId(null));
  };

  const reopen = (id: string) => {
    setBusyId(id);
    reopenQuestion(id)
      .then(() =>
        setData((current) => {
          if (!current) return current;
          const question = current.resolved.find((q) => q.id === id);
          if (!question) return current;
          const reopened: OpenQuestion = { ...question, status: 'open', resolvedEntryId: null, resolution: null };
          return {
            open: [reopened, ...current.open],
            resolved: current.resolved.filter((q) => q.id !== id),
          };
        }),
      )
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not reopen.'))
      .finally(() => setBusyId(null));
  };

  if (error) return <p className={styles.error}>{error}</p>;
  if (data === null) return <p className={styles.hint}>Loading…</p>;
  if (data.open.length === 0 && data.resolved.length === 0) {
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
        <h2 className={styles.heading}>Open</h2>
        {data.open.length === 0 ? (
          <p className={styles.empty}>Nothing currently open.</p>
        ) : (
          <ol className={styles.list}>
            {data.open.map((question) => (
              <li key={question.id} className={styles.row}>
                <div className={styles.main}>
                  <span className={styles.when}>
                    <time dateTime={question.eventTime}>{formatDate(question.eventTime)}</time>
                    <span>{formatTime(question.eventTime)}</span>
                    {!question.eventTimeExplicit && <span>(from the entry’s own time)</span>}
                  </span>
                  <span className={styles.text}>{question.question}</span>
                  <Link href={`/entry/${question.entryId}`} className={styles.link}>
                    Source entry
                  </Link>
                </div>
                <button
                  type="button"
                  className={styles.discard}
                  onClick={() => discard(question.id)}
                  disabled={busyId === question.id}
                >
                  Discard
                </button>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className={styles.section}>
        <h2 className={styles.heading}>Resolved</h2>
        {data.resolved.length === 0 ? (
          <p className={styles.empty}>Nothing resolved yet.</p>
        ) : (
          <ol className={styles.list}>
            {data.resolved.map((question) => (
              <li key={question.id} className={styles.row}>
                <div className={styles.main}>
                  <span className={styles.when}>
                    <time dateTime={question.eventTime}>{formatDate(question.eventTime)}</time>
                    <span>{formatTime(question.eventTime)}</span>
                    {!question.eventTimeExplicit && <span>(from the entry’s own time)</span>}
                  </span>
                  <span className={styles.text}>{question.question}</span>
                  {question.resolution && <span className={styles.resolution}>{question.resolution}</span>}
                  <span className={styles.sources}>
                    <Link href={`/entry/${question.entryId}`} className={styles.link}>
                      Raised in
                    </Link>
                    {question.resolvedEntryId && (
                      <Link href={`/entry/${question.resolvedEntryId}`} className={styles.link}>
                        Resolved in
                      </Link>
                    )}
                  </span>
                </div>
                <div className={styles.actions}>
                  <button
                    type="button"
                    className={styles.reopen}
                    onClick={() => reopen(question.id)}
                    disabled={busyId === question.id}
                  >
                    Reopen
                  </button>
                  <button
                    type="button"
                    className={styles.discard}
                    onClick={() => discard(question.id)}
                    disabled={busyId === question.id}
                  >
                    Discard
                  </button>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
