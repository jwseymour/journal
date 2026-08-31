import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Layer 1 of the opinion model (`plan.md` M8, `requirements.md` §5.2) — one
 * statement per entry per subject, the same shape as `MetricsIndex`: a
 * sixth table in the same shared `index.db` (`requirements.md` §6.4), every
 * row linking back to the entry it came from, corrected by discarding, never
 * hand-edited (§9).
 *
 * `OpinionSummarizer` reads this table (via `bySubject`) to build the
 * regenerated, cited per-subject summary (layer 2) — nothing here is
 * itself a summary.
 */

/** One approved subject and how many statements it's gathered — mirrors
 * `ListsIndex`'s local `ListTypeSummary`, structurally identical to the
 * contract's own `OpinionSubjectSummary` without importing it (same
 * convention every sibling index file already uses). */
export interface OpinionSubjectSummary {
  subject: string;
  count: number;
}

export interface OpinionStatementRecord {
  id: string;
  entryId: string;
  subject: string;
  statement: string;
  eventTime: string;
  eventEpochMs: number;
  eventTimeExplicit: boolean;
  extractedAt: string;
  /** Whether the user has reviewed, corrected, or edited this record
   * (`requirements.md` §2, §6.4, `plan.md` M10). */
  touched: boolean;
}

/** The editable subset — everything except `id`, `entryId`, `subject` (an
 * approved category, not free content), and `touched` itself. */
export interface UpdateOpinionStatementInput {
  // See `UpdateMetricInput`'s comment for why `| undefined` is explicit.
  statement?: string | undefined;
  eventTime?: string | undefined;
  eventTimeExplicit?: boolean | undefined;
}

export interface OpinionStatementUpdateSuggestion {
  id: string;
  recordId: string;
  entryId: string;
  statement: string;
  eventTime: string;
  eventEpochMs: number;
  eventTimeExplicit: boolean;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  suggestedAt: string;
  decidedAt: string | null;
}

export type ProposeOpinionStatementUpdateInput = Omit<
  OpinionStatementUpdateSuggestion,
  'id' | 'status' | 'suggestedAt' | 'decidedAt'
> & { id: string; now: string };

export interface ListOpinionStatementsOptions {
  subject?: string;
  limit: number;
}

/** Same shape as `MetricsReader` — the seam `http/app.ts` depends on. */
export interface OpinionStatementsReader {
  list(options: ListOpinionStatementsOptions): OpinionStatementRecord[];
  /** One record by id, or `null` — see `MetricsReader.getById` (`plan.md` M16). */
  getById(id: string): OpinionStatementRecord | null;
  /** Every current statement for one subject, unbounded — see
   * `MetricsReader.allByMetric` (`plan.md` M16); already existed on the
   * concrete class for `OpinionSummarizer`, now also part of the reader
   * interface so `/publish-queue` can depend on it too. */
  bySubject(subject: string): OpinionStatementRecord[];
  /** One `OpinionSubjectSummary` per approved subject, in the order given,
   * so a subject with zero statements yet still gets its own row — mirrors
   * `ListsReader.summarize` (`requirements.md` §5.2, reframed 2026-08-30
   * for the analysis page's own Opinions section). */
  summarize(approvedSubjects: readonly string[]): OpinionSubjectSummary[];
  remove(id: string): void;
  update(id: string, input: UpdateOpinionStatementInput, now: string): OpinionStatementRecord | null;
  validate(id: string, now: string): void;
  untouch(id: string, now: string): void;
  listUpdateSuggestions(options?: {
    status?: OpinionStatementUpdateSuggestion['status'];
  }): OpinionStatementUpdateSuggestion[];
  decideUpdate(id: string, decision: 'approved' | 'rejected', now: string): void;
}

