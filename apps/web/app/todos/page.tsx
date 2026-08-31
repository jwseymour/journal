'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { Todo, TodoCompletionSuggestion, TodoUpdateSuggestion } from '@journal/contract';
import { formatDate, formatTime } from '@/lib/format';
import {
  ApiRequestError,
  approveTodoCompletionSuggestion,
  approveTodoUpdateSuggestion,
  completeTodo,
  createTodo,
  deleteTodo,
  listTodoCompletionSuggestions,
  listTodos,
  listTodoUpdateSuggestions,
  rejectTodoCompletionSuggestion,
  rejectTodoUpdateSuggestion,
  reopenTodo,
  untouchTodo,
  updateTodo,
  validateTodo,
} from '@/lib/api';
import styles from './page.module.css';

const LIMIT = 200;

interface TodosData {
  open: Todo[];
  done: Todo[];
  updateSuggestions: TodoUpdateSuggestion[];
  completionSuggestions: TodoCompletionSuggestion[];
}

/**
 * To-dos (`plan.md` M15, `requirements.md` §11) — closest to `/questions`,
 * plus two things no other structure page has: adding one directly, with
 * no source entry, and checking one off directly, with no entry involved.
 * Otherwise what a past `npm run reprocess` wrote, plus whatever has since
 * been approved from a live `Process` run's popup or `/pending` queue,
 * completion included (`plan.md` M18) — those two direct actions are the
 * only ones the API still applies immediately, with no approval step.
 *
 * Editing and validating is scoped to `text`, what was raised — never the
 * completion, which has its own dedicated checkbox and Reopen action.
 * Untouch is only ever offered on an extracted record: a directly created
 * one has no AI version to revert to (`TodosIndex.untouch`'s own guard).
 */
