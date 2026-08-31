import type { MediaMetadata } from '@journal/contract';

/**
 * The seam for the media library, mirroring `store/document-store.ts`'s
 * role and rules exactly: nothing above this interface may know that media
 * items are files, with the same single, informational exception
 * `StoredMedia.path` has.
 *
 * Deliberately smaller than `DocumentStore`: no `update` — a media item is
 * immutable once uploaded, the same stance `requirements.md` §4.6 takes on
 * entry attachments, so there is nothing to revise and no `contentHash` to
 * guard a revision with.
 */

export interface UploadMediaInput {
  /** As declared by the uploader (a browser `File`'s own `type`), never
   * sniffed from the bytes — validated against
   * `record/media-filename.ts`'s supported list before anything is written. */
  contentType: string;
  data: Buffer;
  /** Display only. Never validated as a path — see `media-filename.ts`'s
   * own comment for why there is no path-traversal surface to check here. */
  originalFilename: string;
}

export interface StoredMedia extends MediaMetadata {
  /** Journal-root-relative (fs) or the S3 key (s3). Informational only —
   * never a key callers resolve by. */
  path: string;
}

export interface ListMediaOptions {
  cursor?: string;
  limit: number;
}

export interface ListMediaResult {
  media: MediaMetadata[];
  nextCursor: string | null;
}

export interface MediaBytes {
  data: Buffer;
  contentType: string;
}

export interface MediaStoreStats {
  mediaCount: number;
  /** Objects found under `media/` that could not be paired with a readable
   * sidecar — see `MediaIndexStats`'s identical field. */
  unreadableCount: number;
}

export interface MediaStore {
  /** Validate, extract metadata, and write a new media item. Rejects an
   * unsupported `contentType` with `unsupported_media_type`
   * (`errors.ts`). */
  upload(input: UploadMediaInput): Promise<StoredMedia>;

  /** Fetch one item's metadata by id, or `null` if there is no such item. */
  get(id: string): Promise<StoredMedia | null>;

  /** Fetch one item's raw bytes, or `null` if there is no such item —
   * `GET /media/:id/file`'s one job. */
  getBytes(id: string): Promise<MediaBytes | null>;

  /** Delete an item. A tolerant no-op on an id that does not exist, the
   * same convention every other `DELETE` in this app follows. */
  remove(id: string): Promise<void>;

  /** One page, newest-*uploaded*-first. */
  list(options: ListMediaOptions): Promise<ListMediaResult>;

  /** Every item captured on `date` (`YYYY-MM-DD`) — the query behind
   * `GET /entries/:id/media`. */
  listByCapturedDate(date: string): Promise<MediaMetadata[]>;

  stats(): Promise<MediaStoreStats>;
}
