'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { OpenQuestion, QuestionUpdateSuggestion } from '@journal/contract';
import { formatDate, formatTime } from '@/lib/format';
import {
  ApiRequestError,
  approveQuestionUpdateSuggestion,
  deleteQuestion,
  listQuestions,
  listQuestionUpdateSuggestions,
  publishQuestion,
  rejectQuestionUpdateSuggestion,
  reopenQuestion,
  untouchQuestion,
  unpublishQuestion,
  updateQuestion,
  validateQuestion,
} from '@/lib/api';
import styles from './page.module.css';

const LIMIT = 200;

interface QuestionsData {
  open: OpenQuestion[];
  resolved: OpenQuestion[];
  suggestions: QuestionUpdateSuggestion[];
}

/**
 * Open questions (`plan.md` M8c) — something raised in one entry, and
 * possibly resolved by a later one: what a past `npm run reprocess` wrote,
 * plus whatever has since been approved from a live `Process` run's popup
 * or `/pending` queue, resolution included (`plan.md` M18 closes the gap
 * `QuestionsIndex.resolve()`'s own comment flagged since M10 — a live
 * resolution against a touched question previously had nowhere to go).
 * Two sections rather than one list split on
 * this side of the boundary: the backend's `status` filter already does
 * the splitting (`requirements.md` §7.1).
 *
 * Editing and validating (`requirements.md` §2, §6.4, `plan.md` M10) is
 * scoped to `question`, what was raised — never the resolution, which has
 * its own dedicated Reopen action. Reopening a resolved question is itself
 * a correction, so it touches the record too — a future reprocess must not
 * silently re-resolve it the same way.
 */
export default function QuestionsPage() {
  const [data, setData] = useState<QuestionsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const load = () => {
    Promise.all([
      listQuestions({ status: 'open', limit: LIMIT }),
      listQuestions({ status: 'resolved', limit: LIMIT }),
      listQuestionUpdateSuggestions('pending'),
    ])
      .then(([openResponse, resolvedResponse, suggestionsResponse]) =>
        setData({
          open: openResponse.questions,
          resolved: resolvedResponse.questions,
          suggestions: suggestionsResponse.suggestions,
        }),
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
              ...current,
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
          const reopened: OpenQuestion = {
            ...question,
            status: 'open',
            resolvedEntryId: null,
            resolution: null,
            touched: true,
          };
          return {
            ...current,
            open: [reopened, ...current.open],
            resolved: current.resolved.filter((q) => q.id !== id),
          };
        }),
      )
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not reopen.'))
      .finally(() => setBusyId(null));
  };

  const toggleTouched = (question: OpenQuestion) => {
    setBusyId(question.id);
    (question.touched ? untouchQuestion(question.id) : validateQuestion(question.id))
      .then(() =>
        setData((current) => {
          if (!current) return current;
          const flip = (q: OpenQuestion) => (q.id === question.id ? { ...q, touched: !question.touched } : q);
          return { ...current, open: current.open.map(flip), resolved: current.resolved.map(flip) };
        }),
      )
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not update.'))
      .finally(() => setBusyId(null));
  };

  const togglePublished = (question: OpenQuestion) => {
    setBusyId(question.id);
    (question.published ? unpublishQuestion(question.id) : publishQuestion(question.id))
      .then(() =>
        setData((current) => {
          if (!current) return current;
          const flip = (q: OpenQuestion) => (q.id === question.id ? { ...q, published: !question.published } : q);
          return { ...current, open: current.open.map(flip), resolved: current.resolved.map(flip) };
        }),
      )
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not update.'))
      .finally(() => setBusyId(null));
  };

  const startEdit = (question: OpenQuestion) => {
    setEditingId(question.id);
    setDraft(question.question);
  };

  const saveEdit = (id: string) => {
    setBusyId(id);
    updateQuestion(id, { question: draft })
      .then(() => {
        setData((current) => {
          if (!current) return current;
          const apply = (q: OpenQuestion) => (q.id === id ? { ...q, question: draft, touched: true } : q);
          return { ...current, open: current.open.map(apply), resolved: current.resolved.map(apply) };
        });
        setEditingId(null);
      })
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not save.'))
      .finally(() => setBusyId(null));
  };

  const decideSuggestion = (id: string, decision: 'approve' | 'reject') => {
    setBusyId(id);
    (decision === 'approve' ? approveQuestionUpdateSuggestion(id) : rejectQuestionUpdateSuggestion(id))
      .then(() => {
        setData((current) => current && { ...current, suggestions: current.suggestions.filter((s) => s.id !== id) });
        if (decision === 'approve') load();
      })
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not decide.'))
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

  const editRow = (question: OpenQuestion) =>
    editingId === question.id ? (
      <div className={styles.editForm}>
        <textarea
          className={styles.textarea}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          aria-label="Question"
        />
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.approveButton}
            onClick={() => saveEdit(question.id)}
            disabled={busyId === question.id}
          >
            Save
          </button>
          <button type="button" className={styles.rejectButton} onClick={() => setEditingId(null)}>
            Cancel
          </button>
        </div>
      </div>
    ) : (
      <span className={styles.text}>{question.question}</span>
    );

  return (
    <div>
      {data.suggestions.length > 0 && (
        <section className={styles.section}>
          <h2 className={styles.heading}>Reprocessing found changes to questions you've reviewed</h2>
          <ul className={styles.list}>
            {data.suggestions.map((suggestion) => (
              <li key={suggestion.id} className={styles.row}>
                <div className={styles.main}>
                  <span className={styles.resolution}>{suggestion.reason}</span>
                  <span className={styles.text}>Would become: {suggestion.question}</span>
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
                    {question.touched && <span className={styles.touched}>touched</span>}
                    {question.published && <span className={styles.published}>published</span>}
                  </span>
                  {editRow(question)}
                  <Link href={`/entry/${question.entryId}`} className={styles.link}>
                    Source entry
                  </Link>
                </div>
                {editingId !== question.id && (
                  <div className={styles.actions}>
                    <button type="button" className={styles.reopen} onClick={() => startEdit(question)}>
                      Edit
                    </button>
                    <button
                      type="button"
                      className={styles.reopen}
                      onClick={() => toggleTouched(question)}
                      disabled={busyId === question.id}
                    >
                      {question.touched ? 'Untouch' : 'Validate'}
                    </button>
                    <button
                      type="button"
                      className={styles.reopen}
                      onClick={() => togglePublished(question)}
                      disabled={busyId === question.id}
                    >
                      {question.published ? 'Unpublish' : 'Publish'}
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
                )}
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
                    {question.touched && <span className={styles.touched}>touched</span>}
                    {question.published && <span className={styles.published}>published</span>}
                  </span>
                  {editRow(question)}
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
                {editingId !== question.id && (
                  <div className={styles.actions}>
                    <button type="button" className={styles.reopen} onClick={() => startEdit(question)}>
                      Edit
                    </button>
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
                      className={styles.reopen}
                      onClick={() => togglePublished(question)}
                      disabled={busyId === question.id}
                    >
                      {question.published ? 'Unpublish' : 'Publish'}
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
                )}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
