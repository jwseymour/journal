import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { MediaMetadata } from '@journal/contract';
import { invalidRequest, journalUnavailable, unsupportedMediaType } from '../errors.js';
import type { MediaIndex, MediaIndexRow } from '../index/media-index.js';
import {
  MEDIA_DIR,
  contentTypeForExtension,
  isSupportedMediaContentType,
  mediaKindOf,
  mediaRelativePath,
  mediaSidecarPath,
} from '../record/media-filename.js';
import { extractMediaMetadata } from '../record/media-metadata.js';
import { ulid } from '../record/id.js';
import { nowTimestamp, parseTimestamp } from '../record/time.js';
import { decodeCursor, encodeCursor } from './cursor.js';
import type {
  ListMediaOptions,
  ListMediaResult,
  MediaBytes,
  MediaStore,
  MediaStoreStats,
  StoredMedia,
  UploadMediaInput,
} from './media-store.js';

/**
 * The S3 implementation of `MediaStore`, mirroring `S3DocumentStore`
 * (`requirements.md` — photo library, M19): no temp-file dance (`PutObject`
 * is already atomic), and the index reused unchanged for object identity.
 */

const MAX_ID_ATTEMPTS = 8;
const CURSOR_VERSION = 'm1';

interface Sidecar {
  originalFilename: string;
  uploadedAt: string;
}

