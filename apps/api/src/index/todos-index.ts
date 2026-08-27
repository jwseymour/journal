import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * To-dos (`plan.md` M15, `requirements.md` §11) — closest in shape to
 * `QuestionsIndex`: `entry_id` means "raised by," and a row's completion
 * fields (`done_entry_id`/`resolution`/`done_at`) may be filled in later by
 * a different entry entirely, in place, without disturbing which entry
 * raised it.
 *
 * Two departures from every derived-record type before it, both deliberate
 * product decisions rather than default:
 *
 * 1. **`entry_id` is nullable.** Every other structure originates only from
 *    an entry (`requirements.md` §2). A to-do can also be created directly
 *    in the UI with no entry behind it at all (`createDirect`) — the first
 *    genuinely user-authored derived record. `replaceRaised`/
 *    `replaceUntouchedRaised` still require a real `entryId`, unchanged
 *    from `QuestionsIndex`'s shape; only `createDirect` ever inserts a null
 *    one. A null `entry_id` can never satisfy `WHERE entry_id = ?`, so it
 *    is automatically exempt from every entry-scoped delete/replace below
 *    with no extra guard needed.
 *
 * 2. **`origin` is a separate, persistent column from `touched`.** It
 *    answers "does an AI-generated version of this record exist to revert
 *    to," where `touched` answers "is this currently protected from being
 *    overwritten by reprocessing." They diverge in exactly one place:
 *    `clearUntouched()` (reprocess-from-scratch) deletes every row with
 *    `touched = 0`, unscoped by entry. A direct-created row starts
 *    `touched = 1`, which protects it — but `untouch()` exists precisely to
 *    flip `touched` back to 0 for a record the user decides was fine as AI
 *    output. Allowing that on an `origin = 'user'` row would let the next
 *    from-scratch reprocess silently and permanently delete non-regenerable
 *    user work, so `untouch()` is guarded to `origin = 'extracted'` rows
 *    only — a tolerant no-op otherwise, the same idiom as the `isUlid`
 *    checks elsewhere. `origin` itself is set once at insert and never
 *    changed by `update()`/`validate()`/`untouch()`/`complete*()`/
 *    `reopen()` — it is provenance, not workflow state.
 *
 * Because this table is brand new, `touched` and `origin` ship in the
 * initial `CREATE TABLE`, unlike `questions-index.ts`'s `PRAGMA
 * table_info`/`ALTER TABLE` retrofit — that dance exists only because that
 * table predates the touched/untouched mechanism (`plan.md` M10); nothing
 * here does.
 *
 * Closing a to-do has two independent paths (both explicit product
 * decisions, `requirements.md` §11):
 *
 * - An entry says it's done: `completeFromExtraction` for an untouched
 *   record (guarded `AND touched = 0`, same posture as
 *   `QuestionsIndex.resolve`), or a `todo_completion_suggestions` proposal
 *   for a touched one — a *separate* suggestion table from
 *   `todo_update_suggestions`, because closing a record is a different
 *   mutation than correcting its raised text. Unlike `QuestionsIndex`,
 *   which today silently drops a touched-and-resolved match rather than
 *   proposing anything (see that file's `resolve()` comment), to-dos must
 *   not inherit that gap — the suggestion path exists precisely so a
 *   touched to-do's completion is never applied silently.
 * - The user directly toggles it done in the UI, any record, any time:
 *   `completeDirect`, which forces `touched = 1` — a direct assertion of
 *   workflow state not backed by extraction, the same reasoning
 *   `QuestionsIndex.reopen()` already applies to reopening.
 */

export type TodoStatus = 'open' | 'done';
export type TodoOrigin = 'extracted' | 'user';

export interface TodoRecord {
  id: string;
  /** The entry that raised this to-do — `null` only for a to-do created
   * directly in the UI (`createDirect`), never for one an entry raised. */
  entryId: string | null;
  text: string;
  eventTime: string;
  eventEpochMs: number;
  eventTimeExplicit: boolean;
  extractedAt: string;
  status: TodoStatus;
  /** The entry that reported this done, or `null` while open or when
   * closed by a direct UI toggle rather than an entry. */
  doneEntryId: string | null;
  resolution: string | null;
  doneAt: string | null;
  /** Provenance, set once at creation and never mutated afterward — see
   * this file's own doc comment for why it is not the same thing as
   * `touched`. */
  origin: TodoOrigin;
  /** Whether the user has reviewed, corrected, or edited this record
   * (`requirements.md` §2, §6.4). A direct-created row starts touched, the
   * same reasoning `update()` already applies to any edited row: creating
   * a record directly is itself a direct assertion, not a special case. */
  touched: boolean;
}

/** The editable subset of what an entry (or the user) raised — never the
 * completion, which has its own dedicated `completeDirect`/
 * `completeFromExtraction`/`reopen` machinery. */
export interface UpdateTodoInput {
  text?: string | undefined;
  eventTime?: string | undefined;
  eventTimeExplicit?: boolean | undefined;
}

export interface TodoUpdateSuggestion {
  id: string;
  recordId: string;
  entryId: string;
  text: string;
  eventTime: string;
  eventEpochMs: number;
  eventTimeExplicit: boolean;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  suggestedAt: string;
  decidedAt: string | null;
}

export type ProposeTodoUpdateInput = Omit<
  TodoUpdateSuggestion,
  'id' | 'status' | 'suggestedAt' | 'decidedAt'
> & { id: string; now: string };

export interface TodoCompletionSuggestion {
  id: string;
  recordId: string;
  entryId: string;
  resolution: string;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  suggestedAt: string;
  decidedAt: string | null;
}

export type ProposeTodoCompletionInput = Omit<
  TodoCompletionSuggestion,
  'id' | 'status' | 'suggestedAt' | 'decidedAt'
> & { id: string; now: string };

export interface ListTodosOptions {
  status?: TodoStatus;
  limit: number;
}

export interface TodosSummary {
  openCount: number;
  doneCount: number;
}

export interface CreateDirectTodoInput {
  id: string;
  text: string;
  now: string;
}

/** Same shape as `QuestionsReader` — the seam `http/app.ts` depends on. */
export interface TodosReader {
  list(options: ListTodosOptions): TodoRecord[];
  createDirect(input: CreateDirectTodoInput): TodoRecord;
  remove(id: string): void;
  reopen(id: string): void;
  completeDirect(id: string, now: string): void;
  summarize(): TodosSummary;
  update(id: string, input: UpdateTodoInput, now: string): TodoRecord | null;
  validate(id: string, now: string): void;
  untouch(id: string, now: string): void;
  listUpdateSuggestions(options?: { status?: TodoUpdateSuggestion['status'] }): TodoUpdateSuggestion[];
  decideUpdate(id: string, decision: 'approved' | 'rejected', now: string): void;
  listCompletionSuggestions(options?: { status?: TodoCompletionSuggestion['status'] }): TodoCompletionSuggestion[];
  decideCompletion(id: string, decision: 'approved' | 'rejected', now: string): void;
}

export class TodosIndex implements TodosReader {
  readonly #db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.#db = new Database(dbPath);
    this.#db.pragma('journal_mode = WAL');
    this.#migrate();
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS todos (
        id TEXT PRIMARY KEY,
        entry_id TEXT,
        text TEXT NOT NULL,
        event_time TEXT NOT NULL,
        event_epoch_ms INTEGER NOT NULL,
        event_time_explicit INTEGER NOT NULL,
        extracted_at TEXT NOT NULL,
        status TEXT NOT NULL,
        done_entry_id TEXT,
        resolution TEXT,
        done_at TEXT,
        origin TEXT NOT NULL,
        touched INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS todos_entry ON todos (entry_id);
      CREATE INDEX IF NOT EXISTS todos_status ON todos (status, event_epoch_ms DESC);

      CREATE TABLE IF NOT EXISTS todo_update_suggestions (
        id TEXT PRIMARY KEY,
        record_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        text TEXT NOT NULL,
        event_time TEXT NOT NULL,
        event_epoch_ms INTEGER NOT NULL,
        event_time_explicit INTEGER NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL,
        suggested_at TEXT NOT NULL,
        decided_at TEXT
      );
      CREATE INDEX IF NOT EXISTS todo_update_suggestions_status ON todo_update_suggestions (status);

      CREATE TABLE IF NOT EXISTS todo_completion_suggestions (
        id TEXT PRIMARY KEY,
        record_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        resolution TEXT NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL,
        suggested_at TEXT NOT NULL,
        decided_at TEXT
      );
      CREATE INDEX IF NOT EXISTS todo_completion_suggestions_status ON todo_completion_suggestions (status);
    `);
  }

  /** Replaces only the still-*open* to-dos raised by this entry — the same
   * "never touch a closed row" reasoning as `QuestionsIndex.replaceRaised`.
   * Test-fixture convenience, mirroring that file; the extractor itself
   * only ever calls `replaceUntouchedRaised`. */
  replaceRaised(entryId: string, records: Omit<TodoRecord, 'entryId'>[]): void {
    const insert = this.#db.transaction(() => {
      this.#db.prepare("DELETE FROM todos WHERE entry_id = ? AND status = 'open'").run(entryId);
      const stmt = this.#db.prepare(
        `INSERT INTO todos
           (id, entry_id, text, event_time, event_epoch_ms, event_time_explicit, extracted_at, status, done_entry_id, resolution, done_at, origin, touched)
         VALUES (@id, @entryId, @text, @eventTime, @eventEpochMs, @eventTimeExplicit, @extractedAt, @status, @doneEntryId, @resolution, @doneAt, @origin, @touched)`,
      );
      for (const record of records) {
        stmt.run({
          id: record.id,
          entryId,
          text: record.text,
          eventTime: record.eventTime,
          eventEpochMs: record.eventEpochMs,
          eventTimeExplicit: record.eventTimeExplicit ? 1 : 0,
          extractedAt: record.extractedAt,
          status: record.status,
          doneEntryId: record.doneEntryId,
          resolution: record.resolution,
          doneAt: record.doneAt,
          origin: record.origin,
          touched: record.touched ? 1 : 0,
        });
      }
    });
    insert();
  }

  /** The reprocess-safe sibling of `replaceRaised` (`plan.md` M10): only
   * open, untouched to-dos raised by this entry are replaced. Always
   * inserts with `origin = 'extracted'` — this is the only path that ever
   * writes an entry-scoped row, and an entry-scoped row is always AI
   * origin by construction. */
  replaceUntouchedRaised(entryId: string, records: Omit<TodoRecord, 'entryId' | 'touched' | 'origin'>[]): void {
    const insert = this.#db.transaction(() => {
      this.#db.prepare("DELETE FROM todos WHERE entry_id = ? AND status = 'open' AND touched = 0").run(entryId);
      const stmt = this.#db.prepare(
        `INSERT INTO todos
           (id, entry_id, text, event_time, event_epoch_ms, event_time_explicit, extracted_at, status, done_entry_id, resolution, done_at, origin, touched)
         VALUES (@id, @entryId, @text, @eventTime, @eventEpochMs, @eventTimeExplicit, @extractedAt, @status, @doneEntryId, @resolution, @doneAt, 'extracted', 0)`,
      );
      for (const record of records) {
        stmt.run({
          id: record.id,
          entryId,
          text: record.text,
          eventTime: record.eventTime,
          eventEpochMs: record.eventEpochMs,
          eventTimeExplicit: record.eventTimeExplicit ? 1 : 0,
          extractedAt: record.extractedAt,
          status: record.status,
          doneEntryId: record.doneEntryId,
          resolution: record.resolution,
          doneAt: record.doneAt,
        });
      }
    });
    insert();
  }

  /** Open, touched to-dos raised by this entry — what a reprocess pass
   * compares fresh extraction against. */
  touchedOpenRaisedBy(entryId: string): TodoRecord[] {
    const rows = this.#db
      .prepare("SELECT * FROM todos WHERE entry_id = ? AND status = 'open' AND touched = 1")
      .all(entryId) as RawRow[];
    return rows.map(fromRaw);
  }

  /** A to-do created directly in the UI, with no source entry
   * (`requirements.md` §11, the deliberate exception to "origination is
   * always automatic" — `requirements.md` §2). `eventTime` is the moment
   * of creation, `eventTimeExplicit: false`, mirroring how `resolveEventTime`
   * treats "no time information given": there is no prose to resolve a
   * time from here at all. Starts `touched = 1` immediately — creating a
   * record directly is itself the same kind of direct assertion editing an
   * extracted one already is. */
  createDirect(input: CreateDirectTodoInput): TodoRecord {
    const record: TodoRecord = {
      id: input.id,
      entryId: null,
      text: input.text,
      eventTime: input.now,
      eventEpochMs: Date.parse(input.now),
      eventTimeExplicit: false,
      extractedAt: input.now,
      status: 'open',
      doneEntryId: null,
      resolution: null,
      doneAt: null,
      origin: 'user',
      touched: true,
    };
    this.#db
      .prepare(
        `INSERT INTO todos
           (id, entry_id, text, event_time, event_epoch_ms, event_time_explicit, extracted_at, status, done_entry_id, resolution, done_at, origin, touched)
         VALUES (@id, NULL, @text, @eventTime, @eventEpochMs, @eventTimeExplicit, @extractedAt, @status, NULL, NULL, NULL, 'user', 1)`,
      )
      .run({
        id: record.id,
        text: record.text,
        eventTime: record.eventTime,
        eventEpochMs: record.eventEpochMs,
        eventTimeExplicit: 0,
        extractedAt: record.extractedAt,
        status: record.status,
      });
    return record;
  }

  /** Marks an open to-do done because a later entry said so — an update in
   * place, not a replace, same as `QuestionsIndex.resolve`. **`AND touched
   * = 0`**: a touched to-do is never auto-completed this way
   * (`requirements.md` §11) — see `proposeCompletion`/`decideCompletion`
   * for the touched path, which this design deliberately does not skip
   * (unlike `QuestionsIndex.resolve`, which currently drops that case
   * silently). A no-op if `id` is not currently open or is touched. */
  completeFromExtraction(id: string, completion: { doneEntryId: string; resolution: string; doneAt: string }): void {
    this.#db
      .prepare(
        `UPDATE todos
           SET status = 'done', done_entry_id = @doneEntryId, resolution = @resolution, done_at = @doneAt
         WHERE id = @id AND status = 'open' AND touched = 0`,
      )
      .run({ id, ...completion });
  }

  /** The user checking a to-do off directly in the UI — any record, open,
   * touched or not, at any time (`requirements.md` §11). No corroborating
   * entry, so `doneEntryId`/`resolution` stay `null`. Forces `touched = 1`:
   * this is a direct assertion of workflow state not backed by extraction,
   * the same reasoning `reopen()` already applies to reopening. A no-op if
   * `id` is not currently open. */
  completeDirect(id: string, now: string): void {
    this.#db
      .prepare(
        `UPDATE todos
           SET status = 'done', done_entry_id = NULL, resolution = NULL, done_at = @now, touched = 1
         WHERE id = @id AND status = 'open'`,
      )
      .run({ id, now });
  }

  /** Reverts a completion without discarding the to-do itself — covers
   * both closing paths identically: an entry matched wrongly, or the user
   * checked it off by mistake. Reopening is itself a correction, so it
   * touches the record, exactly like `QuestionsIndex.reopen`. */
  reopen(id: string): void {
    this.#db
      .prepare(
        `UPDATE todos SET status = 'open', done_entry_id = NULL, resolution = NULL, done_at = NULL, touched = 1 WHERE id = ?`,
      )
      .run(id);
  }

  update(id: string, input: UpdateTodoInput, _now: string): TodoRecord | null {
    const existing = this.#db.prepare('SELECT * FROM todos WHERE id = ?').get(id) as RawRow | undefined;
    if (!existing) return null;

    const eventTimeExplicit = input.eventTimeExplicit ?? existing.event_time_explicit === 1;
    const next: RawRow = {
      ...existing,
      text: input.text ?? existing.text,
      event_time: input.eventTime ?? existing.event_time,
      event_epoch_ms: input.eventTime ? Date.parse(input.eventTime) : existing.event_epoch_ms,
      event_time_explicit: eventTimeExplicit ? 1 : 0,
      touched: 1,
    };
    this.#db
      .prepare(
        `UPDATE todos
           SET text = @text, event_time = @event_time, event_epoch_ms = @event_epoch_ms,
               event_time_explicit = @event_time_explicit, touched = 1
         WHERE id = @id`,
      )
      .run(next);
    return fromRaw(next);
  }

  validate(id: string, _now: string): void {
    this.#db.prepare('UPDATE todos SET touched = 1 WHERE id = ?').run(id);
  }

  /** A tolerant no-op on an `origin = 'user'` row — see this file's own
   * doc comment for why that guard is load-bearing, not defensive. */
  untouch(id: string, _now: string): void {
    this.#db.prepare("UPDATE todos SET touched = 0 WHERE id = ? AND origin = 'extracted'").run(id);
  }

  proposeUpdate(input: ProposeTodoUpdateInput): void {
    const alreadyPending = this.#db
      .prepare("SELECT 1 FROM todo_update_suggestions WHERE record_id = ? AND status = 'pending'")
      .get(input.recordId);
    if (alreadyPending) return;

    this.#db
      .prepare(
        `INSERT INTO todo_update_suggestions
           (id, record_id, entry_id, text, event_time, event_epoch_ms, event_time_explicit, reason, status, suggested_at, decided_at)
         VALUES (@id, @recordId, @entryId, @text, @eventTime, @eventEpochMs, @eventTimeExplicit, @reason, 'pending', @now, NULL)`,
      )
      .run({ ...input, eventTimeExplicit: input.eventTimeExplicit ? 1 : 0 });
  }

  listUpdateSuggestions(options: { status?: TodoUpdateSuggestion['status'] } = {}): TodoUpdateSuggestion[] {
    const rows = (
      options.status
        ? this.#db
            .prepare('SELECT * FROM todo_update_suggestions WHERE status = ? ORDER BY suggested_at DESC')
            .all(options.status)
        : this.#db.prepare('SELECT * FROM todo_update_suggestions ORDER BY suggested_at DESC').all()
    ) as RawUpdateSuggestionRow[];
    return rows.map(updateSuggestionFromRaw);
  }

  decideUpdate(id: string, decision: 'approved' | 'rejected', now: string): void {
    const apply = this.#db.transaction(() => {
      const row = this.#db
        .prepare("SELECT * FROM todo_update_suggestions WHERE id = ? AND status = 'pending'")
        .get(id) as RawUpdateSuggestionRow | undefined;
      if (!row) return;

      this.#db.prepare('UPDATE todo_update_suggestions SET status = ?, decided_at = ? WHERE id = ?').run(decision, now, id);

      if (decision === 'approved') {
        this.update(
          row.record_id,
          { text: row.text, eventTime: row.event_time, eventTimeExplicit: row.event_time_explicit === 1 },
          now,
        );
      }
    });
    apply();
  }

  /** Proposes that a *touched* to-do be marked done, because a later entry
   * says so — the touched-record counterpart to `completeFromExtraction`,
   * never applied without the user's explicit approval
   * (`requirements.md` §11). */
  proposeCompletion(input: ProposeTodoCompletionInput): void {
    const alreadyPending = this.#db
      .prepare("SELECT 1 FROM todo_completion_suggestions WHERE record_id = ? AND status = 'pending'")
      .get(input.recordId);
    if (alreadyPending) return;

    this.#db
      .prepare(
        `INSERT INTO todo_completion_suggestions
           (id, record_id, entry_id, resolution, reason, status, suggested_at, decided_at)
         VALUES (@id, @recordId, @entryId, @resolution, @reason, 'pending', @now, NULL)`,
      )
      .run(input);
  }

  listCompletionSuggestions(options: { status?: TodoCompletionSuggestion['status'] } = {}): TodoCompletionSuggestion[] {
    const rows = (
      options.status
        ? this.#db
            .prepare('SELECT * FROM todo_completion_suggestions WHERE status = ? ORDER BY suggested_at DESC')
            .all(options.status)
        : this.#db.prepare('SELECT * FROM todo_completion_suggestions ORDER BY suggested_at DESC').all()
    ) as RawCompletionSuggestionRow[];
    return rows.map(completionSuggestionFromRaw);
  }

  /** Approving bypasses the `touched = 0` guard `completeFromExtraction`
   * enforces — the user's approval *is* the authorization, the same way a
   * `todo_update_suggestions` approval bypasses nothing else about
   * `update()`. Does not disturb `touched` (already 1). */
  decideCompletion(id: string, decision: 'approved' | 'rejected', now: string): void {
    const apply = this.#db.transaction(() => {
      const row = this.#db
        .prepare("SELECT * FROM todo_completion_suggestions WHERE id = ? AND status = 'pending'")
        .get(id) as RawCompletionSuggestionRow | undefined;
      if (!row) return;

      this.#db
        .prepare('UPDATE todo_completion_suggestions SET status = ?, decided_at = ? WHERE id = ?')
        .run(decision, now, id);

      if (decision === 'approved') {
        this.#db
          .prepare(
            `UPDATE todos SET status = 'done', done_entry_id = @entryId, resolution = @resolution, done_at = @now
             WHERE id = @recordId AND status = 'open'`,
          )
          .run({ recordId: row.record_id, entryId: row.entry_id, resolution: row.resolution, now });
      }
    });
    apply();
  }

  /** An entry disappearing removes whatever it raised, and reopens whatever
   * it had reported done via that entry-driven path — a completion cannot
   * outlive the entry that made it. A `completeDirect` completion never
   * sets `doneEntryId`, so this branch never interacts with it. */
  removeEntry(entryId: string): void {
    const apply = this.#db.transaction(() => {
      this.#db.prepare('DELETE FROM todos WHERE entry_id = ?').run(entryId);
      this.#db
        .prepare(
          `UPDATE todos SET status = 'open', done_entry_id = NULL, resolution = NULL, done_at = NULL WHERE done_entry_id = ?`,
        )
        .run(entryId);
    });
    apply();
  }

  /** Discard one wrong record entirely (`requirements.md` §6.2) — works on
   * a direct-created row too, unlike `untouch`: discarding is always
   * available regardless of origin. */
  remove(id: string): void {
    this.#db.prepare('DELETE FROM todos WHERE id = ?').run(id);
  }

  list(options: ListTodosOptions): TodoRecord[] {
    const rows = (
      options.status
        ? this.#db
            .prepare('SELECT * FROM todos WHERE status = ? ORDER BY event_epoch_ms DESC LIMIT ?')
            .all(options.status, options.limit)
        : this.#db.prepare('SELECT * FROM todos ORDER BY event_epoch_ms DESC LIMIT ?').all(options.limit)
    ) as RawRow[];
    return rows.map(fromRaw);
  }

  /** Every currently open to-do, oldest first, **including `origin =
   * 'user'` rows** — a directly-created to-do can still be reported done by
   * a later entry, so the extractor's completion-matching needs the true
   * complete open set, not only what an entry raised. */
  listOpen(): TodoRecord[] {
    const rows = this.#db.prepare("SELECT * FROM todos WHERE status = 'open' ORDER BY event_epoch_ms ASC").all() as RawRow[];
    return rows.map(fromRaw);
  }

  summarize(): TodosSummary {
    const openCount = (this.#db.prepare("SELECT COUNT(*) AS n FROM todos WHERE status = 'open'").get() as { n: number }).n;
    const doneCount = (this.#db.prepare("SELECT COUNT(*) AS n FROM todos WHERE status = 'done'").get() as { n: number }).n;
    return { openCount, doneCount };
  }

  stats(): { todoCount: number; openCount: number; doneCount: number } {
    const todoCount = (this.#db.prepare('SELECT COUNT(*) AS n FROM todos').get() as { n: number }).n;
    const { openCount, doneCount } = this.summarize();
    return { todoCount, openCount, doneCount };
  }

  clear(): void {
    this.#db.exec('DELETE FROM todos;');
  }

  /** Reprocess-from-scratch entry point — wipes only untouched rows, open
   * or done. Every `origin = 'user'` row is `touched = 1` from creation and
   * `untouch()` cannot clear that (see this file's own doc comment), so
   * this can never remove one. */
  clearUntouched(): void {
    this.#db.exec('DELETE FROM todos WHERE touched = 0;');
  }

  close(): void {
    this.#db.close();
  }
}

interface RawRow {
  id: string;
  entry_id: string | null;
  text: string;
  event_time: string;
  event_epoch_ms: number;
  event_time_explicit: number;
  extracted_at: string;
  status: TodoStatus;
  done_entry_id: string | null;
  resolution: string | null;
  done_at: string | null;
  origin: TodoOrigin;
  touched: number;
}

function fromRaw(row: RawRow): TodoRecord {
  return {
    id: row.id,
    entryId: row.entry_id,
    text: row.text,
    eventTime: row.event_time,
    eventEpochMs: row.event_epoch_ms,
    eventTimeExplicit: row.event_time_explicit === 1,
    extractedAt: row.extracted_at,
    status: row.status,
    doneEntryId: row.done_entry_id,
    resolution: row.resolution,
    doneAt: row.done_at,
    origin: row.origin,
    touched: row.touched === 1,
  };
}

interface RawUpdateSuggestionRow {
  id: string;
  record_id: string;
  entry_id: string;
  text: string;
  event_time: string;
  event_epoch_ms: number;
  event_time_explicit: number;
  reason: string;
  status: TodoUpdateSuggestion['status'];
  suggested_at: string;
  decided_at: string | null;
}

function updateSuggestionFromRaw(row: RawUpdateSuggestionRow): TodoUpdateSuggestion {
  return {
    id: row.id,
    recordId: row.record_id,
    entryId: row.entry_id,
    text: row.text,
    eventTime: row.event_time,
    eventEpochMs: row.event_epoch_ms,
    eventTimeExplicit: row.event_time_explicit === 1,
    reason: row.reason,
    status: row.status,
    suggestedAt: row.suggested_at,
    decidedAt: row.decided_at,
  };
}

interface RawCompletionSuggestionRow {
  id: string;
  record_id: string;
  entry_id: string;
  resolution: string;
  reason: string;
  status: TodoCompletionSuggestion['status'];
  suggested_at: string;
  decided_at: string | null;
}

function completionSuggestionFromRaw(row: RawCompletionSuggestionRow): TodoCompletionSuggestion {
  return {
    id: row.id,
    recordId: row.record_id,
    entryId: row.entry_id,
    resolution: row.resolution,
    reason: row.reason,
    status: row.status,
    suggestedAt: row.suggested_at,
    decidedAt: row.decided_at,
  };
}
