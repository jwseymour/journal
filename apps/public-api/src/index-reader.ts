import Database from 'better-sqlite3';

/**
 * Read-only access to the `documents` table `apps/api/src/index/documents-index.ts`
 * owns, creates, and migrates (`plan.md` M14). This service never creates,
 * migrates, or writes to that database — it is opened `readonly`, and
 * `fileMustExist` so a missing index fails loudly at boot rather than this
 * service silently creating (and thereby owning) an empty one.
 */

export interface PublicDocumentRow {
  id: string;
  title: string;
  created: string;
  excerpt: string;
  /** Journal-root-relative (fs) or S3 object key — same dual role
   * `DocumentIndexRow.relPath` has on the private side. */
  relPath: string;
}

/** A generous ceiling, not a tuned one — a personal blog is not expected to
 * ever approach this. Capped rather than paginated, deliberately: M14 is
 * scoped to "minimal," and pagination can be added if it's ever needed. */
const MAX_DOCUMENTS = 200;

const SUFFIX_LENGTH = 6;

interface RawRow {
  id: string;
  title: string;
  created: string;
  excerpt: string;
  relPath: string;
}

export class PublicDocumentsReader {
  readonly #db: Database.Database;

  constructor(dbPath: string) {
    this.#db = new Database(dbPath, { readonly: true, fileMustExist: true });
  }

  /** Every public document, newest-*created*-first — a blog reads
   * chronologically, unlike the private list's newest-updated-first
   * (`requirements.md` §10). */
  list(): PublicDocumentRow[] {
    return this.#db
      .prepare(
        `SELECT id, title, created, excerpt, rel_path AS relPath FROM documents
         WHERE public = 1
         ORDER BY created_epoch_ms DESC, id DESC
         LIMIT ?`,
      )
      .all(MAX_DOCUMENTS) as RawRow[];
  }

  /**
   * A public document whose id ends with `suffix` — the same "resolve by
   * the id fragment embedded in a human-friendly slug" approach
   * `format.md` §2 uses for entry filenames. `null` for a malformed
   * suffix, no match, or a match that is not (or no longer) public — a
   * caller cannot tell those apart, which is deliberate (`requirements.md`
   * §10): nothing about a private document's existence leaks here. Always
   * an exact, parameterised comparison, never a `LIKE` pattern built from
   * caller input.
   */
  findBySuffix(suffix: string): PublicDocumentRow | null {
    if (!/^[0-9a-z]{6}$/i.test(suffix)) return null;
    const row = this.#db
      .prepare(
        `SELECT id, title, created, excerpt, rel_path AS relPath FROM documents
         WHERE public = 1 AND lower(substr(id, -${SUFFIX_LENGTH})) = lower(?)
         LIMIT 1`,
      )
      .get(suffix) as RawRow | undefined;
    return row ?? null;
  }

  close(): void {
    this.#db.close();
  }
}
