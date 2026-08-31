/**
 * Where a media item's bytes go, and what content types the library accepts
 * (`requirements.md` — photo library, M19).
 *
 *     media/<id>.<ext>       — the file itself, exactly as uploaded
 *     media/<id>.json        — a small sidecar: `{ originalFilename, uploadedAt }`
 *
 * Flat, no date nesting — a media item is chronologically located by its own
 * `capturedAt`/`uploadedAt`, the same reasoning `document-filename.ts` gives
 * for skipping `YYYY/MM` on documents.
 *
 * The key is derived entirely from `id` and the upload's own content type —
 * never from the uploader's original filename, so there is no
 * path-traversal surface to validate against at all. `originalFilename` is
 * kept only as a display string, in the sidecar.
 *
 * The sidecar exists because `originalFilename` and `uploadedAt` are the two
 * facts about a media item that are *not* recoverable from the file's own
 * bytes — unlike dimensions and `capturedAt`, which `media-metadata.ts` can
 * always re-derive from the binary alone. A plain JSON file, not S3 object
 * metadata: the same "portable via `aws s3 sync`" reasoning `requirements.md`
 * §7.3 gives for the journal itself applies here — metadata living in the
 * platform's own out-of-band feature would not survive a sync to a plain
 * directory the way a sibling file does, and it keeps the fs and S3 backends
 * symmetric instead of each leaning on a different mechanism.
 */

export const MEDIA_DIR = 'media';

const EXTENSION_BY_CONTENT_TYPE: Readonly<Record<string, string>> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
};

const CONTENT_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(EXTENSION_BY_CONTENT_TYPE).map(([type, ext]) => [ext, type]),
);

export function isSupportedMediaContentType(contentType: string): boolean {
  return contentType in EXTENSION_BY_CONTENT_TYPE;
}

/** The content type for a scanned file's extension, or `null` if it is not
 * one of ours — used only by a backend's rebuild scan, never by upload
 * (which always knows the real content type from the request itself). */
export function contentTypeForExtension(ext: string): string | null {
  return CONTENT_TYPE_BY_EXTENSION[ext] ?? null;
}

/** `'image'` or `'video'`, from the content type's own prefix — the same
 * distinction `MediaMetadata.kind` carries. Callers must check
 * `isSupportedMediaContentType` first; this assumes a supported type. */
export function mediaKindOf(contentType: string): 'image' | 'video' {
  return contentType.startsWith('video/') ? 'video' : 'image';
}

/** `media/01K3F9X2VQ8N7M4TQXYZ8ABCDE.jpg` — the binary object's path,
 * relative to the journal root (fs) or as the S3 key (s3). */
export function mediaRelativePath(id: string, contentType: string): string {
  const ext = EXTENSION_BY_CONTENT_TYPE[contentType];
  if (!ext) throw new Error(`mediaRelativePath: unsupported content type '${contentType}'.`);
  return `${MEDIA_DIR}/${id}${ext}`;
}

/** `media/01K3F9X2VQ8N7M4TQXYZ8ABCDE.json` — the sidecar's path. */
export function mediaSidecarPath(id: string): string {
  return `${MEDIA_DIR}/${id}.json`;
}
