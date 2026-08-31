import { readdir, readFile, stat, unlink } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';
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
import { writeFileAtomic } from './atomic-write.js';
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
 * The filesystem implementation of `MediaStore`, mirroring `FsDocumentStore`
 * (`requirements.md` — photo library, M19): the index is a cache, rebuilt by
 * re-reading the objects it does not already know about; a file that cannot
 * be paired with its sidecar is skipped and counted, never allowed to fail
 * the whole listing.
 */

const MAX_ID_ATTEMPTS = 8;
const CURSOR_VERSION = 'm1';

interface Sidecar {
  originalFilename: string;
  uploadedAt: string;
}

function toRow(id: string, absPath: string, relPath: string, sidecar: Sidecar, contentType: string, byteSize: number, extracted: { width: number | null; height: number | null; capturedAt: string | null }, uploadedEpochMs: number): MediaIndexRow {
  return {
    id,
    absPath,
    relPath,
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

const toPosix = (path: string): string => (sep === '/' ? path : path.split(sep).join('/'));

export class FsMediaStore implements MediaStore {
  readonly #journalRoot: string;
  readonly #mediaRoot: string;
  readonly #index: MediaIndex;
  #inFlight: Promise<void> | null = null;

  constructor(journalRoot: string, index: MediaIndex) {
    this.#journalRoot = journalRoot;
    this.#mediaRoot = join(journalRoot, MEDIA_DIR);
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
      const relPath = mediaRelativePath(id, input.contentType);
      const absPath = join(this.#journalRoot, relPath);

      if (await exists(absPath)) continue;

      const sidecarRelPath = mediaSidecarPath(id);
      const sidecarAbsPath = join(this.#journalRoot, sidecarRelPath);
      const sidecar: Sidecar = { originalFilename, uploadedAt: now.canonical };

      try {
        await writeFileAtomic(absPath, input.data, this.#journalRoot);
        await writeFileAtomic(sidecarAbsPath, JSON.stringify(sidecar), this.#journalRoot);
      } catch (cause) {
        throw journalUnavailable(`Could not write the media item to ${relPath}.`, cause);
      }

      const extracted = await extractMediaMetadata(input.data, input.contentType);
      const row = toRow(id, absPath, relPath, sidecar, input.contentType, input.data.length, extracted, now.epochMs);
      this.#index.upsert(row);

      return { ...toMetadata(row), path: relPath };
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

    try {
      const data = await readFile(row.absPath);
      return { data, contentType: row.contentType };
    } catch (cause) {
      if (isNotFound(cause)) {
        this.#index.remove(row.absPath);
        return null;
      }
      throw journalUnavailable(`Could not read ${row.relPath}.`, cause);
    }
  }

  async remove(id: string): Promise<void> {
    await this.#refresh();
    const row = this.#index.getById(id);
    if (!row) return;

    const sidecarAbsPath = join(this.#journalRoot, mediaSidecarPath(id));
    await unlink(row.absPath).catch((cause) => {
      if (!isNotFound(cause)) throw journalUnavailable(`Could not remove ${row.relPath}.`, cause);
    });
    await unlink(sidecarAbsPath).catch(() => {
      /* the sidecar not existing is not a reason to fail the delete */
    });
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

  /** `rebuild --from-scratch`, the media-store twin of `FsDocumentStore.rebuild()`. */
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

  async #scan(): Promise<void> {
    let items;
    try {
      items = await readdir(this.#mediaRoot, { withFileTypes: true });
    } catch (cause) {
      if (isNotFound(cause)) {
        // No media/ directory yet — nothing uploaded, not an error.
        const known = this.#index.knownPaths();
        for (const absPath of known) this.#index.remove(absPath);
        return;
      }
      throw journalUnavailable(`Could not read ${this.#mediaRoot}.`, cause);
    }

    const found = new Map<string, { absPath: string; relPath: string; contentType: string }>();
    for (const item of items) {
      if (!item.isFile()) continue;
      if (item.name.startsWith('.') || item.name.endsWith('.json')) continue;
      const ext = extname(item.name);
      const contentType = contentTypeForExtension(ext);
      if (!contentType) continue;
      const id = item.name.slice(0, -ext.length);
      const absPath = join(this.#mediaRoot, item.name);
      found.set(id, { absPath, relPath: toPosix(relative(this.#journalRoot, absPath)), contentType });
    }

    const known = this.#index.knownPaths();
    const foundPaths = new Set([...found.values()].map((f) => f.absPath));
    for (const absPath of known) {
      if (!foundPaths.has(absPath)) this.#index.remove(absPath);
    }

    for (const [id, file] of found) {
      if (known.has(file.absPath)) continue;

      let data: Buffer;
      try {
        data = await readFile(file.absPath);
      } catch (cause) {
        if (isNotFound(cause)) continue;
        throw journalUnavailable(`Could not read ${file.relPath}.`, cause);
      }

      let sidecar: Sidecar;
      try {
        const sidecarText = await readFile(join(this.#journalRoot, mediaSidecarPath(id)), 'utf8');
        const parsed = JSON.parse(sidecarText) as Partial<Sidecar>;
        if (typeof parsed.originalFilename !== 'string' || typeof parsed.uploadedAt !== 'string') {
          throw new Error('malformed sidecar');
        }
        sidecar = { originalFilename: parsed.originalFilename, uploadedAt: parsed.uploadedAt };
      } catch (cause) {
        if (isNotFound(cause) || cause instanceof SyntaxError || (cause as Error).message === 'malformed sidecar') {
          this.#index.markUnreadable(file.absPath);
          console.warn(`[journal] skipping ${file.relPath} — its metadata sidecar is missing or unreadable.`);
          continue;
        }
        throw cause;
      }

      const extracted = await extractMediaMetadata(data, file.contentType);
      const uploadedTimestamp = parseCanonicalOrNow(sidecar.uploadedAt);
      const row = toRow(id, file.absPath, file.relPath, sidecar, file.contentType, data.length, extracted, uploadedTimestamp);
      this.#index.upsert(row);
    }
  }
}

/** The sidecar's `uploadedAt` is trusted verbatim for display, but list
 * ordering needs an epoch — re-derived here via `parseTimestamp` (never a
 * bare `Date.parse`, same reasoning `record/time.ts` gives throughout)
 * rather than stored twice in the sidecar itself. Falls back to "now" only
 * in the pathological case of a hand-edited, unparsable sidecar timestamp,
 * so a scan can never throw over it. */
function parseCanonicalOrNow(canonical: string): number {
  return parseTimestamp(canonical)?.epochMs ?? nowTimestamp().epochMs;
}
