/**
 * Splits an entry's body into paragraphs to embed separately (`plan.md` M6).
 *
 * By paragraph, not by entry: a long entry covering four subjects has no
 * single meaning to embed, and a paragraph is the smallest unit a writer
 * already delimits themselves, so this needs no policy of its own about
 * where meaning starts and ends.
 *
 * A paragraph is text separated by one or more blank lines. No sentence
 * splitting, no fixed-width windows — the author's own line breaks are the
 * only signal used.
 */
export function chunkParagraphs(body: string): string[] {
  return body
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
}
