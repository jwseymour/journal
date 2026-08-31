import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TouchedSourceType } from '../durable/touched-mirror.js';

/**
 * Every candidate a live `POST /entries/:id/process` run produces
 * (`plan.md` M18) — one generic table shared across all six structure
 * types, rather than six parallel copies of the same shape. Nothing here is
 * ever a live, queryable record on its own: this table only ever holds
 * *proposals*, and the actual "make it real" step is a separate applier
 * (`model/pending-item-applier.ts`) that calls the target structure's own
 * index methods after `decide()` below flips a row to `'approved'`. Keeping
 * this class ignorant of `MetricsIndex`/`ReviewsIndex`/etc. is what keeps it
 * a genuinely generic table instead of a sixth copy of the coupling problem
 * a per-type pending table would have been.
 *
 * This is a deliberate, on-the-record reversal of `requirements.md` §6.1
 * ("explicit statements are auto-committed without approval... approval is
 * the exception") — see that section's rewrite. It replaces silent live
 * commit with grouped, batchable approval, not with constant per-fact
 * confirmation, which is what §6.1 was actually guarding against.
 */

export type PendingItemStructureType = TouchedSourceType;
export type PendingItemKind = 'new' | 'update' | 'resolution' | 'completion';
export type PendingItemConfidence = 'high' | 'medium' | 'low';
export type PendingItemStatus = 'pending' | 'approved' | 'rejected' | 'superseded';

export interface PendingExtractionItem {
  id: string;
  entryId: string;
  processRunId: string;
  structureType: PendingItemStructureType;
  kind: PendingItemKind;
  /** The existing live record this item targets — present for every kind
   * except `'new'`. */
  targetRecordId: string | null;
  /** The record's metric/medium/listType/subject, denormalized so grouping
   * and the visibility-default lookup on approval never have to decode
   * `payload` first. `null` for `'question'`/`'todo'`, which have no
   * category namespace (`structure-types.ts`). */
  category: string | null;
  /** JSON, shape keyed by `(structureType, kind)` — see
   * `packages/contract`'s `PendingItemPayload` for the discriminated union
   * this is validated against before insertion. */
  payload: Record<string, unknown>;
  confidence: PendingItemConfidence;
  reason: string | null;
  status: PendingItemStatus;
  createdAt: string;
  decidedAt: string | null;
}

export type CreatePendingItemInput = Omit<PendingExtractionItem, 'status' | 'decidedAt'>;

export interface ListPendingItemsOptions {
  entryId?: string;
  structureType?: PendingItemStructureType;
  status?: PendingItemStatus;
}

/** The seam `http/app.ts` depends on — same shape as `MetricsReader`. */
export interface PendingItemsReader {
  list(options?: ListPendingItemsOptions): PendingExtractionItem[];
  getById(id: string): PendingExtractionItem | null;
  insertBatch(items: CreatePendingItemInput[]): void;
  /** Marks every still-`pending` row for `entryId` other than `runId` as
   * `'superseded'` — called once at the start of a fresh Process run so a
   * re-run never leaves two live batches for the same entry
   * (`plan.md` M18). Rows already `approved`/`rejected` are left alone: only
   * *undecided* leftovers from a stale run are ever touched. */
  supersedePendingForEntry(entryId: string, runId: string, now: string): void;
  /** Flips status only — never applies anything to the target structure
   * itself. `null` if `id` is not currently pending, the same "nothing to
   * decide" tolerance `MetricsIndex.decideUpdate` already has. The caller
   * (`http/app.ts`, via `pending-item-applier.ts`) is responsible for the
   * actual commit/publish side effect once this returns non-null. */
  decide(id: string, decision: 'approved' | 'rejected', now: string): PendingExtractionItem | null;
}

