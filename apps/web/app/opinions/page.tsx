'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { OpinionStatement, OpinionStatementUpdateSuggestion, OpinionSummary } from '@journal/contract';
import { formatDate, formatTime, formatTimestamp } from '@/lib/format';
import {
  ApiRequestError,
  approveOpinionStatementUpdateSuggestion,
  deleteOpinionStatement,
  listOpinionStatements,
  listOpinionStatementUpdateSuggestions,
  listOpinionSummaries,
  publishOpinionStatement,
  rejectOpinionStatementUpdateSuggestion,
  reopenOpinionStatement,
  untouchOpinionStatement,
  unpublishOpinionStatement,
  updateOpinionStatement,
  validateOpinionStatement,
} from '@/lib/api';
import styles from './page.module.css';

const LIMIT = 200;

interface OpinionsData {
  summaries: OpinionSummary[];
  statements: OpinionStatement[];
  suggestions: OpinionStatementUpdateSuggestion[];
}

/**
 * The concept model (`plan.md` M8b, `requirements.md` §5.2, reframed
 * 2026-08-30) — grouped by subject, because grouping everything said about
 * a concept is the actual point of this structure, not a side effect of
 * it. Each subject's group leads with its full chronological statement
 * record — the primary content, and the only layer editing touches. The
 * regenerated, cited summary is secondary: collapsed behind a disclosure
 * per subject rather than leading the page, never hand-edited, regenerated
 * either by a past `npm run reprocess` or, since M18, the moment an
 * approved statement changes what it should cite (`PendingItemApplier`'s
 * own comment on why this moved out of extraction time). Correcting a
 * summary means correcting (or discarding) the statement it cites and
 * reprocessing (or, live, approving a fresh statement from the popup or
 * `/pending` queue), not editing the summary directly.
 *
 * Editing and validating a statement (`requirements.md` §2, §6.4, `plan.md`
 * M10) is scoped to `statement` itself — `eventTime` correction is not yet
 * surfaced in this UI.
 */
