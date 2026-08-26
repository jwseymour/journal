import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { EntryMetadata, EntrySummary } from '@journal/contract';
import {
  attachmentConflict,
  editConflict,
  entryNotFound,
  invalidRequest,
  journalUnavailable,
  AppError,
} from '../errors.js';
import type { IndexRow, SqliteIndex } from '../index/sqlite-index.js';
import { excerpt } from '../record/excerpt.js';
import { normaliseBody, parseEntryFile, serialiseEntryFile } from '../record/frontmatter.js';
import { ENTRIES_DIR, ENTRY_EXTENSION, entryRelativePath } from '../record/filename.js';
import { contentHash } from '../record/hash.js';
import { ulid } from '../record/id.js';
import { nowTimestamp, parseTimestamp } from '../record/time.js';
import { decodeCursor, encodeCursor } from './cursor.js';
import type {
  AddAttachmentInput,
  AddAttachmentResult,
  CreateEntryInput,
  EntryStore,
  ListOptions,
  ListPeriodsResult,
  ListResult,
  StoreStats,
  StoredEntry,
  UpdateEntryInput,
} from './entry-store.js';

/**
 * The S3 implementation of `EntryStore` (`plan.md` M11) — the markdown files
 * are still canonical (`requirements.md` §7.3), they simply live as objects
 * in a bucket instead of a local directory. This is the second implementation
 * of the seam `entry-store.ts` names — everything above it is unchanged.
 *
 * ## No temp-file dance
 *
 * `FsEntryStore` writes through a temp-file-then-rename because a partial
 * `write()` can leave a torn file on a POSIX filesystem. S3 has no such
 * failure mode: a `PutObject` either lands the whole object or does not land
 * at all, and reads are strongly consistent — so every write here is a plain
 * `PutObject`, with none of `atomic-write.ts`'s machinery. Cross-object
 * atomicity (an entry and its attachments landing together) is not added
 * either, because `FsEntryStore` never had that guarantee — `create`,
 * `update` and `addAttachment` are independently atomic there too, never
 * atomic with each other.
 *
 * ## Content hash, never ETag
 *
 * `get`/`update` recompute `contentHash()` from the downloaded object body,
 * exactly as `FsEntryStore` does from the file it just read — never from
 * S3's ETag, which is only a true MD5 for a non-multipart, non-SSE-KMS
 * upload and is a different algorithm than the hash shape already threaded
 * through `packages/contract` end to end.
 *
 * ## The index, reused unchanged
 *
 * `SqliteIndex` is identity-agnostic about what `absPath` actually names —
 * it only ever compares it for equality. Here it holds the S3 object key
 * (identical to `relPath`, since a key has no separate "absolute" form the
 * way a filesystem path does).
 */

const MAX_ID_ATTEMPTS = 8;

function summarise(row: IndexRow): EntrySummary {
  return {
    id: row.id,
    created: row.created,
    ...(row.location ? { location: row.location } : {}),
    excerpt: row.excerpt,
  };
}

/** True for S3's "no such key"/"no such object" errors, however the SDK
 * happens to name them for the operation that raised it. */
