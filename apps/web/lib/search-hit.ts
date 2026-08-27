import type { SearchHit } from '@journal/contract';

/**
 * A search hit is either an entry or a document (`plan.md` M17) — these two
 * tiny helpers are the one place that distinction turns into "where does
 * this link go" and "what makes this hit unique in a list," shared between
 * `/search` and the home page's embedded search box rather than duplicated
 * in both.
 */
export function searchHitHref(hit: SearchHit): string {
  return hit.sourceType === 'entry' ? `/entry/${hit.entryId}` : `/documents/${hit.documentId}`;
}

export function searchHitKey(hit: SearchHit): string {
  return hit.sourceType === 'entry' ? `entry-${hit.entryId}` : `document-${hit.documentId}`;
}
