import { createHash } from 'node:crypto';

/**
 * The write precondition (`plan.md` M2).
 *
 * A fingerprint of the **exact bytes on disk** — the whole file, frontmatter
 * included, not just the body. That is deliberate: these files are meant to be
 * opened in an ordinary text editor, which is a stated benefit of plain files
 * and not an edge case, so nothing about what changed should be assumed safe to
 * ignore. If anything in the file differs from what a caller last read —
 * body, frontmatter, anything — the fingerprint differs and the write is
 * refused rather than silently clobbering it.
 *
 * SHA-256 over the raw file text, hex-encoded. There is nothing clever here on
 * purpose: the value is opaque to every caller, so the algorithm behind it is
 * free to change without that being a compatibility concern.
 */
export function contentHash(fileText: string): string {
  return createHash('sha256').update(fileText, 'utf8').digest('hex');
}