export default function OpinionsPage() {
  const [data, setData] = useState<OpinionsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const load = () => {
    Promise.all([listOpinionSummaries(), listOpinionStatements({ limit: LIMIT }), listOpinionStatementUpdateSuggestions('pending')])
      .then(([summariesResponse, statementsResponse, suggestionsResponse]) =>
        setData({
          summaries: summariesResponse.summaries,
          statements: statementsResponse.statements,
          suggestions: suggestionsResponse.suggestions,
        }),
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

  const toggleTouched = (statement: OpinionStatement) => {
    setBusyId(statement.id);
    (statement.touched ? untouchOpinionStatement(statement.id) : validateOpinionStatement(statement.id))
      .then(() =>
        setData(
          (current) =>
            current && {
              ...current,
              statements: current.statements.map((s) =>
                s.id === statement.id ? { ...s, touched: !statement.touched } : s,
              ),
            },
        ),
      )
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not update.'))
      .finally(() => setBusyId(null));
  };

  const togglePublished = (statement: OpinionStatement) => {
    setBusyId(statement.id);
    (statement.published ? unpublishOpinionStatement(statement.id) : publishOpinionStatement(statement.id))
      .then(() =>
        setData(
          (current) =>
            current && {
              ...current,
              statements: current.statements.map((s) =>
                s.id === statement.id ? { ...s, published: !statement.published } : s,
              ),
            },
        ),
      )
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not update.'))
      .finally(() => setBusyId(null));
  };

  const reopen = (statement: OpinionStatement) => {
    setBusyId(statement.id);
    reopenOpinionStatement(statement.id)
      .then(() =>
        setData(
          (current) =>
            current && {
              ...current,
              statements: current.statements.map((s) =>
                s.id === statement.id
                  ? { ...s, status: 'open', resolvedEntryId: null, resolution: null, touched: true }
                  : s,
              ),
            },
        ),
      )
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not reopen.'))
      .finally(() => setBusyId(null));
  };

  const startEdit = (statement: OpinionStatement) => {
    setEditingId(statement.id);
    setDraft(statement.statement);
  };

  const saveEdit = (id: string) => {
    setBusyId(id);
    updateOpinionStatement(id, { statement: draft })
      .then(() => {
        setData(
          (current) =>
            current && {
              ...current,
              statements: current.statements.map((s) => (s.id === id ? { ...s, statement: draft, touched: true } : s)),
            },
        );
        setEditingId(null);
      })
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not save.'))
      .finally(() => setBusyId(null));
  };

  const decideSuggestion = (id: string, decision: 'approve' | 'reject') => {
    setBusyId(id);
    (decision === 'approve' ? approveOpinionStatementUpdateSuggestion(id) : rejectOpinionStatementUpdateSuggestion(id))
      .then(() => {
        setData((current) => current && { ...current, suggestions: current.suggestions.filter((s) => s.id !== id) });
        if (decision === 'approve') load();
      })
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not decide.'))
      .finally(() => setBusyId(null));
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

  // Grouped by subject — the primary organising unit of the concept model
  // now, not a flat chronological feed (`requirements.md` §5.2, reframed
  // 2026-08-30). Alphabetical, so the page doesn't reshuffle every time you
  // write, matching the almanac/field-guide idiom the rest of the analysis
  // surfaces use (`design.md` §5.3).
  const subjects = Array.from(
    new Set([...data.statements.map((s) => s.subject), ...data.summaries.map((s) => s.subject)]),
  ).sort((a, b) => a.localeCompare(b));

  return (
    <div>
      {data.suggestions.length > 0 && (
        <section className={styles.section}>
          <h2 className={styles.heading}>Reprocessing found changes to statements you’ve reviewed</h2>
          <ul className={styles.suggestionList}>
            {data.suggestions.map((suggestion) => (
              <li key={suggestion.id} className={styles.suggestionRow}>
                <div className={styles.main}>
                  <span className={styles.text}>{suggestion.reason}</span>
                  <span className={styles.text}>Would become: {suggestion.statement}</span>
                </div>
                <div className={styles.actions}>
                  <button
                    type="button"
                    className={styles.approveButton}
                    onClick={() => decideSuggestion(suggestion.id, 'approve')}
                    disabled={busyId === suggestion.id}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className={styles.rejectButton}
                    onClick={() => decideSuggestion(suggestion.id, 'reject')}
                    disabled={busyId === suggestion.id}
                  >
                    Keep mine
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className={styles.section}>
        <h2 className={styles.heading}>Concepts</h2>
        {subjects.map((subject) => {
          const subjectSummary = data.summaries.find((s) => s.subject === subject) ?? null;
          const subjectStatements = data.statements.filter((s) => s.subject === subject);
          const openTopics = subjectStatements.filter((s) => s.kind === 'question' && s.status === 'open');
          return (
            <div key={subject} className={styles.subjectGroup}>
              <h3 className={styles.subjectHeading}>{subject}</h3>

              {openTopics.length > 0 && (
                <div className={styles.openTopics}>
                  <p className={styles.openTopicsHeading}>Still to raise</p>
                  <ul className={styles.openTopicsList}>
                    {openTopics.map((topic) => (
                      <li key={topic.id}>{topic.statement}</li>
                    ))}
                  </ul>
                </div>
              )}

              {subjectSummary && subjectSummary.parts.length > 0 && (
                <details className={styles.aiSummary}>
                  <summary className={styles.aiSummaryToggle}>
                    AI summary
                    {subjectSummary.generatedAt && ` · generated ${formatTimestamp(subjectSummary.generatedAt)}`}
                  </summary>
                  {subjectSummary.parts.map((part, index) => (
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
                </details>
              )}

              <ol className={styles.list}>
                {subjectStatements.map((statement) => (
                  <li key={statement.id} className={styles.row}>
                    <div className={styles.main}>
                      <span className={styles.when}>
                        <time dateTime={statement.eventTime}>{formatDate(statement.eventTime)}</time>
                        <span>{formatTime(statement.eventTime)}</span>
                        {!statement.eventTimeExplicit && <span>(from the entry’s own time)</span>}
                        {statement.kind === 'question' && (
                          <span className={statement.status === 'open' ? styles.openBadge : styles.touched}>
                            {statement.status}
                          </span>
                        )}
                        {statement.touched && <span className={styles.touched}>touched</span>}
                        {statement.published && <span className={styles.published}>published</span>}
                      </span>
                      {editingId === statement.id ? (
                        <div className={styles.editForm}>
                          <textarea
                            className={styles.textarea}
                            value={draft}
                            onChange={(event) => setDraft(event.target.value)}
                            aria-label="Statement"
                          />
                          <div className={styles.actions}>
                            <button
                              type="button"
                              className={styles.approveButton}
                              onClick={() => saveEdit(statement.id)}
                              disabled={busyId === statement.id}
                            >
                              Save
                            </button>
                            <button type="button" className={styles.rejectButton} onClick={() => setEditingId(null)}>
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <span className={styles.text}>{statement.statement}</span>
                      )}
                      {statement.status === 'resolved' && (
                        <p className={styles.resolution}>
                          Resolved: {statement.resolution}{' '}
                          {statement.resolvedEntryId && (
                            <Link href={`/entry/${statement.resolvedEntryId}`} className={styles.link}>
                              Resolving entry
                            </Link>
                          )}
                        </p>
                      )}
                      <Link href={`/entry/${statement.entryId}`} className={styles.link}>
                        Source entry
                      </Link>
                    </div>
                    {editingId !== statement.id && (
                      <div className={styles.rowActions}>
                        <button type="button" className={styles.editButton} onClick={() => startEdit(statement)}>
                          Edit
                        </button>
                        {statement.status === 'resolved' && (
                          <button
                            type="button"
                            className={styles.editButton}
                            onClick={() => reopen(statement)}
                            disabled={busyId === statement.id}
                          >
                            Reopen
                          </button>
                        )}
                        <button
                          type="button"
                          className={styles.editButton}
                          onClick={() => toggleTouched(statement)}
                          disabled={busyId === statement.id}
                        >
                          {statement.touched ? 'Untouch' : 'Validate'}
                        </button>
                        <button
                          type="button"
                          className={styles.editButton}
                          onClick={() => togglePublished(statement)}
                          disabled={busyId === statement.id}
                        >
                          {statement.published ? 'Unpublish' : 'Publish'}
                        </button>
                        <button
                          type="button"
                          className={styles.discard}
                          onClick={() => discard(statement.id)}
                          disabled={removingId === statement.id}
                        >
                          Discard
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ol>
            </div>
          );
        })}
      </section>
    </div>
  );
}
