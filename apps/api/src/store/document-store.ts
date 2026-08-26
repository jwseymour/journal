import type { Document, DocumentSummary } from '@journal/contract';

/**
 * The seam for documents, mirroring `store/entry-store.ts`'s role and rules
 * exactly (`requirements.md` §9): nothing above this interface may know that
 * documents are files. No path, no directory, no extension appears in an
 * argument or a return type — with the same single, informational exception
 * `StoredEntry.path` has.
 *
 * Deliberately smaller than `EntryStore`: no `discardIfBlank` (creation is a
 * deliberate action gated on a non-empty title, not incidental to typing, so
 * there is no abandoned-blank-draft case to clean up), no `addAttachment`,
 * no `listPeriods` (documents aren't chronological), and nothing resembling
 * delete — a document is durable authored content, the same stance
 * `requirements.md` §4.4 takes on entries.
 */

export interface CreateDocumentInput {
  title: string;
  body: string;
  citedEntries?: string[];
}

export interface StoredDocument extends Document {
  /** Journal-root-relative, POSIX separators. Informational only — never a key. */
  path: string;
}

export interface UpdateDocumentInput {
  /** A full replace of every editable field, not a patch — see
   * `UpdateDocumentRequest` in `@journal/contract` for why. */
  title: string;
  body: string;
  citedEntries?: string[];
  /** Must match the document's current `contentHash`, or the write is refused. */
  contentHash: string;
}

export interface ListDocumentsOptions {
  cursor?: string;
  limit: number;
}

export interface ListDocumentsResult {
  documents: DocumentSummary[];
  nextCursor: string | null;
}

export interface DocumentStoreStats {
  documentCount: number;
  /** Files that look like documents but cannot be read as one. See `SqliteIndex`'s entry equivalent. */
  unreadableCount: number;
}

export interface DocumentStore {
  /** Write a new document. `title` must be non-empty — a document without one isn't a document yet. */
  create(input: CreateDocumentInput): Promise<StoredDocument>;

  /** Fetch one document by id, or `null` if there is no such document. */
  get(id: string): Promise<StoredDocument | null>;

  /**
   * Replace a document's editable content. `id` and `created` never move;
   * `updated` is set to now. Throws `record_not_found` if there is no such
   * document, or `edit_conflict` if `input.contentHash` no longer matches
   * what is on disk.
   */
  update(id: string, input: UpdateDocumentInput): Promise<StoredDocument>;

  /** One page of documents, newest-updated-first. */
  list(options: ListDocumentsOptions): Promise<ListDocumentsResult>;

  stats(): Promise<DocumentStoreStats>;
}