export class PendingItemsIndex implements PendingItemsReader {
  readonly #db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.#db = new Database(dbPath);
    this.#db.pragma('journal_mode = WAL');
    this.#migrate();
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS pending_extraction_items (
        id TEXT PRIMARY KEY,
        entry_id TEXT NOT NULL,
        process_run_id TEXT NOT NULL,
        structure_type TEXT NOT NULL,
        kind TEXT NOT NULL,
        target_record_id TEXT,
        category TEXT,
        payload TEXT NOT NULL,
        confidence TEXT NOT NULL,
        reason TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        decided_at TEXT
      );
      CREATE INDEX IF NOT EXISTS pending_items_entry ON pending_extraction_items (entry_id, status);
      CREATE INDEX IF NOT EXISTS pending_items_status ON pending_extraction_items (status, structure_type);
      CREATE INDEX IF NOT EXISTS pending_items_run ON pending_extraction_items (process_run_id, status);
    `);
  }

  /** Inserts every candidate from one Process run in a single transaction —
   * the run either fully lands or, on an unexpected error, fully doesn't;
   * there is no "half a batch" state for the popup to render. */
  insertBatch(items: CreatePendingItemInput[]): void {
    if (items.length === 0) return;
    const insert = this.#db.transaction(() => {
      const stmt = this.#db.prepare(
        `INSERT INTO pending_extraction_items
           (id, entry_id, process_run_id, structure_type, kind, target_record_id, category, payload, confidence, reason, status, created_at, decided_at)
         VALUES (@id, @entryId, @processRunId, @structureType, @kind, @targetRecordId, @category, @payload, @confidence, @reason, 'pending', @createdAt, NULL)`,
      );
      for (const item of items) {
        stmt.run({
          id: item.id,
          entryId: item.entryId,
          processRunId: item.processRunId,
          structureType: item.structureType,
          kind: item.kind,
          targetRecordId: item.targetRecordId,
          category: item.category,
          payload: JSON.stringify(item.payload),
          confidence: item.confidence,
          reason: item.reason,
          createdAt: item.createdAt,
        });
      }
    });
    insert();
  }

  supersedePendingForEntry(entryId: string, runId: string, now: string): void {
    this.#db
      .prepare(
        `UPDATE pending_extraction_items
           SET status = 'superseded', decided_at = @now
         WHERE entry_id = @entryId AND process_run_id != @runId AND status = 'pending'`,
      )
      .run({ entryId, runId, now });
  }

  decide(id: string, decision: 'approved' | 'rejected', now: string): PendingExtractionItem | null {
    const row = this.#db
      .prepare("SELECT * FROM pending_extraction_items WHERE id = ? AND status = 'pending'")
      .get(id) as RawRow | undefined;
    if (!row) return null;

    this.#db
      .prepare('UPDATE pending_extraction_items SET status = ?, decided_at = ? WHERE id = ?')
      .run(decision, now, id);
    return fromRaw({ ...row, status: decision, decided_at: now });
  }

  getById(id: string): PendingExtractionItem | null {
    const row = this.#db.prepare('SELECT * FROM pending_extraction_items WHERE id = ?').get(id) as RawRow | undefined;
    return row ? fromRaw(row) : null;
  }

  list(options: ListPendingItemsOptions = {}): PendingExtractionItem[] {
    const clauses: string[] = [];
    const params: Record<string, string> = {};
    if (options.entryId !== undefined) {
      clauses.push('entry_id = @entryId');
      params.entryId = options.entryId;
    }
    if (options.structureType !== undefined) {
      clauses.push('structure_type = @structureType');
      params.structureType = options.structureType;
    }
    if (options.status !== undefined) {
      clauses.push('status = @status');
      params.status = options.status;
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.#db
      .prepare(`SELECT * FROM pending_extraction_items ${where} ORDER BY created_at ASC`)
      .all(params) as RawRow[];
    return rows.map(fromRaw);
  }

  /** Every row belonging to an entry that no longer exists, cascade-deleted
   * the same way the six structure indexes' own `removeEntry` methods work —
   * called when an entry itself is deleted. */
  removeEntry(entryId: string): void {
    this.#db.prepare('DELETE FROM pending_extraction_items WHERE entry_id = ?').run(entryId);
  }

  close(): void {
    this.#db.close();
  }
}

interface RawRow {
  id: string;
  entry_id: string;
  process_run_id: string;
  structure_type: string;
  kind: string;
  target_record_id: string | null;
  category: string | null;
  payload: string;
  confidence: string;
  reason: string | null;
  status: string;
  created_at: string;
  decided_at: string | null;
}

function fromRaw(row: RawRow): PendingExtractionItem {
  return {
    id: row.id,
    entryId: row.entry_id,
    processRunId: row.process_run_id,
    structureType: row.structure_type as PendingItemStructureType,
    kind: row.kind as PendingItemKind,
    targetRecordId: row.target_record_id,
    category: row.category,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    confidence: row.confidence as PendingItemConfidence,
    reason: row.reason,
    status: row.status as PendingItemStatus,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  };
}
