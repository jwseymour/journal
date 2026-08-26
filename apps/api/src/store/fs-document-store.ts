import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { DocumentMetadata, DocumentSummary } from '@journal/contract';
import { AppError, editConflict, invalidRequest, journalUnavailable, recordNotFound } from '../errors.js';
import type { DocumentIndexRow, DocumentsIndex } from '../index/documents-index.js';
import { excerpt } from '../record/excerpt.js';
import { DOCUMENTS_DIR, DOCUMENT_EXTENSION, documentRelativePath } from '../record/document-filename.js';
import { parseDocumentFile, serialiseDocumentFile } from '../record/document-frontmatter.js';
import { normaliseBody } from '../record/frontmatter.js';
import { contentHash } from '../record/hash.js';
import { ulid } from '../record/id.js';
import { nowTimestamp } from '../record/time.js';
import { writeFileAtomic } from './atomic-write.js';
import type {
  CreateDocumentInput,
  DocumentStore,
  DocumentStoreStats,
  ListDocumentsOptions,
  ListDocumentsResult,
  StoredDocument,
  UpdateDocumentInput,
} from './document-store.js';
import { decodeCursor, encodeCursor } from './cursor.js';

/**
 * The filesystem implementation of `DocumentStore`, mirroring
 * `FsEntryStore` (`requirements.md` §9): the index is a cache, never a
 * source of truth for content — `get`/`update` always read fresh from disk
 * — and a file that cannot be parsed is skipped and counted, never allowed
 * to fail the whole listing.
 */

const MAX_ID_ATTEMPTS = 8;
const CURSOR_VERSION = 'd1';

const toPosix = (path: string): string => (sep === '/' ? path : path.split(sep).join('/'));

function summarise(row: DocumentIndexRow): DocumentSummary {
  return { id: row.id, title: row.title, created: row.created, updated: row.updated, excerpt: row.excerpt };
}

export class FsDocumentStore implements DocumentStore {
  readonly #journalRoot: string;
  readonly #documentsRoot: string;
  readonly #index: DocumentsIndex;
  #inFlight: Promise<void> | null = null;

  constructor(journalRoot: string, index: DocumentsIndex) {
    this.#journalRoot = journalRoot;
    this.#documentsRoot = join(journalRoot, DOCUMENTS_DIR);
    this.#index = index;
  }

  async create(input: CreateDocumentInput): Promise<StoredDocument> {
    const title = input.title.trim();
    if (title.length === 0) {
      throw invalidRequest('A document must have a title.');
    }

    const now = nowTimestamp();
    const body = normaliseBody(input.body);

    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
      const id = ulid(now.epochMs);
      const relPath = documentRelativePath(id);
      const absPath = join(this.#journalRoot, relPath);

      // 80 bits of randomness makes this all but impossible, but "never
      // reused" is a promise about identity and is cheap to keep literally.
      if (await exists(absPath)) continue;

      const metadata: DocumentMetadata = {
        id,
        title,
        created: now.canonical,
        updated: now.canonical,
        ...(input.citedEntries && input.citedEntries.length > 0 ? { citedEntries: input.citedEntries } : {}),
      };

      const fileText = serialiseDocumentFile(metadata, body);
      try {
        await writeFileAtomic(absPath, fileText, this.#journalRoot);
      } catch (cause) {
        throw journalUnavailable(`Could not write the document to ${relPath}.`, cause);
      }

      const hash = contentHash(fileText);
      this.#index.upsert({
        id,
        absPath,
        relPath,
        title,
        createdEpochMs: now.epochMs,
        created: metadata.created,
        updatedEpochMs: now.epochMs,
        updated: metadata.updated,
        excerpt: excerpt(body),
        contentHash: hash,
      });

      return { ...metadata, body, path: relPath, contentHash: hash };
    }

