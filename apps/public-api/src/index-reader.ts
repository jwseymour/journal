import Database from 'better-sqlite3';

/**
 * Read-only access to the `published` table `apps/api/src/index/published-index.ts`
 * owns, creates, and migrates (`plan.md` M15). This service never creates,
 * migrates, or writes to that database — it is opened `readonly`, and
 * `fileMustExist` so a missing index fails loudly at boot rather than this
 * service silently creating (and thereby owning) an empty one.
 *
 * This table only ever says *that* something is published and *where* its
 * snapshot lives — never its title, body, or excerpt. Those come from the
 * snapshot itself, fetched separately via `StorageReader`
 * (`requirements.md` §10: the file is always the one true answer, the index
 * only ever narrows down which file).
 */

export type PublicSourceType = 'entry' | 'document';

export interface PublishedRow {
  sourceType: PublicSourceType;
  sourceId: string;
  /** Journal-root-relative (fs) or S3 object key — same dual role
   * `PublicDocumentRow.relPath` had on the M14 shape this replaces. */
  mirrorKey: string;
}

/** A generous ceiling, not a tuned one — a personal blog is not expected to
 * ever approach this. Capped rather than paginated, deliberately: M14 was
 * scoped to "minimal," and pagination can be added if it's ever needed. */
const MAX_ITEMS = 200;

const SUFFIX_LENGTH = 6;

interface RawRow {
  source_type: string;
  source_id: string;
  mirror_key: string;
}

function fromRaw(row: RawRow): PublishedRow {
  return { sourceType: row.source_type as PublicSourceType, sourceId: row.source_id, mirrorKey: row.mirror_key };
}

export class PublishedIndexReader {
  readonly #db: Database.Database;

  constructor(dbPath: string) {
    this.#db = new Database(dbPath, { readonly: true, fileMustExist: true });
  }

  /** Every published row of one type, newest source-`created`-first — a
   * blog reads chronologically (`requirements.md` §10). */
  list(sourceType: PublicSourceType): PublishedRow[] {
    return (
      this.#db
        .prepare(
          `SELECT source_type, source_id, mirror_key FROM published
           WHERE source_type = ?
           ORDER BY source_created_at DESC, source_id DESC
           LIMIT ?`,
        )
        .all(sourceType, MAX_ITEMS) as RawRow[]
    ).map(fromRaw);
  }

  /**
   * A published row of `sourceType` whose id ends with `suffix` — the same
   * "resolve by the id fragment embedded in a human-friendly slug" approach
   * `format.md` §2 uses for entry filenames. `null` for a malformed suffix
   * or no match — a caller cannot tell those apart, which is deliberate
   * (`requirements.md` §10). Always an exact, parameterised comparison,
   * never a `LIKE` pattern built from caller input.
   */
  findBySuffix(sourceType: PublicSourceType, suffix: string): PublishedRow | null {
    if (!/^[0-9a-z]{6}$/i.test(suffix)) return null;
    const row = this.#db
      .prepare(
        `SELECT source_type, source_id, mirror_key FROM published
         WHERE source_type = ? AND lower(substr(source_id, -${SUFFIX_LENGTH})) = lower(?)
         LIMIT 1`,
      )
      .get(sourceType, suffix) as RawRow | undefined;
    return row ? fromRaw(row) : null;
  }

  /** The published row for one exact `(sourceType, sourceId)`, or `null` if
   * it is not currently published (`plan.md` M17) — how a search hit,
   * which already knows the id it matched, resolves to its mirror key
   * without a suffix guess. */
  getBySourceId(sourceType: PublicSourceType, sourceId: string): PublishedRow | null {
    const row = this.#db
      .prepare(`SELECT source_type, source_id, mirror_key FROM published WHERE source_type = ? AND source_id = ?`)
      .get(sourceType, sourceId) as RawRow | undefined;
    return row ? fromRaw(row) : null;
  }

  close(): void {
    this.#db.close();
  }
}