function isNotFound(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  if (name === 'NoSuchKey' || name === 'NotFound') return true;
  const status = (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode;
  return status === 404;
}

async function bodyToString(body: unknown): Promise<string> {
  // The Node SdkStreamMixin `aws-sdk-client-s3` attaches to every `Body` —
  // present on a real `S3Client` response and on the in-memory test fake
  // alike, so nothing here needs to know which one it is talking to.
  return (body as { transformToString(): Promise<string> }).transformToString();
}

export class S3EntryStore implements EntryStore {
  readonly #s3: S3Client;
  readonly #bucket: string;
  readonly #index: SqliteIndex;
  #inFlight: Promise<void> | null = null;

  constructor(s3: S3Client, bucket: string, index: SqliteIndex) {
    this.#s3 = s3;
    this.#bucket = bucket;
    this.#index = index;
  }

  async create(input: CreateEntryInput): Promise<StoredEntry> {
    const created =
      input.created === undefined ? nowTimestamp() : parseTimestamp(input.created);
    if (!created) {
      throw invalidRequest(
        `'created' must be an RFC 3339 timestamp carrying a UTC offset, such as 2026-07-26T22:55:13+01:00.`,
      );
    }

    const body = normaliseBody(input.body);
    if (body.trim().length === 0) {
      throw invalidRequest('An entry with no writing in it is not created.');
    }

    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
      const id = ulid(created.epochMs);
      const key = entryRelativePath(id, created);

      // 80 bits of randomness makes this all but impossible, but "never
      // reused" is a promise about identity and is cheap to keep literally.
      if (await this.#exists(key)) continue;

      const metadata: EntryMetadata = {
        id,
        created: created.canonical,
        ...(input.location ? { location: input.location } : {}),
      };

      const fileText = serialiseEntryFile(metadata, body);
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
        throw journalUnavailable(`Could not write the entry to ${key}.`, cause);
      }

      const hash = contentHash(fileText);
      this.#index.upsert({
        id,
        absPath: key,
        relPath: key,
        epochMs: created.epochMs,
        created: metadata.created,
        ...(metadata.location ? { location: metadata.location } : {}),
        excerpt: excerpt(body),
        contentHash: hash,
      });

      return { ...metadata, body, path: key, contentHash: hash };
    }

    /* c8 ignore next */
    throw journalUnavailable('Could not find an unused entry id. This should be impossible.');
  }

  async get(id: string): Promise<StoredEntry | null> {
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

    const parsed = parseEntryFile(text, cached.relPath);
    if (parsed.metadata.id !== id) {
      this.#index.remove(cached.absPath);
      return null;
    }

    // Opportunistic self-healing, exactly as `FsEntryStore` — a hand-edit
    // (or a write from another host sharing this bucket) that a scan has not
    // yet noticed is caught by the read this method already had to do.
    const hash = contentHash(text);
    if (hash !== cached.contentHash) {
      this.#index.upsert({ ...cached, excerpt: excerpt(parsed.body), contentHash: hash });
    }

    return { ...parsed.metadata, body: parsed.body, path: cached.relPath, contentHash: hash };
  }

  async update(id: string, input: UpdateEntryInput): Promise<StoredEntry> {
    await this.#refresh();
    const cached = this.#index.getById(id);
    if (!cached) throw entryNotFound(id);

    let text: string;
    try {
      const maybe = await this.#getObjectText(cached.absPath);
      if (maybe === NOT_FOUND) {
        this.#index.remove(cached.absPath);
        throw entryNotFound(id);
      }
      text = maybe;
    } catch (cause) {
      if (cause instanceof AppError) throw cause;
      throw journalUnavailable(`Could not read ${cached.relPath}.`, cause);
    }

    const parsed = parseEntryFile(text, cached.relPath);
    if (parsed.metadata.id !== id) {
      this.#index.remove(cached.absPath);
      throw entryNotFound(id);
    }

    if (contentHash(text) !== input.contentHash) throw editConflict();

    const fileText = serialiseEntryFile(parsed.metadata, input.body);
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
    this.#index.upsert({ ...cached, excerpt: excerpt(newBody), contentHash: newHash });

    return { ...parsed.metadata, body: newBody, path: cached.relPath, contentHash: newHash };
  }

  async discardIfBlank(id: string): Promise<void> {
    await this.#refresh();
    const cached = this.#index.getById(id);
    if (!cached) return;

    let text: string;
    try {
      const maybe = await this.#getObjectText(cached.absPath);
      if (maybe === NOT_FOUND) {
        this.#index.remove(cached.absPath);
        return;
      }
      text = maybe;
    } catch (cause) {
      throw journalUnavailable(`Could not read ${cached.relPath}.`, cause);
    }

    const parsed = parseEntryFile(text, cached.relPath);
    if (parsed.metadata.id !== id) {
      this.#index.remove(cached.absPath);
      return;
    }

    if (parsed.body.trim().length > 0) {
      throw invalidRequest(
        'This entry has writing in it and will not be discarded. Only a whitespace-only entry may be removed.',
      );
    }

    try {
      await this.#s3.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: cached.absPath }));
    } catch (cause) {
      throw journalUnavailable(`Could not remove ${cached.relPath}.`, cause);
    }

    this.#index.remove(cached.absPath);
  }

  async addAttachment(id: string, input: AddAttachmentInput): Promise<AddAttachmentResult> {
    await this.#refresh();
    const cached = this.#index.getById(id);
    if (!cached) throw entryNotFound(id);

    if (!isValidAttachmentFilename(input.filename)) {
      throw invalidRequest(`'${input.filename}' is not a usable attachment filename.`);
    }

    const stem = cached.absPath.slice(0, -ENTRY_EXTENSION.length);
    const key = `${stem}/${input.filename}`;

    if (await this.#exists(key)) {
      throw attachmentConflict(input.filename);
    }

    try {
      await this.#s3.send(
        new PutObjectCommand({
          Bucket: this.#bucket,
          Key: key,
          Body: input.data,
          ContentType: 'application/octet-stream',
        }),
      );
    } catch (cause) {
      throw journalUnavailable(`Could not write the attachment to ${key}.`, cause);
    }

    const relativeStem = stem.split('/').pop()!;
    return { relativeLink: `${relativeStem}/${input.filename}` };
  }

  async list(options: ListOptions): Promise<ListResult> {
    await this.#refresh();
    const cursor = options.cursor === undefined ? null : decodeCursor(options.cursor);
    const period =
      options.year !== undefined && options.month !== undefined
        ? { year: options.year, month: options.month }
        : undefined;
    const { rows, hasMore } = this.#index.list(cursor, options.limit, period);
    const last = rows.at(-1);

    return {
      entries: rows.map(summarise),
      nextCursor: hasMore && last ? encodeCursor({ epochMs: last.epochMs, id: last.id }) : null,
    };
  }

  async listPeriods(): Promise<ListPeriodsResult> {
    await this.#refresh();
    return { periods: this.#index.listPeriods() };
  }

  async stats(): Promise<StoreStats> {
    await this.#refresh();
    return this.#index.stats();
  }

  /** `rebuild --from-scratch` (`plan.md` M5/M11, `requirements.md` §6.4) —
   * the S3-backed twin of `FsEntryStore.rebuild()`, called the same way by
   * `rebuild.ts` and never by boot itself. */
  async rebuild(): Promise<{ entryCount: number; unreadableCount: number }> {
    this.#index.clear();
    await this.#scan();
    return this.#index.stats();
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

  /** Every `.md` key under `journal/`, paginated. */
  async #listEntryKeys(): Promise<Set<string>> {
    const found = new Set<string>();
    let token: string | undefined;
    do {
      const response = await this.#s3.send(
        new ListObjectsV2Command({
          Bucket: this.#bucket,
          Prefix: `${ENTRIES_DIR}/`,
          ContinuationToken: token,
        }),
      );
      for (const object of response.Contents ?? []) {
        if (object.Key && object.Key.endsWith(ENTRY_EXTENSION)) found.add(object.Key);
      }
      token = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (token);
    return found;
  }

  async #scan(): Promise<void> {
    let found: Set<string>;
    try {
      found = await this.#listEntryKeys();
    } catch (cause) {
      throw journalUnavailable(`Could not list objects in bucket '${this.#bucket}'.`, cause);
    }
    const known = this.#index.knownPaths();

    for (const key of known) {
      if (!found.has(key)) this.#index.remove(key);
    }

    for (const key of found) {
      // Trusted without a re-read once known, same as `FsEntryStore` — an
      // already-indexed key is only re-verified when something else already
      // has to fetch it anyway (`get`'s self-healing, above).
      if (known.has(key)) continue;

      const maybe = await this.#getObjectText(key);
      if (maybe === NOT_FOUND) continue; // Vanished between listing and fetching.
      const text = maybe;

      let parsed;
      try {
        parsed = parseEntryFile(text, key);
      } catch (cause) {
        if (cause instanceof AppError && cause.code === 'malformed_entry') {
          this.#index.markUnreadable(key);
          console.warn(`[journal] skipping unreadable entry — ${cause.message}`);
          continue;
        }
        throw cause;
      }

      // Two objects claiming the same id — resolved by keeping the
      // lexically-first key, exactly as `FsEntryStore` (stable across
      // restarts, regardless of listing order).
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
        epochMs: parsed.created.epochMs,
        created: parsed.metadata.created,
        ...(parsed.metadata.location ? { location: parsed.metadata.location } : {}),
        excerpt: excerpt(parsed.body),
        contentHash: contentHash(text),
      });
    }
  }
}

const NOT_FOUND: unique symbol = Symbol('not-found');

function isValidAttachmentFilename(filename: string): boolean {
  if (filename.length === 0 || filename.length > 255) return false;
  if (filename === '.' || filename === '..') return false;
  if (filename.includes('/') || filename.includes('\\')) return false;
  if (filename.startsWith('.')) return false;
  return true;
}
