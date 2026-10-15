/**
 * Where a published entry's mirrored attachment lives, relative to the
 * storage root/bucket (`plan.md` M19). Must compute the exact same key
 * `apps/api/src/publish/publisher.ts`'s own `publicAttachmentKey` does —
 * that side writes here, this side only ever reads — so a change to one
 * is a change to both.
 */
export function publicAttachmentKey(entryId: string, filename: string): string {
  return `public/entry-attachments/${entryId}/${filename}`;
}

/**
 * A bare filename and nothing else — no path separators, no `..`, no
 * leading dot. The same guard `apps/api`'s entry stores apply before ever
 * writing an attachment; duplicated here as defence in depth, since this
 * app has no other check standing between a request's `:filename` param
 * and a storage key it builds directly from it.
 */
export function isValidAttachmentFilename(filename: string): boolean {
  if (filename.length === 0 || filename.length > 255) return false;
  if (filename === '.' || filename === '..') return false;
  if (filename.includes('/') || filename.includes('\\')) return false;
  if (filename.startsWith('.')) return false;
  return true;
}