export default function TodosPage() {
  const [data, setData] = useState<TodosData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [newText, setNewText] = useState('');
  const [adding, setAdding] = useState(false);

  const load = () => {
    Promise.all([
      listTodos({ status: 'open', limit: LIMIT }),
      listTodos({ status: 'done', limit: LIMIT }),
      listTodoUpdateSuggestions('pending'),
      listTodoCompletionSuggestions('pending'),
    ])
      .then(([openResponse, doneResponse, updateResponse, completionResponse]) =>
        setData({
          open: openResponse.todos,
          done: doneResponse.todos,
          updateSuggestions: updateResponse.suggestions,
          completionSuggestions: completionResponse.suggestions,
        }),
      )
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not load to-dos.'));
  };

  useEffect(load, []);

  const addTodo = (event: React.FormEvent) => {
    event.preventDefault();
    const text = newText.trim();
    if (!text) return;
    setAdding(true);
    createTodo({ text })
      .then((created) => {
        setData((current) => current && { ...current, open: [created, ...current.open] });
        setNewText('');
      })
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not add.'))
      .finally(() => setAdding(false));
  };

  const discard = (id: string) => {
    setBusyId(id);
    deleteTodo(id)
      .then(() =>
        setData(
          (current) =>
            current && {
              ...current,
              open: current.open.filter((t) => t.id !== id),
              done: current.done.filter((t) => t.id !== id),
            },
        ),
      )
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not discard.'))
      .finally(() => setBusyId(null));
  };

  const toggleComplete = (todo: Todo) => {
    setBusyId(todo.id);
    (todo.status === 'open' ? completeTodo(todo.id) : reopenTodo(todo.id))
      .then(() =>
        setData((current) => {
          if (!current) return current;
          if (todo.status === 'open') {
            const completed: Todo = { ...todo, status: 'done', doneEntryId: null, resolution: null, touched: true };
            return {
              ...current,
              open: current.open.filter((t) => t.id !== todo.id),
              done: [completed, ...current.done],
            };
          }
          const reopened: Todo = { ...todo, status: 'open', doneEntryId: null, resolution: null, touched: true };
          return {
            ...current,
            open: [reopened, ...current.open],
            done: current.done.filter((t) => t.id !== todo.id),
          };
        }),
      )
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not update.'))
      .finally(() => setBusyId(null));
  };

  const toggleTouched = (todo: Todo) => {
    setBusyId(todo.id);
    (todo.touched ? untouchTodo(todo.id) : validateTodo(todo.id))
      .then(() =>
        setData((current) => {
          if (!current) return current;
          const flip = (t: Todo) => (t.id === todo.id ? { ...t, touched: !todo.touched } : t);
          return { ...current, open: current.open.map(flip), done: current.done.map(flip) };
        }),
      )
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not update.'))
      .finally(() => setBusyId(null));
  };

  const startEdit = (todo: Todo) => {
    setEditingId(todo.id);
    setDraft(todo.text);
  };

  const saveEdit = (id: string) => {
    setBusyId(id);
    updateTodo(id, { text: draft })
      .then(() => {
        setData((current) => {
          if (!current) return current;
          const apply = (t: Todo) => (t.id === id ? { ...t, text: draft, touched: true } : t);
          return { ...current, open: current.open.map(apply), done: current.done.map(apply) };
        });
        setEditingId(null);
      })
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not save.'))
      .finally(() => setBusyId(null));
  };

  const decideUpdateSuggestion = (id: string, decision: 'approve' | 'reject') => {
    setBusyId(id);
    (decision === 'approve' ? approveTodoUpdateSuggestion(id) : rejectTodoUpdateSuggestion(id))
      .then(() => {
        setData((current) => current && { ...current, updateSuggestions: current.updateSuggestions.filter((s) => s.id !== id) });
        if (decision === 'approve') load();
      })
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not decide.'))
      .finally(() => setBusyId(null));
  };

  const decideCompletionSuggestion = (id: string, decision: 'approve' | 'reject') => {
    setBusyId(id);
    (decision === 'approve' ? approveTodoCompletionSuggestion(id) : rejectTodoCompletionSuggestion(id))
      .then(() => {
        setData(
          (current) => current && { ...current, completionSuggestions: current.completionSuggestions.filter((s) => s.id !== id) },
        );
        if (decision === 'approve') load();
      })
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not decide.'))
      .finally(() => setBusyId(null));
  };

  if (error) return <p className={styles.error}>{error}</p>;
  if (data === null) return <p className={styles.hint}>Loading…</p>;

  const editRow = (todo: Todo) =>
    editingId === todo.id ? (
      <div className={styles.editForm}>
        <textarea
          className={styles.textarea}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          aria-label="To-do"
        />
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.approveButton}
            onClick={() => saveEdit(todo.id)}
            disabled={busyId === todo.id}
          >
            Save
          </button>
          <button type="button" className={styles.rejectButton} onClick={() => setEditingId(null)}>
            Cancel
          </button>
        </div>
      </div>
    ) : (
      <span className={styles.text}>{todo.text}</span>
    );

  return (
    <div>
      {data.updateSuggestions.length > 0 && (
        <section className={styles.section}>
          <h2 className={styles.heading}>Reprocessing found changes to to-dos you&apos;ve reviewed</h2>
          <ul className={styles.list}>
            {data.updateSuggestions.map((suggestion) => (
              <li key={suggestion.id} className={styles.row}>
                <div className={styles.main}>
                  <span className={styles.resolution}>{suggestion.reason}</span>
                  <span className={styles.text}>Would become: {suggestion.text}</span>
                </div>
                <div className={styles.actions}>
                  <button
                    type="button"
                    className={styles.approveButton}
                    onClick={() => decideUpdateSuggestion(suggestion.id, 'approve')}
                    disabled={busyId === suggestion.id}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className={styles.rejectButton}
                    onClick={() => decideUpdateSuggestion(suggestion.id, 'reject')}
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

      {data.completionSuggestions.length > 0 && (
        <section className={styles.section}>
          <h2 className={styles.heading}>Reprocessing found to-dos you&apos;ve reviewed marked done</h2>
          <ul className={styles.list}>
            {data.completionSuggestions.map((suggestion) => (
              <li key={suggestion.id} className={styles.row}>
                <div className={styles.main}>
                  <span className={styles.resolution}>{suggestion.reason}</span>
                  <span className={styles.text}>{suggestion.resolution}</span>
                </div>
                <div className={styles.actions}>
                  <button
                    type="button"
                    className={styles.approveButton}
                    onClick={() => decideCompletionSuggestion(suggestion.id, 'approve')}
                    disabled={busyId === suggestion.id}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className={styles.rejectButton}
                    onClick={() => decideCompletionSuggestion(suggestion.id, 'reject')}
                    disabled={busyId === suggestion.id}
                  >
                    Keep open
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className={styles.section}>
        <h2 className={styles.heading}>Open</h2>
        <form className={styles.addForm} onSubmit={addTodo}>
          <input
            type="text"
            className={styles.addInput}
            value={newText}
            onChange={(event) => setNewText(event.target.value)}
            placeholder="Add a to-do"
            aria-label="Add a to-do"
          />
          <button type="submit" className={styles.approveButton} disabled={adding || newText.trim() === ''}>
            Add
          </button>
        </form>
        {data.open.length === 0 ? (
          <p className={styles.empty}>Nothing currently open.</p>
        ) : (
          <ol className={styles.list}>
            {data.open.map((todo) => (
              <li key={todo.id} className={styles.row}>
                <input
                  type="checkbox"
                  className={styles.checkbox}
                  checked={todo.status === 'done'}
                  onChange={() => toggleComplete(todo)}
                  disabled={busyId === todo.id}
                  aria-label="Mark done"
                />
                <div className={styles.main}>
                  <span className={styles.when}>
                    <time dateTime={todo.eventTime}>{formatDate(todo.eventTime)}</time>
                    <span>{formatTime(todo.eventTime)}</span>
                    {!todo.eventTimeExplicit && <span>(from the entry’s own time)</span>}
                    {todo.touched && <span className={styles.touched}>touched</span>}
                  </span>
                  {editRow(todo)}
                  {todo.entryId && (
                    <Link href={`/entry/${todo.entryId}`} className={styles.link}>
                      Source entry
                    </Link>
                  )}
                </div>
                {editingId !== todo.id && (
                  <div className={styles.actions}>
                    <button type="button" className={styles.reopen} onClick={() => startEdit(todo)}>
                      Edit
                    </button>
                    {todo.origin === 'extracted' && (
                      <button
                        type="button"
                        className={styles.reopen}
                        onClick={() => toggleTouched(todo)}
                        disabled={busyId === todo.id}
                      >
                        {todo.touched ? 'Untouch' : 'Validate'}
                      </button>
                    )}
                    <button
                      type="button"
                      className={styles.discard}
                      onClick={() => discard(todo.id)}
                      disabled={busyId === todo.id}
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
        <h2 className={styles.heading}>Done</h2>
        {data.done.length === 0 ? (
          <p className={styles.empty}>Nothing done yet.</p>
        ) : (
          <ol className={styles.list}>
            {data.done.map((todo) => (
              <li key={todo.id} className={styles.row}>
                <input
                  type="checkbox"
                  className={styles.checkbox}
                  checked={todo.status === 'done'}
                  onChange={() => toggleComplete(todo)}
                  disabled={busyId === todo.id}
                  aria-label="Mark open"
                />
                <div className={styles.main}>
                  <span className={styles.when}>
                    <time dateTime={todo.eventTime}>{formatDate(todo.eventTime)}</time>
                    <span>{formatTime(todo.eventTime)}</span>
                    {!todo.eventTimeExplicit && <span>(from the entry’s own time)</span>}
                    {todo.touched && <span className={styles.touched}>touched</span>}
                  </span>
                  {editRow(todo)}
                  {todo.resolution && <span className={styles.resolution}>{todo.resolution}</span>}
                  <span className={styles.sources}>
                    {todo.entryId && (
                      <Link href={`/entry/${todo.entryId}`} className={styles.link}>
                        Raised in
                      </Link>
                    )}
                    {todo.doneEntryId && (
                      <Link href={`/entry/${todo.doneEntryId}`} className={styles.link}>
                        Completed in
                      </Link>
                    )}
                  </span>
                </div>
                {editingId !== todo.id && (
                  <div className={styles.actions}>
                    <button type="button" className={styles.reopen} onClick={() => startEdit(todo)}>
                      Edit
                    </button>
                    <button
                      type="button"
                      className={styles.reopen}
                      onClick={() => toggleComplete(todo)}
                      disabled={busyId === todo.id}
                    >
                      Reopen
                    </button>
                    <button
                      type="button"
                      className={styles.discard}
                      onClick={() => discard(todo.id)}
                      disabled={busyId === todo.id}
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
