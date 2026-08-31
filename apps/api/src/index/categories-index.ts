import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Approved categories, and pending AI suggestions for new ones
 * (`plan.md` M8, `requirements.md` §5.3: "the AI does not autonomously
 * create new metrics... two routes exist: the AI suggests a new metric and
 * the user approves it, or the user requests one directly").
 *
 * One mechanism shared across every structure type that has an open-ended
 * category field — temporal metrics (`metric`), reviews (`medium`), and
 * lists of atomic items (`listType`) — rather than three separate
 * approval systems. `structureType` is what tells them apart; the shape of
 * "a name, approved or not" is identical for all three, which is exactly
 * the "addition rather than a reorganisation" property `plan.md` M8's own
 * done-when criterion asks for: a fourth structure type with its own
 * open-ended field reuses this file unchanged.
 *
 * Living in the same shared database file as every other derived table —
 * approvals and suggestions are themselves derived state, not journal
 * content, and `rebuild-index`/`reprocess` never touch this table, so an
 * approval survives a reprocess the way a `DELETE /metrics/:id` correction
 * deliberately does not (see `README.md`).
 */

export type CoreStructureType = 'metric' | 'review_medium' | 'list_type' | 'opinion_subject';
/** One per user-defined metric field of type `enum` — its approved values
 * reuse this same mechanism unchanged, the same way a fourth core structure
 * type would (see the doc comment above). `structure_type` is a plain TEXT
 * column with no CHECK constraint, so this template needs nothing but a
 * wider type here. */
export type MetricFieldStructureType = `metric_field:${string}:${string}`;
export type StructureType = CoreStructureType | MetricFieldStructureType;
/** `'parked'` (`plan.md` M18) — set aside to reconsider later, neither
 * approved nor rejected; see `decide`'s own comment. */
export type SuggestionStatus = 'pending' | 'approved' | 'rejected' | 'parked';

export interface CategorySuggestion {
  id: string;
  structureType: StructureType;
  name: string;
  reason: string;
  entryId: string;
  status: SuggestionStatus;
  suggestedAt: string;
  decidedAt: string | null;
}

/** Same shape as `MetricsReader` — the seam `http/app.ts` depends on. */
export interface CategoriesReader {
  approvedNames(structureType: StructureType): string[];
  approveDirectly(structureType: StructureType, name: string, now: string): void;
  listSuggestions(options?: { structureType?: StructureType; status?: SuggestionStatus }): CategorySuggestion[];
  /** `'parked'` (`plan.md` M18) is handled identically to `'rejected'` here
   * — a plain status flip, no side effect — the only difference is the
   * status value itself, which the frontend uses to show a passive "set
   * aside" shelf distinct from an outright rejection. */
  decide(id: string, decision: 'approved' | 'rejected' | 'parked', now: string): void;
}

export class CategoriesIndex implements CategoriesReader {
  readonly #db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.#db = new Database(dbPath);
    this.#db.pragma('journal_mode = WAL');
    this.#migrate();
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS categories (
        structure_type TEXT NOT NULL,
        name TEXT NOT NULL,
        approved_at TEXT NOT NULL,
        PRIMARY KEY (structure_type, name)
      );

      CREATE TABLE IF NOT EXISTS category_suggestions (
        id TEXT PRIMARY KEY,
        structure_type TEXT NOT NULL,
        name TEXT NOT NULL,
        reason TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        status TEXT NOT NULL,
        suggested_at TEXT NOT NULL,
        decided_at TEXT
      );
      CREATE INDEX IF NOT EXISTS category_suggestions_status ON category_suggestions (structure_type, status);
    `);
  }

  /** Bootstraps the seed set `requirements.md` §5.2 itself names — a
   * one-time, idempotent insert, never something extraction or a reprocess
   * touches (`INSERT OR IGNORE`, so re-seeding never clobbers a category a
   * user later removed by hand, if that ever becomes possible). */
  seed(structureType: StructureType, names: readonly string[], now: string): void {
    const stmt = this.#db.prepare(
      'INSERT OR IGNORE INTO categories (structure_type, name, approved_at) VALUES (?, ?, ?)',
    );
    for (const name of names) stmt.run(structureType, name, now);
  }

  /** The names extraction is currently allowed to use — always sorted, so
   * the prompt built from this list is stable across calls with nothing new
   * approved in between. */
  approvedNames(structureType: StructureType): string[] {
    const rows = this.#db
      .prepare('SELECT name FROM categories WHERE structure_type = ? ORDER BY name')
      .all(structureType) as { name: string }[];
    return rows.map((r) => r.name);
  }

  /** The user requesting a category directly (`requirements.md` §5.3's
   * second route) — approved immediately, no suggestion record at all. */
  approveDirectly(structureType: StructureType, name: string, now: string): void {
    this.#db
      .prepare('INSERT OR IGNORE INTO categories (structure_type, name, approved_at) VALUES (?, ?, ?)')
      .run(structureType, name, now);
  }

  /**
   * The AI suggesting a category (`requirements.md` §5.3's first route) —
   * never auto-approved. A no-op if this exact name is already approved, or
   * already has a pending suggestion, so a model that notices the same gap
   * on every entry doesn't flood the queue with duplicates.
   */
  suggest(input: { structureType: StructureType; name: string; reason: string; entryId: string; id: string; now: string }): void {
    const alreadyApproved = this.#db
      .prepare('SELECT 1 FROM categories WHERE structure_type = ? AND name = ?')
      .get(input.structureType, input.name);
    if (alreadyApproved) return;

    const alreadyPending = this.#db
      .prepare("SELECT 1 FROM category_suggestions WHERE structure_type = ? AND name = ? AND status = 'pending'")
      .get(input.structureType, input.name);
    if (alreadyPending) return;

    this.#db
      .prepare(
        `INSERT INTO category_suggestions (id, structure_type, name, reason, entry_id, status, suggested_at, decided_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL)`,
      )
      .run(input.id, input.structureType, input.name, input.reason, input.entryId, input.now);
  }

  listSuggestions(options: { structureType?: StructureType; status?: SuggestionStatus } = {}): CategorySuggestion[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options.structureType) {
      clauses.push('structure_type = ?');
      params.push(options.structureType);
    }
    if (options.status) {
      clauses.push('status = ?');
      params.push(options.status);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.#db
      .prepare(`SELECT * FROM category_suggestions ${where} ORDER BY suggested_at DESC`)
      .all(...params) as RawSuggestion[];
    return rows.map(fromRaw);
  }

  getSuggestion(id: string): CategorySuggestion | null {
    const row = this.#db.prepare('SELECT * FROM category_suggestions WHERE id = ?').get(id) as
      | RawSuggestion
      | undefined;
    return row ? fromRaw(row) : null;
  }

  /** Approving or rejecting an AI suggestion. Approving also adds the name
   * to the approved set in the same transaction — the two must never
   * disagree with each other. A no-op, not an error, for a suggestion that
   * is not pending (already decided, or never existed). */
  decide(id: string, decision: 'approved' | 'rejected' | 'parked', now: string): void {
    const apply = this.#db.transaction(() => {
      const row = this.#db.prepare("SELECT * FROM category_suggestions WHERE id = ? AND status = 'pending'").get(id) as
        | RawSuggestion
        | undefined;
      if (!row) return;

      this.#db
        .prepare('UPDATE category_suggestions SET status = ?, decided_at = ? WHERE id = ?')
        .run(decision, now, id);

      if (decision === 'approved') {
        this.#db
          .prepare('INSERT OR IGNORE INTO categories (structure_type, name, approved_at) VALUES (?, ?, ?)')
          .run(row.structure_type, row.name, now);
      }
    });
    apply();
  }

  close(): void {
    this.#db.close();
  }
}

interface RawSuggestion {
  id: string;
  structure_type: StructureType;
  name: string;
  reason: string;
  entry_id: string;
  status: SuggestionStatus;
  suggested_at: string;
  decided_at: string | null;
}

function fromRaw(row: RawSuggestion): CategorySuggestion {
  return {
    id: row.id,
    structureType: row.structure_type,
    name: row.name,
    reason: row.reason,
    entryId: row.entry_id,
    status: row.status,
    suggestedAt: row.suggested_at,
    decidedAt: row.decided_at,
  };
}
