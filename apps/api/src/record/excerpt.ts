/**
 * The scrap of prose that lets an entry be recognised in a list.
 *
 * Cut here, on the backend, because the frontend receives a string and knows
 * nothing about how it was produced (`plan.md` M1, `requirements.md` §7.1).
 *
 * It deliberately does nothing clever. No markdown is stripped and no heading
 * is promoted to a title, because there is no formatting convention and none
 * will be introduced — inventing one here would be the first step towards
 * asking the user to follow it (`requirements.md` §4.8).
 */

export const EXCERPT_MAX_CHARS = 240;

/** Cutting by grapheme, so a truncation can never land inside an emoji. */
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function excerpt(body: string, maxChars: number = EXCERPT_MAX_CHARS): string {
  // Newlines and runs of spaces become single spaces: a list row is one line,
  // and the shape of the original paragraphs cannot survive there anyway.
  const collapsed = body.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxChars) return collapsed;

  const graphemes: string[] = [];
  for (const { segment } of segmenter.segment(collapsed)) {
    graphemes.push(segment);
    if (graphemes.length > maxChars) break;
  }
  if (graphemes.length <= maxChars) return collapsed;

  const clipped = graphemes.slice(0, maxChars).join('');
  // Prefer a word boundary, but only if one is reasonably near the end —
  // otherwise a single very long token would shorten the excerpt to nothing.
  const lastSpace = clipped.lastIndexOf(' ');
  const cut = lastSpace > maxChars * 0.6 ? clipped.slice(0, lastSpace) : clipped;
  return `${cut.trimEnd()}…`;
}
