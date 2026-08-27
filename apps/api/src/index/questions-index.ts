import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Open questions (`plan.md` M8c, `requirements.md` §5.2's spirit extended to
 * a new shape) — an eighth table in the same shared `index.db`
 * (`requirements.md` §6.4). Unlike every earlier structure, `entry_id` here
 * means one specific thing — the entry that *raised* the question — and a
 * row's `resolved_entry_id`/`resolution` may be filled in later by a
 * different entry entirely, in place, without disturbing which entry raised
 * it.
 *
 * That is why this file has no `replaceEntry`: replacing "everything tied
 * to this entry" would be ambiguous here in a way it never is for reviews,
 * lists, or opinions. `replaceRaised` only ever touches rows this entry
 * raised; `resolve` only ever touches the resolution fields of a row raised
 * by someone else.
 */

export type QuestionStatus = 'open' | 'resolved';

export interface QuestionRecord {
  id: string;
  /** The entry that raised this question — never changes once written. */
  entryId: string;
  question: string;
  eventTime: string;
  eventEpochMs: number;
  eventTimeExplicit: boolean;
  extractedAt: string;
  status: QuestionStatus;
  /** The entry that resolved it, or `null` while still open. */
  resolvedEntryId: string | null;
  resolution: string | null;
  resolvedAt: string | null;
  /** Whether the user has reviewed, corrected, or edited this record
   * (`requirements.md` §2, §6.4, `plan.md` M10). Reopening counts as a
   * touch — it is a correction, same as `reopen`'s existing role
   * (`requirements.md` §6.2). Resolution itself is left untouched by this
   * flag: `resolve()` is how new information arrives, not a regeneration of
   * old work, and stays effective on untouched questions regardless of
   * reprocessing — see `resolve()`'s own note for the one place this
   * doesn't yet hold. */
  touched: boolean;
}

/** The editable subset of what an entry *raised* — never the resolution,
 * which has its own dedicated `resolve`/`reopen` machinery. */
export interface UpdateQuestionInput {
  // See `UpdateMetricInput`'s comment for why `| undefined` is explicit.
  question?: string | undefined;
  eventTime?: string | undefined;
  eventTimeExplicit?: boolean | undefined;
}

export interface QuestionUpdateSuggestion {
  id: string;
  recordId: string;
  entryId: string;
  question: string;
  eventTime: string;
  eventEpochMs: number;
  eventTimeExplicit: boolean;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  suggestedAt: string;
  decidedAt: string | null;
}

export type ProposeQuestionUpdateInput = Omit<
  QuestionUpdateSuggestion,
  'id' | 'status' | 'suggestedAt' | 'decidedAt'
> & { id: string; now: string };

export interface ListQuestionsOptions {
  status?: QuestionStatus;
  limit: number;
}

export interface QuestionsSummary {
  openCount: number;
  resolvedCount: number;
}

/** Same shape as `MetricsReader` — the seam `http/app.ts` depends on. */
export interface QuestionsReader {
  list(options: ListQuestionsOptions): QuestionRecord[];
  /** One record by id, or `null` — see `MetricsReader.getById` (`plan.md`
   * M16). Questions have no category, so unlike the other four structures
   * there is no `allBy*`/`VisibilityDefaultsIndex` participation — only
   * direct, per-record publish/unpublish. */
  getById(id: string): QuestionRecord | null;
  remove(id: string): void;
  reopen(id: string): void;
  summarize(): QuestionsSummary;
  update(id: string, input: UpdateQuestionInput, now: string): QuestionRecord | null;
  validate(id: string, now: string): void;
  untouch(id: string, now: string): void;
  listUpdateSuggestions(options?: { status?: QuestionUpdateSuggestion['status'] }): QuestionUpdateSuggestion[];
  decideUpdate(id: string, decision: 'approved' | 'rejected', now: string): void;
}

export class QuestionsIndex implements QuestionsReader {
  readonly #db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.#db = new Database(dbPath);
    this.#db.pragma('journal_mode = WAL');
    this.#migrate();
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS questions (
        id TEXT PRIMARY KEY,
        entry_id TEXT NOT NULL,
        question TEXT NOT NULL,
        event_time TEXT NOT NULL,
        event_epoch_ms INTEGER NOT NULL,
        event_time_explicit INTEGER NOT NULL,
        extracted_at TEXT NOT NULL,
        status TEXT NOT NULL,
        resolved_entry_id TEXT,
        resolution TEXT,
        resolved_at TEXT
      );
      CREATE INDEX IF NOT EXISTS questions_entry ON questions (entry_id);
      CREATE INDEX IF NOT EXISTS questions_status ON questions (status, event_epoch_ms DESC);