function isNotFound(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  if (name === 'NoSuchKey' || name === 'NotFound') return true;
  const status = (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode;
  return status === 404;
}

const NOT_FOUND: unique symbol = Symbol('not-found');

function toRow(
  id: string,
  key: string,
  sidecar: Sidecar,
  contentType: string,
  byteSize: number,
  extracted: { width: number | null; height: number | null; capturedAt: string | null },
  uploadedEpochMs: number,
): MediaIndexRow {
  return {
    id,
    absPath: key,
    relPath: key,
    kind: mediaKindOf(contentType),
    contentType,
    byteSize,
    originalFilename: sidecar.originalFilename,
    width: extracted.width,
    height: extracted.height,
    capturedAt: extracted.capturedAt,
    capturedDate: extracted.capturedAt ? extracted.capturedAt.slice(0, 10) : null,
    uploadedAt: sidecar.uploadedAt,
    uploadedEpochMs,
  };
}

function toMetadata(row: MediaIndexRow): MediaMetadata {
  return {
    id: row.id,
    kind: row.kind,
    contentType: row.contentType,
    byteSize: row.byteSize,
    originalFilename: row.originalFilename,
    width: row.width,
    height: row.height,
    capturedAt: row.capturedAt,
    uploadedAt: row.uploadedAt,
  };
}

/** The sidecar's `uploadedAt` re-parsed into an epoch for list ordering —
 * see `fs-media-store.ts`'s identical helper for why `parseTimestamp`,
 * never a bare `Date.parse`. */
function parseCanonicalOrNow(canonical: string): number {
  return parseTimestamp(canonical)?.epochMs ?? nowTimestamp().epochMs;
}

export class S3MediaStore implements MediaStore {
  readonly #s3: S3Client;
  readonly #bucket: string;
  readonly #index: MediaIndex;
  #inFlight: Promise<void> | null = null;

  constructor(s3: S3Client, bucket: string, index: MediaIndex) {
    this.#s3 = s3;
    this.#bucket = bucket;
    this.#index = index;
  }

  async upload(input: UploadMediaInput): Promise<StoredMedia> {
    if (!isSupportedMediaContentType(input.contentType)) {
      throw unsupportedMediaType(input.contentType);
    }
    const originalFilename = input.originalFilename.trim();
    if (originalFilename.length === 0) {
      throw invalidRequest('An uploaded media item must carry a filename.');
    }

    const now = nowTimestamp();

    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
      const id = ulid(now.epochMs);
      const key = mediaRelativePath(id, input.contentType);

      if (await this.#exists(key)) continue;

      const sidecarKey = mediaSidecarPath(id);
      const sidecar: Sidecar = { originalFilename, uploadedAt: now.canonical };

      try {
        await this.#s3.send(
          new PutObjectCommand({ Bucket: this.#bucket, Key: key, Body: input.data, ContentType: input.contentType }),
        );
        await this.#s3.send(
          new PutObjectCommand({
            Bucket: this.#bucket,
            Key: sidecarKey,
            Body: JSON.stringify(sidecar),
            ContentType: 'application/json',
          }),
        );
      } catch (cause) {
        throw journalUnavailable(`Could not write the media item to ${key}.`, cause);
      }

      const extracted = await extractMediaMetadata(input.data, input.contentType);
      const row = toRow(id, key, sidecar, input.contentType, input.data.length, extracted, now.epochMs);
      this.#index.upsert(row);

      return { ...toMetadata(row), path: key };
    }

    /* c8 ignore next */
    throw journalUnavailable('Could not find an unused media id. This should be impossible.');
  }

  async get(id: string): Promise<StoredMedia | null> {
    await this.#refresh();
    const row = this.#index.getById(id);
    return row ? { ...toMetadata(row), path: row.relPath } : null;
  }

  async getBytes(id: string): Promise<MediaBytes | null> {
    await this.#refresh();
    const row = this.#index.getById(id);
    if (!row) return null;

    let bytes: Uint8Array | typeof NOT_FOUND;
    try {
      bytes = await this.#getObjectBytes(row.absPath);
    } catch (cause) {
      throw journalUnavailable(`Could not read ${row.relPath}.`, cause);
    }
    if (bytes === NOT_FOUND) {
      this.#index.remove(row.absPath);
      return null;
    }

    return { data: Buffer.from(bytes), contentType: row.contentType };
  }

  async remove(id: string): Promise<void> {
    await this.#refresh();
    const row = this.#index.getById(id);
    if (!row) return;

    try {
      await this.#s3.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: row.absPath }));
      await this.#s3.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: mediaSidecarPath(id) }));
    } catch (cause) {
      throw journalUnavailable(`Could not remove ${row.relPath}.`, cause);
    }
    this.#index.remove(row.absPath);
  }

  async list(options: ListMediaOptions): Promise<ListMediaResult> {
    await this.#refresh();
    const cursor = options.cursor === undefined ? null : decodeCursor(options.cursor, CURSOR_VERSION);
    const { rows, hasMore } = this.#index.list(cursor, options.limit);
    const last = rows.at(-1);

    return {
      media: rows.map(toMetadata),
      nextCursor:
        hasMore && last ? encodeCursor({ epochMs: last.uploadedEpochMs, id: last.id }, CURSOR_VERSION) : null,
    };
  }

  async listByCapturedDate(date: string): Promise<MediaMetadata[]> {
    await this.#refresh();
    return this.#index.listByCapturedDate(date).map(toMetadata);
  }

  async stats(): Promise<MediaStoreStats> {
    await this.#refresh();
    return this.#index.stats();
  }

  async rebuild(): Promise<MediaStoreStats> {
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

  async #getObjectBytes(key: string): Promise<Uint8Array | typeof NOT_FOUND> {
    try {
      const response = await this.#s3.send(new GetObjectCommand({ Bucket: this.#bucket, Key: key }));
      return await (response.Body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray();
    } catch (error) {
      if (isNotFound(error)) return NOT_FOUND;
      throw error;
    }
  }

  async #getObjectText(key: string): Promise<string | typeof NOT_FOUND> {
    try {
      const response = await this.#s3.send(new GetObjectCommand({ Bucket: this.#bucket, Key: key }));
      return await (response.Body as { transformToString(): Promise<string> }).transformToString();
    } catch (error) {
      if (isNotFound(error)) return NOT_FOUND;
      throw error;
    }
  }

  /** Every key directly under `media/`, paginated — binaries and their
   * `.json` sidecars alike. */
  async #listMediaKeys(): Promise<string[]> {
    const found: string[] = [];
    let token: string | undefined;
    do {
      const response = await this.#s3.send(
        new ListObjectsV2Command({ Bucket: this.#bucket, Prefix: `${MEDIA_DIR}/`, ContinuationToken: token }),
      );
      for (const object of response.Contents ?? []) {
        if (object.Key) found.push(object.Key);
      }
      token = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (token);
    return found;
  }

  async #scan(): Promise<void> {
    let keys: string[];
    try {
      keys = await this.#listMediaKeys();
    } catch (cause) {
      throw journalUnavailable(`Could not list objects in bucket '${this.#bucket}'.`, cause);
    }

    const binaries = new Map<string, { key: string; contentType: string }>();
    for (const key of keys) {
      if (key.endsWith('.json')) continue;
      const dot = key.lastIndexOf('.');
      if (dot === -1) continue;
      const ext = key.slice(dot);
      const id = key.slice(MEDIA_DIR.length + 1, dot);
      const contentType = contentTypeForExtension(ext);
      if (!contentType) continue;
      binaries.set(id, { key, contentType });
    }

    const known = this.#index.knownPaths();
    const foundKeys = new Set([...binaries.values()].map((b) => b.key));
    for (const absPath of known) {
      if (!foundKeys.has(absPath)) this.#index.remove(absPath);
    }

    for (const [id, binary] of binaries) {
      if (known.has(binary.key)) continue;

      const bytes = await this.#getObjectBytes(binary.key);
      if (bytes === NOT_FOUND) continue;
      const data = Buffer.from(bytes);

      const sidecarText = await this.#getObjectText(mediaSidecarPath(id));
      if (sidecarText === NOT_FOUND) {
        this.#index.markUnreadable(binary.key);
        console.warn(`[journal] skipping ${binary.key} — its metadata sidecar is missing.`);
        continue;
      }

      let sidecar: Sidecar;
      try {
        const parsed = JSON.parse(sidecarText) as Partial<Sidecar>;
        if (typeof parsed.originalFilename !== 'string' || typeof parsed.uploadedAt !== 'string') {
          throw new Error('malformed sidecar');
        }
        sidecar = { originalFilename: parsed.originalFilename, uploadedAt: parsed.uploadedAt };
      } catch {
        this.#index.markUnreadable(binary.key);
        console.warn(`[journal] skipping ${binary.key} — its metadata sidecar is unreadable.`);
        continue;
      }

      const extracted = await extractMediaMetadata(data, binary.contentType);
      const uploadedEpochMs = parseCanonicalOrNow(sidecar.uploadedAt);
      const row = toRow(id, binary.key, sidecar, binary.contentType, data.length, extracted, uploadedEpochMs);
      this.#index.upsert(row);
    }
  }
}

