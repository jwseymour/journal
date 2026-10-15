import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Layout, LayoutSummary, LayoutSurface, RawLayoutSpec } from '@journal/contract';

/**
 * A disposable projection of the durable layout store (`format.md` §8),
 * exactly like `VisibilityDefaultsIndex` and unlike `PublishedIndex`: losing
 * it costs nothing, because `LayoutStore.rebuild()` refills it from
 * `derived/layouts/` the same way `rebuild.ts` refills the touched mirror.
 *
 * `spec_json` caches the *grammar-level* parse of the `.dsl` text — no
 * catalog needed to produce it, so this table can never rot when a metric is
 * removed, and `rebuild()` needs no access to `CategoriesIndex` /
 * `MetricFieldsIndex`. Catalog validation is deferred to render time
 * (`layout/resolve.ts`).
 */

interface RawRow {
  id: string;
  surface: string;
  name: string;
  is_default: number;
  prose: string | null;
  syntax: string;
  spec_json: string;
  created_at: string;
  updated_at: string;
}

function toLayout(row: RawRow): Layout {
  return {
    id: row.id,
    surface: row.surface as LayoutSurface,
    name: row.name,
    prose: row.prose,
    syntax: row.syntax,
    spec: JSON.parse(row.spec_json) as RawLayoutSpec,
    isDefault: row.is_default === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toSummary(row: RawRow): LayoutSummary {
  return {
    id: row.id,
    surface: row.surface as LayoutSurface,
    name: row.name,
    isDefault: row.is_default === 1,
    updatedAt: row.updated_at,
  };
}

/** One stored layout's full projection row, as the store writes it. */
export interface LayoutProjection {
  id: string;
  surface: LayoutSurface;
  name: string;
  isDefault: boolean;
  prose: string | null;
  syntax: string;
  spec: RawLayoutSpec;
  createdAt: string;
  updatedAt: string;
}

/** The read seam `http/app.ts` depends on — same shape as every other
 * `*Reader`, faked in tests. */
export interface LayoutsReader {
  list(surface: LayoutSurface): LayoutSummary[];
  get(id: string): Layout | null;
  getDefault(surface: LayoutSurface): Layout | null;
}

export class LayoutsIndex implements LayoutsReader {
  readonly #db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.#db = new Database(dbPath);
    this.#db.pragma('journal_mode = WAL');
    this.#migrate();
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS layouts (
        id TEXT PRIMARY KEY,
        surface TEXT NOT NULL,
        name TEXT NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0,
        prose TEXT,
        syntax TEXT NOT NULL,
        spec_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS layouts_surface ON layouts (surface, updated_at DESC);
    `);
  }

  list(surface: LayoutSurface): LayoutSummary[] {
    const rows = this.#db
      .prepare('SELECT * FROM layouts WHERE surface = ? ORDER BY updated_at DESC')
      .all(surface) as RawRow[];
    return rows.map(toSummary);
  }

  get(id: string): Layout | null {
    const row = this.#db.prepare('SELECT * FROM layouts WHERE id = ?').get(id) as RawRow | undefined;
    return row ? toLayout(row) : null;
  }

  getDefault(surface: LayoutSurface): Layout | null {
    const row = this.#db
      .prepare('SELECT * FROM layouts WHERE surface = ? AND is_default = 1')
      .get(surface) as RawRow | undefined;
    return row ? toLayout(row) : null;
  }

  /** Every stored layout, all surfaces — the full-fidelity read `LayoutStore`
   * falls back to when the projection is empty for a surface but the durable
   * objects exist (a fresh index that has not been rebuilt yet). */
  all(): Layout[] {
    const rows = this.#db.prepare('SELECT * FROM layouts ORDER BY surface, updated_at DESC').all() as RawRow[];
    return rows.map(toLayout);
  }

  /** Upsert one projection row. The store is the source of truth for the
   * `isDefault` pointer, so this writes exactly what it is handed. */
  put(projection: LayoutProjection): void {
    this.#db
      .prepare(
        `INSERT INTO layouts (id, surface, name, is_default, prose, syntax, spec_json, created_at, updated_at)
         VALUES (@id, @surface, @name, @is_default, @prose, @syntax, @spec_json, @created_at, @updated_at)
         ON CONFLICT(id) DO UPDATE SET
           surface = excluded.surface,
           name = excluded.name,
           is_default = excluded.is_default,
           prose = excluded.prose,
           syntax = excluded.syntax,
           spec_json = excluded.spec_json,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at`,
      )
      .run({
        id: projection.id,
        surface: projection.surface,
        name: projection.name,
        is_default: projection.isDefault ? 1 : 0,
        prose: projection.prose,
        syntax: projection.syntax,
        spec_json: JSON.stringify(projection.spec),
        created_at: projection.createdAt,
        updated_at: projection.updatedAt,
      });
  }

  remove(id: string): void {
    this.#db.prepare('DELETE FROM layouts WHERE id = ?').run(id);
  }

  /** Drop every row for one surface — `rebuild()` clears then refills, so a
   * layout deleted from durable storage while the index was cold does not
   * linger. */
  clearSurface(surface: LayoutSurface): void {
    this.#db.prepare('DELETE FROM layouts WHERE surface = ?').run(surface);
  }

  close(): void {
    this.#db.close();
  }
}