      CREATE TABLE IF NOT EXISTS question_update_suggestions (
        id TEXT PRIMARY KEY,
        record_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        question TEXT NOT NULL,
        event_time TEXT NOT NULL,
        event_epoch_ms INTEGER NOT NULL,
        event_time_explicit INTEGER NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL,
        suggested_at TEXT NOT NULL,
        decided_at TEXT
      );
      CREATE INDEX IF NOT EXISTS question_update_suggestions_status ON question_update_suggestions (status);
    `);

    const columns = this.#db.prepare('PRAGMA table_info(questions)').all() as { name: string }[];
    if (!columns.some((c) => c.name === 'touched')) {
      this.#db.exec('ALTER TABLE questions ADD COLUMN touched INTEGER NOT NULL DEFAULT 0;');
    }
  }

  /** Replaces only the still-*open* questions raised by this entry. A
   * question this entry raised that has since been resolved by a later
   * entry is left alone rather than deleted-and-reinserted-fresh: it is
   * settled history now, and `entry_id` still meaning "raised by" must not
   * become a way for the raiser to accidentally undo someone else's
   * resolution of it. */
  replaceRaised(entryId: string, records: Omit<QuestionRecord, 'entryId'>[]): void {
    const insert = this.#db.transaction(() => {
      this.#db.prepare("DELETE FROM questions WHERE entry_id = ? AND status = 'open'").run(entryId);
      const stmt = this.#db.prepare(
        `INSERT INTO questions
           (id, entry_id, question, event_time, event_epoch_ms, event_time_explicit, extracted_at, status, resolved_entry_id, resolution, resolved_at)
         VALUES (@id, @entryId, @question, @eventTime, @eventEpochMs, @eventTimeExplicit, @extractedAt, @status, @resolvedEntryId, @resolution, @resolvedAt)`,
      );
      for (const record of records) {
        stmt.run({
          id: record.id,
          entryId,
          question: record.question,
          eventTime: record.eventTime,
          eventEpochMs: record.eventEpochMs,
          eventTimeExplicit: record.eventTimeExplicit ? 1 : 0,
          extractedAt: record.extractedAt,
          status: record.status,
          resolvedEntryId: record.resolvedEntryId,
          resolution: record.resolution,
          resolvedAt: record.resolvedAt,
        });
      }
    });
    insert();
  }

  /** The reprocess-safe sibling of `replaceRaised` (`plan.md` M10): only
   * open, untouched questions raised by this entry are replaced. A touched
   * question this entry raised — open or (impossible here, but see below)
   * resolved — is left exactly as stored. */
  replaceUntouchedRaised(entryId: string, records: Omit<QuestionRecord, 'entryId' | 'touched'>[]): void {
    const insert = this.#db.transaction(() => {
      this.#db
        .prepare("DELETE FROM questions WHERE entry_id = ? AND status = 'open' AND touched = 0")
        .run(entryId);
      const stmt = this.#db.prepare(
        `INSERT INTO questions
           (id, entry_id, question, event_time, event_epoch_ms, event_time_explicit, extracted_at, status, resolved_entry_id, resolution, resolved_at, touched)
         VALUES (@id, @entryId, @question, @eventTime, @eventEpochMs, @eventTimeExplicit, @extractedAt, @status, @resolvedEntryId, @resolution, @resolvedAt, 0)`,
      );
      for (const record of records) {
        stmt.run({
          id: record.id,
          entryId,
          question: record.question,
          eventTime: record.eventTime,
          eventEpochMs: record.eventEpochMs,
          eventTimeExplicit: record.eventTimeExplicit ? 1 : 0,
          extractedAt: record.extractedAt,
          status: record.status,
          resolvedEntryId: record.resolvedEntryId,
          resolution: record.resolution,
          resolvedAt: record.resolvedAt,
        });
      }
    });
    insert();
  }

  /** Open, touched questions raised by this entry — what a reprocess pass
   * compares fresh extraction against (`plan.md` M10). A resolved question
   * is never in this set: `replaceRaised`/`replaceUntouchedRaised` never
   * touch a resolved row regardless, so there is nothing to compare it
   * against. */
  touchedOpenRaisedBy(entryId: string): QuestionRecord[] {
    const rows = this.#db
      .prepare("SELECT * FROM questions WHERE entry_id = ? AND status = 'open' AND touched = 1")
      .all(entryId) as RawRow[];
    return rows.map(fromRaw);
  }

  /** Marks an open question resolved by a later entry — an update in place,
   * not a replace: the row still belongs, by `entry_id`, to whichever entry
   * originally raised it. A no-op if `id` is not currently open.
   *
   * **`AND touched = 0`**: a touched question is never auto-resolved by this
   * call (`requirements.md` §6.4). This is the one place that guard is
   * unconditional rather than reprocess-only — there is currently no live,
   * single-entry extraction path distinct from `reprocessAll`'s chronological
   * replay (every call to `resolve` today happens inside that replay), so
   * there is no "genuinely new information arriving" case to distinguish
   * from "reprocessing regenerating old work." If a live path is added
   * later, this guard needs revisiting: it should stay off there, since a
   * later entry resolving a touched-but-still-open question is new
   * information, not regeneration. */
  resolve(id: string, resolution: { resolvedEntryId: string; resolution: string; resolvedAt: string }): void {
    this.#db
      .prepare(
        `UPDATE questions
           SET status = 'resolved', resolved_entry_id = @resolvedEntryId, resolution = @resolution, resolved_at = @resolvedAt
         WHERE id = @id AND status = 'open' AND touched = 0`,
      )
      .run({ id, ...resolution });
  }

  /** Reverts a resolution without discarding the question itself — for when
   * the *match* was wrong, not the original question (`requirements.md`
   * §6.2). Reopening is itself a correction, so it touches the record: a
   * future reprocess must not silently re-resolve it the same wrong way. */
  reopen(id: string): void {
    this.#db
      .prepare(
        `UPDATE questions SET status = 'open', resolved_entry_id = NULL, resolution = NULL, resolved_at = NULL, touched = 1 WHERE id = ?`,
      )
      .run(id);
  }

  update(id: string, input: UpdateQuestionInput, _now: string): QuestionRecord | null {
    const existing = this.#db.prepare('SELECT * FROM questions WHERE id = ?').get(id) as RawRow | undefined;
    if (!existing) return null;

    const eventTimeExplicit = input.eventTimeExplicit ?? existing.event_time_explicit === 1;
    const next: RawRow = {
      ...existing,
      question: input.question ?? existing.question,
      event_time: input.eventTime ?? existing.event_time,
      event_epoch_ms: input.eventTime ? Date.parse(input.eventTime) : existing.event_epoch_ms,
      event_time_explicit: eventTimeExplicit ? 1 : 0,
      touched: 1,
    };
    this.#db
      .prepare(
        `UPDATE questions
           SET question = @question, event_time = @event_time, event_epoch_ms = @event_epoch_ms,
               event_time_explicit = @event_time_explicit, touched = 1
         WHERE id = @id`,
      )
      .run(next);
    return fromRaw(next);
  }

  validate(id: string, _now: string): void {
    this.#db.prepare('UPDATE questions SET touched = 1 WHERE id = ?').run(id);
  }

  untouch(id: string, _now: string): void {
    this.#db.prepare('UPDATE questions SET touched = 0 WHERE id = ?').run(id);
  }

  proposeUpdate(input: ProposeQuestionUpdateInput): void {
    const alreadyPending = this.#db
      .prepare("SELECT 1 FROM question_update_suggestions WHERE record_id = ? AND status = 'pending'")
      .get(input.recordId);
    if (alreadyPending) return;

    this.#db
      .prepare(
        `INSERT INTO question_update_suggestions
           (id, record_id, entry_id, question, event_time, event_epoch_ms, event_time_explicit, reason, status, suggested_at, decided_at)
         VALUES (@id, @recordId, @entryId, @question, @eventTime, @eventEpochMs, @eventTimeExplicit, @reason, 'pending', @now, NULL)`,
      )
      .run({ ...input, eventTimeExplicit: input.eventTimeExplicit ? 1 : 0 });
  }

  listUpdateSuggestions(options: { status?: QuestionUpdateSuggestion['status'] } = {}): QuestionUpdateSuggestion[] {
    const rows = (
      options.status
        ? this.#db
            .prepare('SELECT * FROM question_update_suggestions WHERE status = ? ORDER BY suggested_at DESC')
            .all(options.status)
        : this.#db.prepare('SELECT * FROM question_update_suggestions ORDER BY suggested_at DESC').all()
    ) as RawSuggestionRow[];
    return rows.map(suggestionFromRaw);
  }

  decideUpdate(id: string, decision: 'approved' | 'rejected', now: string): void {
    const apply = this.#db.transaction(() => {
      const row = this.#db
        .prepare("SELECT * FROM question_update_suggestions WHERE id = ? AND status = 'pending'")
        .get(id) as RawSuggestionRow | undefined;
      if (!row) return;

      this.#db
        .prepare('UPDATE question_update_suggestions SET status = ?, decided_at = ? WHERE id = ?')
        .run(decision, now, id);

      if (decision === 'approved') {
        this.update(row.record_id, {
          question: row.question,
          eventTime: row.event_time,
          eventTimeExplicit: row.event_time_explicit === 1,
        }, now);
      }
    });
    apply();
  }

  /** An entry disappearing removes whatever it raised, and reopens whatever
   * it had resolved — a resolution cannot outlive the entry that made it any
   * more than a review outlives the entry that wrote it. */
  removeEntry(entryId: string): void {
    const apply = this.#db.transaction(() => {
      this.#db.prepare('DELETE FROM questions WHERE entry_id = ?').run(entryId);
      this.#db
        .prepare(
          `UPDATE questions SET status = 'open', resolved_entry_id = NULL, resolution = NULL, resolved_at = NULL WHERE resolved_entry_id = ?`,
        )
        .run(entryId);
    });
    apply();
  }

  /** Discard one wrong record entirely (`requirements.md` §6.2). */
  remove(id: string): void {
    this.#db.prepare('DELETE FROM questions WHERE id = ?').run(id);
  }

  getById(id: string): QuestionRecord | null {
    const row = this.#db.prepare('SELECT * FROM questions WHERE id = ?').get(id) as RawRow | undefined;
    return row ? fromRaw(row) : null;
  }

  list(options: ListQuestionsOptions): QuestionRecord[] {
    const rows = (
      options.status
        ? this.#db
            .prepare('SELECT * FROM questions WHERE status = ? ORDER BY event_epoch_ms DESC LIMIT ?')
            .all(options.status, options.limit)
        : this.#db.prepare('SELECT * FROM questions ORDER BY event_epoch_ms DESC LIMIT ?').all(options.limit)
    ) as RawRow[];
    return rows.map(fromRaw);
  }

  /** Every currently open question, oldest first — what a new entry's
   * resolution check is matched against. Unbounded, same reasoning as
   * `OpinionStatementsIndex.bySubject`: the extractor needs the true
   * complete open set, not a page of it. */
  listOpen(): QuestionRecord[] {
    const rows = this.#db
      .prepare("SELECT * FROM questions WHERE status = 'open' ORDER BY event_epoch_ms ASC")
      .all() as RawRow[];
    return rows.map(fromRaw);
  }

  summarize(): QuestionsSummary {
    const openCount = (
      this.#db.prepare("SELECT COUNT(*) AS n FROM questions WHERE status = 'open'").get() as { n: number }
    ).n;
    const resolvedCount = (
      this.#db.prepare("SELECT COUNT(*) AS n FROM questions WHERE status = 'resolved'").get() as { n: number }
    ).n;
    return { openCount, resolvedCount };
  }

  stats(): { questionCount: number; openCount: number; resolvedCount: number } {
    const questionCount = (this.#db.prepare('SELECT COUNT(*) AS n FROM questions').get() as { n: number }).n;
    const { openCount, resolvedCount } = this.summarize();
    return { questionCount, openCount, resolvedCount };
  }

  clear(): void {
    this.#db.exec('DELETE FROM questions;');
  }

  /** Reprocess-from-scratch entry point since M10 — wipes only untouched
   * rows, open or resolved (`requirements.md` §6.4). */
  clearUntouched(): void {
    this.#db.exec('DELETE FROM questions WHERE touched = 0;');
  }

  close(): void {
    this.#db.close();
  }
}

interface RawRow {
  id: string;
  entry_id: string;
  question: string;
  event_time: string;
  event_epoch_ms: number;
  event_time_explicit: number;
  extracted_at: string;
  status: QuestionStatus;
  resolved_entry_id: string | null;
  resolution: string | null;
  resolved_at: string | null;
  touched: number;
}

function fromRaw(row: RawRow): QuestionRecord {
  return {
    id: row.id,
    entryId: row.entry_id,
    question: row.question,
    eventTime: row.event_time,
    eventEpochMs: row.event_epoch_ms,
    eventTimeExplicit: row.event_time_explicit === 1,
    extractedAt: row.extracted_at,
    status: row.status,
    resolvedEntryId: row.resolved_entry_id,
    resolution: row.resolution,
    resolvedAt: row.resolved_at,
    touched: row.touched === 1,
  };
}

interface RawSuggestionRow {
  id: string;
  record_id: string;
  entry_id: string;
  question: string;
  event_time: string;
  event_epoch_ms: number;
  event_time_explicit: number;
  reason: string;
  status: QuestionUpdateSuggestion['status'];
  suggested_at: string;
  decided_at: string | null;
}

function suggestionFromRaw(row: RawSuggestionRow): QuestionUpdateSuggestion {
  return {
    id: row.id,
    recordId: row.record_id,
    entryId: row.entry_id,
    question: row.question,
    eventTime: row.event_time,
    eventEpochMs: row.event_epoch_ms,
    eventTimeExplicit: row.event_time_explicit === 1,
    reason: row.reason,
    status: row.status,
    suggestedAt: row.suggested_at,
    decidedAt: row.decided_at,
  };
}