    /* c8 ignore next */
    throw journalUnavailable('Could not find an unused document id. This should be impossible.');
  }

  async get(id: string): Promise<StoredDocument | null> {
    await this.#refresh();
    const cached = this.#index.getById(id);
    if (!cached) return null;

    let text: string;
    try {
      text = await readFile(cached.absPath, 'utf8');
    } catch (cause) {
      if (isNotFound(cause)) {
        this.#index.remove(cached.absPath);
        return null;
      }
      throw journalUnavailable(`Could not read ${cached.relPath}.`, cause);
    }

    const parsed = parseDocumentFile(text, cached.relPath);
    if (parsed.metadata.id !== id) {
      this.#index.remove(cached.absPath);
      return null;
    }

    const hash = contentHash(text);
    if (hash !== cached.contentHash) {
      this.#index.upsert({
        ...cached,
        title: parsed.metadata.title,
        updatedEpochMs: parsed.updated.epochMs,
        updated: parsed.metadata.updated,
        excerpt: excerpt(parsed.body),
        contentHash: hash,
      });
    }

    return { ...parsed.metadata, body: parsed.body, path: cached.relPath, contentHash: hash };
  }

  async update(id: string, input: UpdateDocumentInput): Promise<StoredDocument> {
    await this.#refresh();
    const cached = this.#index.getById(id);
    if (!cached) throw recordNotFound('document', id);

    let text: string;
    try {
      text = await readFile(cached.absPath, 'utf8');
    } catch (cause) {
      if (isNotFound(cause)) {
        this.#index.remove(cached.absPath);
        throw recordNotFound('document', id);
      }
      throw journalUnavailable(`Could not read ${cached.relPath}.`, cause);
    }

    const parsed = parseDocumentFile(text, cached.relPath);
    if (parsed.metadata.id !== id) {
      this.#index.remove(cached.absPath);
      throw recordNotFound('document', id);
    }

    if (contentHash(text) !== input.contentHash) throw editConflict('document');

    const title = input.title.trim();
    if (title.length === 0) {
      throw invalidRequest('A document must have a title.');
    }

    // id and created never move. updated always advances to now — that is
    // the entire point of a document being revised (`requirements.md` §9.1).
    const now = nowTimestamp();
    const metadata: DocumentMetadata = {
      id: parsed.metadata.id,
      title,
      created: parsed.metadata.created,
      updated: now.canonical,
      ...(input.citedEntries && input.citedEntries.length > 0 ? { citedEntries: input.citedEntries } : {}),
    };

    const fileText = serialiseDocumentFile(metadata, input.body);
    try {
      await writeFileAtomic(cached.absPath, fileText, this.#journalRoot);
    } catch (cause) {
      throw journalUnavailable(`Could not write ${cached.relPath}.`, cause);
    }

    const newBody = normaliseBody(input.body);
    const newHash = contentHash(fileText);
    this.#index.upsert({
      ...cached,
      title,
      updatedEpochMs: now.epochMs,
      updated: metadata.updated,
      excerpt: excerpt(newBody),
      contentHash: newHash,
    });

    return { ...metadata, body: newBody, path: cached.relPath, contentHash: newHash };
  }

  async list(options: ListDocumentsOptions): Promise<ListDocumentsResult> {
    await this.#refresh();
    const cursor = options.cursor === undefined ? null : decodeCursor(options.cursor, CURSOR_VERSION);
    const { rows, hasMore } = this.#index.list(cursor, options.limit);
    const last = rows.at(-1);

    return {
      documents: rows.map(summarise),
      nextCursor:
        hasMore && last ? encodeCursor({ epochMs: last.updatedEpochMs, id: last.id }, CURSOR_VERSION) : null,
    };
  }

  async stats(): Promise<DocumentStoreStats> {
    await this.#refresh();
    const { documentCount, unreadableCount } = this.#index.stats();
    return { documentCount, unreadableCount };
  }

  /** `rebuild --from-scratch`, the document-store twin of `FsEntryStore.rebuild()`. */
  async rebuild(): Promise<DocumentStoreStats> {
    this.#index.clear();
    await this.#scan();
    const { documentCount, unreadableCount } = this.#index.stats();
    return { documentCount, unreadableCount };
  }

  #refresh(): Promise<void> {
    this.#inFlight ??= this.#scan().finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  async #scan(): Promise<void> {
    const found = await this.#walk(this.#documentsRoot);
    const known = this.#index.knownPaths();

    for (const absPath of known) {
      if (!found.has(absPath)) this.#index.remove(absPath);
    }

    for (const absPath of found) {
      if (known.has(absPath)) continue;

      const relPath = toPosix(relative(this.#journalRoot, absPath));
      let text: string;
      try {
        text = await readFile(absPath, 'utf8');
      } catch (cause) {
        if (isNotFound(cause)) continue;
        throw journalUnavailable(`Could not read ${relPath}.`, cause);
      }

      let parsed;
      try {
        parsed = parseDocumentFile(text, relPath);
      } catch (cause) {
        if (cause instanceof AppError && cause.code === 'malformed_entry') {
          this.#index.markUnreadable(absPath);
          console.warn(`[journal] skipping unreadable document — ${cause.message}`);
          continue;
        }
        throw cause;
      }

      const existing = this.#index.getById(parsed.metadata.id);
      if (existing && existing.absPath !== absPath) {
        const [winner, loser] =
          relPath < existing.relPath ? [absPath, existing.absPath] : [existing.absPath, absPath];
        if (winner === absPath) {
          this.#index.markUnreadable(loser);
          console.warn(
            `[journal] ${existing.relPath} repeats the id also claimed by ${relPath}; ignoring it (kept the lexically-first path).`,
          );
        } else {
          this.#index.markUnreadable(absPath);
          console.warn(
            `[journal] ${relPath} repeats the id already held by ${existing.relPath}; ignoring it.`,
          );
          continue;
        }
      }

      this.#index.upsert({
        id: parsed.metadata.id,
        absPath,
        relPath,
        title: parsed.metadata.title,
        createdEpochMs: parsed.created.epochMs,
        created: parsed.metadata.created,
        updatedEpochMs: parsed.updated.epochMs,
        updated: parsed.metadata.updated,
        excerpt: excerpt(parsed.body),
        contentHash: contentHash(text),
      });
    }
  }

  /** Every `.md` file directly under `documents/` — no nesting, unlike entries' `YYYY/MM`. */
  async #walk(dir: string): Promise<Set<string>> {
    const found = new Set<string>();
    let items;
    try {
      items = await readdir(dir, { withFileTypes: true });
    } catch (cause) {
      if (isNotFound(cause)) return found;
      throw journalUnavailable(`Could not read ${dir}.`, cause);
    }

    for (const item of items) {
      if (item.name.startsWith('.')) continue;
      if (item.isFile() && item.name.endsWith(DOCUMENT_EXTENSION)) {
        found.add(join(dir, item.name));
      }
    }
    return found;
  }
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}