export class OpinionStatementsIndex implements OpinionStatementsReader {
  readonly #db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.#db = new Database(dbPath);
    this.#db.pragma('journal_mode = WAL');
    this.#migrate();
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS opinion_statements (
        id TEXT PRIMARY KEY,
        entry_id TEXT NOT NULL,
        subject TEXT NOT NULL,
        statement TEXT NOT NULL,
        event_time TEXT NOT NULL,
        event_epoch_ms INTEGER NOT NULL,
        event_time_explicit INTEGER NOT NULL,
        extracted_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS opinion_statements_entry ON opinion_statements (entry_id);
      CREATE INDEX IF NOT EXISTS opinion_statements_subject ON opinion_statements (subject, event_epoch_ms);

      CREATE TABLE IF NOT EXISTS opinion_statement_update_suggestions (
        id TEXT PRIMARY KEY,
        record_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        statement TEXT NOT NULL,
        event_time TEXT NOT NULL,
        event_epoch_ms INTEGER NOT NULL,
        event_time_explicit INTEGER NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL,
        suggested_at TEXT NOT NULL,
        decided_at TEXT
      );
      CREATE INDEX IF NOT EXISTS opinion_statement_update_suggestions_status ON opinion_statement_update_suggestions (status);
    `);

    const columns = this.#db.prepare('PRAGMA table_info(opinion_statements)').all() as { name: string }[];
    if (!columns.some((c) => c.name === 'touched')) {
      this.#db.exec('ALTER TABLE opinion_statements ADD COLUMN touched INTEGER NOT NULL DEFAULT 0;');
    }
  }

  /** Always the full set for an entry — see `MetricsIndex.replaceEntry` for
   * why a partial update is never the right shape here. */
  replaceEntry(entryId: string, records: Omit<OpinionStatementRecord, 'entryId'>[]): void {
    const insert = this.#db.transaction(() => {
      this.#db.prepare('DELETE FROM opinion_statements WHERE entry_id = ?').run(entryId);
      const stmt = this.#db.prepare(
        `INSERT INTO opinion_statements
           (id, entry_id, subject, statement, event_time, event_epoch_ms, event_time_explicit, extracted_at)
         VALUES (@id, @entryId, @subject, @statement, @eventTime, @eventEpochMs, @eventTimeExplicit, @extractedAt)`,
      );
      for (const record of records) {
        stmt.run({
          id: record.id,
          entryId,
          subject: record.subject,
          statement: record.statement,
          eventTime: record.eventTime,
          eventEpochMs: record.eventEpochMs,
          eventTimeExplicit: record.eventTimeExplicit ? 1 : 0,
          extractedAt: record.extractedAt,
        });
      }
    });
    insert();
  }

  /** The reprocess-safe sibling of `replaceEntry` (`plan.md` M10). */
  replaceUntouchedForEntry(entryId: string, records: Omit<OpinionStatementRecord, 'entryId' | 'touched'>[]): void {
    const insert = this.#db.transaction(() => {
      this.#db.prepare('DELETE FROM opinion_statements WHERE entry_id = ? AND touched = 0').run(entryId);
      const stmt = this.#db.prepare(
        `INSERT INTO opinion_statements
           (id, entry_id, subject, statement, event_time, event_epoch_ms, event_time_explicit, extracted_at, touched)
         VALUES (@id, @entryId, @subject, @statement, @eventTime, @eventEpochMs, @eventTimeExplicit, @extractedAt, 0)`,
      );
      for (const record of records) {
        stmt.run({
          id: record.id,
          entryId,
          subject: record.subject,
          statement: record.statement,
          eventTime: record.eventTime,
          eventEpochMs: record.eventEpochMs,
          eventTimeExplicit: record.eventTimeExplicit ? 1 : 0,
          extractedAt: record.extractedAt,
        });
      }
    });
    insert();
  }

  touchedForEntry(entryId: string): OpinionStatementRecord[] {
    const rows = this.#db
      .prepare('SELECT * FROM opinion_statements WHERE entry_id = ? AND touched = 1')
      .all(entryId) as RawRow[];
    return rows.map(fromRaw);
  }

  removeEntry(entryId: string): void {
    this.#db.prepare('DELETE FROM opinion_statements WHERE entry_id = ?').run(entryId);
  }

  getById(id: string): OpinionStatementRecord | null {
    const row = this.#db.prepare('SELECT * FROM opinion_statements WHERE id = ?').get(id) as RawRow | undefined;
    return row ? fromRaw(row) : null;
  }

  /** Discard one wrong statement (`requirements.md` §6.2). Any summary part
   * citing it is left stale until the next `reprocess` regenerates
   * summaries — a summary is a derived view, never itself hand-corrected. */
  remove(id: string): void {
    this.#db.prepare('DELETE FROM opinion_statements WHERE id = ?').run(id);
  }

  update(id: string, input: UpdateOpinionStatementInput, _now: string): OpinionStatementRecord | null {
    const existing = this.#db.prepare('SELECT * FROM opinion_statements WHERE id = ?').get(id) as RawRow | undefined;
    if (!existing) return null;

    const eventTimeExplicit = input.eventTimeExplicit ?? existing.event_time_explicit === 1;
    const next: RawRow = {
      ...existing,
      statement: input.statement ?? existing.statement,
      event_time: input.eventTime ?? existing.event_time,
      event_epoch_ms: input.eventTime ? Date.parse(input.eventTime) : existing.event_epoch_ms,
      event_time_explicit: eventTimeExplicit ? 1 : 0,
      touched: 1,
    };
    this.#db
      .prepare(
        `UPDATE opinion_statements
           SET statement = @statement, event_time = @event_time, event_epoch_ms = @event_epoch_ms,
               event_time_explicit = @event_time_explicit, touched = 1
         WHERE id = @id`,
      )
      .run(next);
    return fromRaw(next);
  }

  validate(id: string, _now: string): void {
    this.#db.prepare('UPDATE opinion_statements SET touched = 1 WHERE id = ?').run(id);
  }

  untouch(id: string, _now: string): void {
    this.#db.prepare('UPDATE opinion_statements SET touched = 0 WHERE id = ?').run(id);
  }

  proposeUpdate(input: ProposeOpinionStatementUpdateInput): void {
    const alreadyPending = this.#db
      .prepare("SELECT 1 FROM opinion_statement_update_suggestions WHERE record_id = ? AND status = 'pending'")
      .get(input.recordId);
    if (alreadyPending) return;

    this.#db
      .prepare(
        `INSERT INTO opinion_statement_update_suggestions
           (id, record_id, entry_id, statement, event_time, event_epoch_ms, event_time_explicit, reason, status, suggested_at, decided_at)
         VALUES (@id, @recordId, @entryId, @statement, @eventTime, @eventEpochMs, @eventTimeExplicit, @reason, 'pending', @now, NULL)`,
      )
      .run({ ...input, eventTimeExplicit: input.eventTimeExplicit ? 1 : 0 });
  }

  listUpdateSuggestions(
    options: { status?: OpinionStatementUpdateSuggestion['status'] } = {},
  ): OpinionStatementUpdateSuggestion[] {
    const rows = (
      options.status
        ? this.#db
            .prepare('SELECT * FROM opinion_statement_update_suggestions WHERE status = ? ORDER BY suggested_at DESC')
            .all(options.status)
        : this.#db.prepare('SELECT * FROM opinion_statement_update_suggestions ORDER BY suggested_at DESC').all()
    ) as RawSuggestionRow[];
    return rows.map(suggestionFromRaw);
  }

  decideUpdate(id: string, decision: 'approved' | 'rejected', now: string): void {
    const apply = this.#db.transaction(() => {
      const row = this.#db
        .prepare("SELECT * FROM opinion_statement_update_suggestions WHERE id = ? AND status = 'pending'")
        .get(id) as RawSuggestionRow | undefined;
      if (!row) return;

      this.#db
        .prepare('UPDATE opinion_statement_update_suggestions SET status = ?, decided_at = ? WHERE id = ?')
        .run(decision, now, id);

      if (decision === 'approved') {
        this.update(row.record_id, {
          statement: row.statement,
          eventTime: row.event_time,
          eventTimeExplicit: row.event_time_explicit === 1,
        }, now);
      }
    });
    apply();
  }

  list(options: ListOpinionStatementsOptions): OpinionStatementRecord[] {
    const rows = (
      options.subject
        ? this.#db
            .prepare('SELECT * FROM opinion_statements WHERE subject = ? ORDER BY event_epoch_ms DESC LIMIT ?')
            .all(options.subject, options.limit)
        : this.#db
            .prepare('SELECT * FROM opinion_statements ORDER BY event_epoch_ms DESC LIMIT ?')
            .all(options.limit)
    ) as RawRow[];
    return rows.map(fromRaw);
  }

  /** Every current statement for one subject, oldest first — what the
   * summariser reads to build a cited summary. Unbounded (not paginated):
   * the summariser needs the true complete set, not a page of it. */
  bySubject(subject: string): OpinionStatementRecord[] {
    const rows = this.#db
      .prepare('SELECT * FROM opinion_statements WHERE subject = ? ORDER BY event_epoch_ms ASC')
      .all(subject) as RawRow[];
    return rows.map(fromRaw);
  }

  /** One row per approved subject, in the order given — see
   * `ListsIndex.summarize` for the identical pattern this mirrors. */
  summarize(approvedSubjects: readonly string[]): OpinionSubjectSummary[] {
    const stmt = this.#db.prepare('SELECT COUNT(*) AS n FROM opinion_statements WHERE subject = ?');
    return approvedSubjects.map((subject) => ({ subject, count: (stmt.get(subject) as { n: number }).n }));
  }

  /** Every subject with at least one statement — what `reprocess` iterates
   * to know which summaries need regenerating. */
  subjectsWithStatements(): string[] {
    const rows = this.#db
      .prepare('SELECT DISTINCT subject FROM opinion_statements ORDER BY subject')
      .all() as { subject: string }[];
    return rows.map((r) => r.subject);
  }

  /** Restores one touched record from the durable off-index mirror
   * (`durable/touched-mirror.ts`) — see `MetricsIndex.restoreTouched` for
   * the full reasoning; identical shape here. */
  restoreTouched(record: OpinionStatementRecord): void {
    this.#db
      .prepare(
        `INSERT OR REPLACE INTO opinion_statements
           (id, entry_id, subject, statement, event_time, event_epoch_ms, event_time_explicit, extracted_at, touched)
         VALUES (@id, @entryId, @subject, @statement, @eventTime, @eventEpochMs, @eventTimeExplicit, @extractedAt, 1)`,
      )
      .run({
        id: record.id,
        entryId: record.entryId,
        subject: record.subject,
        statement: record.statement,
        eventTime: record.eventTime,
        eventEpochMs: record.eventEpochMs,
        eventTimeExplicit: record.eventTimeExplicit ? 1 : 0,
        extractedAt: record.extractedAt,
      });
  }

  stats(): { statementCount: number } {
    const statementCount = (
      this.#db.prepare('SELECT COUNT(*) AS n FROM opinion_statements').get() as { n: number }
    ).n;
    return { statementCount };
  }

  clear(): void {
    this.#db.exec('DELETE FROM opinion_statements;');
  }

  /** Reprocess-from-scratch entry point since M10 — wipes only untouched
   * rows (`requirements.md` §6.4). */
  clearUntouched(): void {
    this.#db.exec('DELETE FROM opinion_statements WHERE touched = 0;');
  }

  close(): void {
    this.#db.close();
  }
}

interface RawRow {
  id: string;
  entry_id: string;
  subject: string;
  statement: string;
  event_time: string;
  event_epoch_ms: number;
  event_time_explicit: number;
  extracted_at: string;
  touched: number;
}

function fromRaw(row: RawRow): OpinionStatementRecord {
  return {
    id: row.id,
    entryId: row.entry_id,
    subject: row.subject,
    statement: row.statement,
    eventTime: row.event_time,
    eventEpochMs: row.event_epoch_ms,
    eventTimeExplicit: row.event_time_explicit === 1,
    extractedAt: row.extracted_at,
    touched: row.touched === 1,
  };
}

interface RawSuggestionRow {
  id: string;
  record_id: string;
  entry_id: string;
  statement: string;
  event_time: string;
  event_epoch_ms: number;
  event_time_explicit: number;
  reason: string;
  status: OpinionStatementUpdateSuggestion['status'];
  suggested_at: string;
  decided_at: string | null;
}

function suggestionFromRaw(row: RawSuggestionRow): OpinionStatementUpdateSuggestion {
  return {
    id: row.id,
    recordId: row.record_id,
    entryId: row.entry_id,
    statement: row.statement,
    eventTime: row.event_time,
    eventEpochMs: row.event_epoch_ms,
    eventTimeExplicit: row.event_time_explicit === 1,
    reason: row.reason,
    status: row.status,
    suggestedAt: row.suggested_at,
    decidedAt: row.decided_at,
  };
}
