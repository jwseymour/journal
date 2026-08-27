import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CoreStructureType } from './categories-index.js';

/**
 * "These are public by default" settings, one per category
 * (`requirements.md` §11, `plan.md` M16) — keyed on exactly the same
 * category vocabulary `CategoriesIndex` already uses (`metric`,
 * `review_medium`, `list_type`, `opinion_subject`), not a separate taxonomy.
 * Questions have no category (`QuestionsIndex`'s own doc comment explains
 * why) and so never appear here — a question is only ever published one at
 * a time, directly.
 *
 * Setting a default here never publishes anything by itself. It only
 * changes what `/publish-queue` (`plan.md` M16) surfaces for one-click
 * confirmation — publishing is always a separate, explicit act through
 * `Publisher`, the same "AI suggests, user approves" shape
 * `requirements.md` §5.3 already uses for categories themselves.
 */

export interface VisibilityDefaultRow {
  structureType: CoreStructureType;
  category: string;
  defaultPublic: boolean;
}

interface RawRow {
  structure_type: CoreStructureType;
  category: string;
  default_public: number;
}

function fromRaw(row: RawRow): VisibilityDefaultRow {
  return { structureType: row.structure_type, category: row.category, defaultPublic: row.default_public === 1 };
}

/** Same shape as `MetricsReader` — the seam `http/app.ts` depends on. */
export interface VisibilityDefaultsReader {
  list(): VisibilityDefaultRow[];
  isDefaultPublic(structureType: CoreStructureType, category: string): boolean;
  set(structureType: CoreStructureType, category: string, defaultPublic: boolean): void;
}

export class VisibilityDefaultsIndex implements VisibilityDefaultsReader {
  readonly #db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.#db = new Database(dbPath);
    this.#db.pragma('journal_mode = WAL');
    this.#migrate();
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS visibility_defaults (
        structure_type TEXT NOT NULL,
        category TEXT NOT NULL,
        default_public INTEGER NOT NULL,
        PRIMARY KEY (structure_type, category)
      );
    `);
  }

  list(): VisibilityDefaultRow[] {
    const rows = this.#db.prepare('SELECT * FROM visibility_defaults ORDER BY structure_type, category').all() as RawRow[];
    return rows.map(fromRaw);
  }

  isDefaultPublic(structureType: CoreStructureType, category: string): boolean {
    const row = this.#db
      .prepare('SELECT default_public FROM visibility_defaults WHERE structure_type = ? AND category = ?')
      .get(structureType, category) as { default_public: number } | undefined;
    return row?.default_public === 1;
  }

  set(structureType: CoreStructureType, category: string, defaultPublic: boolean): void {
    this.#db
      .prepare(
        `INSERT INTO visibility_defaults (structure_type, category, default_public)
         VALUES (?, ?, ?)
         ON CONFLICT(structure_type, category) DO UPDATE SET default_public = excluded.default_public`,
      )
      .run(structureType, category, defaultPublic ? 1 : 0);
  }

  close(): void {
    this.#db.close();
  }
}
