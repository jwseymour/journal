import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * What is currently public, and where its snapshot lives (`requirements.md`
 * §9.3, §11, `plan.md` M15).
 *
 * Unlike every other index in this directory, this table is not a cache of
 * something else — it is the one durable record of a publishing decision.
 * Nothing about an entry or a document itself says whether it is public;
 * `Publisher` is the only writer, and this table is the only place that
 * fact is stored. That makes it authored data, not disposable, the same
 * status a touched derived record has (`requirements.md` §6.4) — it needs
 * the same backup treatment `plan.md` M11 already earmarked for durable
 * index rows, not just `rm index.db && rebuild`.
 */

/**
 * `entry`/`document` are M15's original two; `metric`/`review`/`list_item`/
 * `opinion_statement`/`question` are the five derived-structure types M16
 * adds (`requirements.md` §11) — the same five M10 gave a `touched` column
 * to. Note these names are the *publishing* vocabulary, not
 * `CategoriesIndex`'s category-type vocabulary (`review_medium`, `list_type`,
 * `opinion_subject`) — `VisibilityDefaultsIndex`/`/publish-queue` are what
 * translates between the two.
 */
export type PublishableSourceType =
  | 'entry'
  | 'document'
  | 'metric'
  | 'review'
  | 'list_item'
  | 'opinion_statement'
  | 'question';

export interface PublishedRow {
  sourceType: PublishableSourceType;
  sourceId: string;
  /** Where the rendered snapshot lives — `public/<sourceType>s/<sourceId>.json`. */
  mirrorKey: string;
  /** The source's own `created`, kept here so a listing can be ordered
   * without opening every snapshot object just to sort them. */
  sourceCreatedAt: string;
  publishedAt: string;
  /** The source's `contentHash` as of the last successful publish/resync —
   * compared against the current hash to decide whether a resync has
   * anything to do. */
  sourceHashAtPublish: string;
}

interface RawRow {
  source_type: string;
  source_id: string;
  mirror_key: string;
  source_created_at: string;
  published_at: string;
  source_hash_at_publish: string;
}

function fromRaw(row: RawRow): PublishedRow {
  return {
    sourceType: row.source_type as PublishableSourceType,
    sourceId: row.source_id,
    mirrorKey: row.mirror_key,
    sourceCreatedAt: row.source_created_at,
    publishedAt: row.published_at,
    sourceHashAtPublish: row.source_hash_at_publish,
  };
}

export class PublishedIndex {
  readonly #db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.#db = new Database(dbPath);
    this.#db.pragma('journal_mode = WAL');
    this.#migrate();
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS published (
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        mirror_key TEXT NOT NULL,
        source_created_at TEXT NOT NULL,
        published_at TEXT NOT NULL,
        source_hash_at_publish TEXT NOT NULL,
        PRIMARY KEY (source_type, source_id)
      );
      CREATE INDEX IF NOT EXISTS published_order ON published (source_type, source_created_at DESC, source_id DESC);
    `);
  }

  get(sourceType: PublishableSourceType, sourceId: string): PublishedRow | null {
    const row = this.#db
      .prepare('SELECT * FROM published WHERE source_type = ? AND source_id = ?')
      .get(sourceType, sourceId) as RawRow | undefined;
    return row ? fromRaw(row) : null;
  }

  isPublished(sourceType: PublishableSourceType, sourceId: string): boolean {
    return this.get(sourceType, sourceId) !== null;
  }

  upsert(row: PublishedRow): void {
    this.#db
      .prepare(
        `INSERT INTO published (source_type, source_id, mirror_key, source_created_at, published_at, source_hash_at_publish)
         VALUES (@sourceType, @sourceId, @mirrorKey, @sourceCreatedAt, @publishedAt, @sourceHashAtPublish)
         ON CONFLICT(source_type, source_id) DO UPDATE SET
           mirror_key = excluded.mirror_key,
           source_created_at = excluded.source_created_at,
           published_at = excluded.published_at,
           source_hash_at_publish = excluded.source_hash_at_publish`,
      )
      .run(row);
  }

  remove(sourceType: PublishableSourceType, sourceId: string): void {
    this.#db.prepare('DELETE FROM published WHERE source_type = ? AND source_id = ?').run(sourceType, sourceId);
  }

  /** Every published row of one type, newest source `created` first — the
   * ordering the public list surfaces (`requirements.md` §10). */
  listByType(sourceType: PublishableSourceType): PublishedRow[] {
    return (
      this.#db
        .prepare(
          `SELECT * FROM published WHERE source_type = ? ORDER BY source_created_at DESC, source_id DESC`,
        )
        .all(sourceType) as RawRow[]
    ).map(fromRaw);
  }

  close(): void {
    this.#db.close();
  }
}
