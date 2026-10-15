/**
 * The content type an attachment is served back with — inferred from its
 * filename's extension, since a mirrored attachment carries no stored
 * content type of its own in the fs backend (S3 remembers what
 * `Publisher.putBytes` set, but this app never trusts that over the same
 * extension-based inference `apps/api`'s own `attachment-content-type.ts`
 * uses, so both sides agree regardless of backend). Duplicated by hand
 * rather than imported — this app shares no runtime code with `apps/api`
 * beyond `@journal/contract`'s types (`requirements.md` §7.1's frontend/
 * backend divide applies between these two services too).
 */
const EXTENSION_CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.wav': 'audio/wav',
};

export function attachmentContentType(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot === -1) return 'application/octet-stream';
  const ext = filename.slice(dot).toLowerCase();
  return EXTENSION_CONTENT_TYPES[ext] ?? 'application/octet-stream';
}
