import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
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
import { decodeCursor, encodeCursor } from './cursor.js';
import type {
  CreateDocumentInput,
  DocumentStore,
  DocumentStoreStats,
  ListDocumentsOptions,
  ListDocumentsResult,
  StoredDocument,
  UpdateDocumentInput,
} from './document-store.js';

/**
 * The S3 implementation of `DocumentStore`, mirroring `S3EntryStore`
 * (`plan.md` M11/M12): no temp-file dance (`PutObject` is already atomic),
 * content hash always recomputed from the downloaded body, never from
 * S3's ETag, and the index reused unchanged for the object key.
 */

const MAX_ID_ATTEMPTS = 8;
const CURSOR_VERSION = 'd1';

function summarise(row: DocumentIndexRow): Omit<DocumentSummary, 'published'> {
  return {
    id: row.id,
    title: row.title,
    created: row.created,
    updated: row.updated,
    excerpt: row.excerpt,
  };
}

function isNotFound(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  if (name === 'NoSuchKey' || name === 'NotFound') return true;
  const status = (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode;
  return status === 404;
}

async function bodyToString(body: unknown): Promise<string> {
  return (body as { transformToString(): Promise<string> }).transformToString();
}

const NOT_FOUND: unique symbol = Symbol('not-found');

export class S3DocumentStore implements DocumentStore {
  readonly #s3: S3Client;
  readonly #bucket: string;
  readonly #index: DocumentsIndex;
  #inFlight: Promise<void> | null = null;

  constructor(s3: S3Client, bucket: string, index: DocumentsIndex) {
    this.#s3 = s3;
    this.#bucket = bucket;
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
      const key = documentRelativePath(id);

      if (await this.#exists(key)) continue;

      const metadata: DocumentMetadata = {
        id,
        title,
        created: now.canonical,
        updated: now.canonical,
        ...(input.citedEntries && input.citedEntries.length > 0 ? { citedEntries: input.citedEntries } : {}),
      };

      const fileText = serialiseDocumentFile(metadata, body);
      try {
        await this.#s3.send(
          new PutObjectCommand({
            Bucket: this.#bucket,
            Key: key,
            Body: fileText,
            ContentType: 'text/markdown; charset=utf-8',
          }),
        );
      } catch (cause) {
        throw journalUnavailable(`Could not write the document to ${key}.`, cause);
      }

      const hash = contentHash(fileText);
      this.#index.upsert({
        id,
        absPath: key,
        relPath: key,
        title,
        createdEpochMs: now.epochMs,
        created: metadata.created,
        updatedEpochMs: now.epochMs,
        updated: metadata.updated,
        excerpt: excerpt(body),
        contentHash: hash,
      });

      return { ...metadata, body, path: key, contentHash: hash };
    }

    /* c8 ignore next */
    throw journalUnavailable('Could not find an unused document id. This should be impossible.');
  }

  async get(id: string): Promise<StoredDocument | null> {
    await this.#refresh();
    const cached = this.#index.getById(id);
    if (!cached) return null;

    let maybe: string | typeof NOT_FOUND;
    try {
      maybe = await this.#getObjectText(cached.absPath);
    } catch (cause) {
      throw journalUnavailable(`Could not read ${cached.relPath}.`, cause);
    }
    if (maybe === NOT_FOUND) {
      this.#index.remove(cached.absPath);
      return null;
    }
    const text = maybe;

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
      const maybe = await this.#getObjectText(cached.absPath);
      if (maybe === NOT_FOUND) {
        this.#index.remove(cached.absPath);
        throw recordNotFound('document', id);
      }
      text = maybe;
    } catch (cause) {
      if (cause instanceof AppError) throw cause;
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

    // id and created never move on an ordinary edit; visibility is not a
    // field here at all any more — it lives entirely in `PublishedIndex`
    // (`requirements.md` §9.3, `plan.md` M15).
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
      await this.#s3.send(
        new PutObjectCommand({
          Bucket: this.#bucket,
          Key: cached.absPath,
          Body: fileText,
          ContentType: 'text/markdown; charset=utf-8',
        }),
      );
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

  async #exists(key: string): Promise<boolean> {
    try {
      await this.#s3.send(new HeadObjectCommand({ Bucket: this.#bucket, Key: key }));
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async #getObjectText(key: string): Promise<string | typeof NOT_FOUND> {
    try {
      const response = await this.#s3.send(new GetObjectCommand({ Bucket: this.#bucket, Key: key }));
      return await bodyToString(response.Body);
    } catch (error) {
      if (isNotFound(error)) return NOT_FOUND;
      throw error;
    }
  }

  /** Every `.md` key directly under `documents/`, paginated. */
  async #listDocumentKeys(): Promise<Set<string>> {
    const found = new Set<string>();
    let token: string | undefined;
    do {
      const response = await this.#s3.send(
        new ListObjectsV2Command({
          Bucket: this.#bucket,
          Prefix: `${DOCUMENTS_DIR}/`,
          ContinuationToken: token,
        }),
      );
      for (const object of response.Contents ?? []) {
        if (object.Key && object.Key.endsWith(DOCUMENT_EXTENSION)) found.add(object.Key);
      }
      token = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (token);
    return found;
  }

  async #scan(): Promise<void> {
    let found: Set<string>;
    try {
      found = await this.#listDocumentKeys();
    } catch (cause) {
      throw journalUnavailable(`Could not list objects in bucket '${this.#bucket}'.`, cause);
    }
    const known = this.#index.knownPaths();

    for (const key of known) {
      if (!found.has(key)) this.#index.remove(key);
    }

    for (const key of found) {
      if (known.has(key)) continue;

      const maybe = await this.#getObjectText(key);
      if (maybe === NOT_FOUND) continue;
      const text = maybe;

      let parsed;
      try {
        parsed = parseDocumentFile(text, key);
      } catch (cause) {
        if (cause instanceof AppError && cause.code === 'malformed_entry') {
          this.#index.markUnreadable(key);
          console.warn(`[journal] skipping unreadable document — ${cause.message}`);
          continue;
        }
        throw cause;
      }

      const existing = this.#index.getById(parsed.metadata.id);
      if (existing && existing.absPath !== key) {
        const [winner, loser] =
          key < existing.relPath ? [key, existing.absPath] : [existing.absPath, key];
        if (winner === key) {
          this.#index.markUnreadable(loser);
          console.warn(
            `[journal] ${existing.relPath} repeats the id also claimed by ${key}; ignoring it (kept the lexically-first key).`,
          );
        } else {
          this.#index.markUnreadable(key);
          console.warn(`[journal] ${key} repeats the id already held by ${existing.relPath}; ignoring it.`);
          continue;
        }
      }

      this.#index.upsert({
        id: parsed.metadata.id,
        absPath: key,
        relPath: key,
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
}
