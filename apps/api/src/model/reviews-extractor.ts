import type { CategoriesIndex } from '../index/categories-index.js';
import type { ReviewRecord, ReviewsIndex } from '../index/reviews-index.js';
import { ulid } from '../record/id.js';
import { nowTimestamp } from '../record/time.js';
import type { EntryStore } from '../store/entry-store.js';
import { resolveEventTime } from './event-time.js';
import type { ModelClient } from './model-client.js';
import { buildExtractionPrompt, buildReviewExtractionRequest } from './reviews.js';

const PAGE_SIZE = 100;

/**
 * Turns one entry's body into review records via `ModelClient` — the same
 * shape as `Extractor` (`plan.md` M7's temporal metrics), a deliberately
 * separate class rather than a shared generic: the record shape (title,
 * medium, rating, opinion) is different enough from a temporal metric's
 * (metric, detail) that a generic abstraction would mostly be indirection.
 * What genuinely is identical — event-time resolution — is already shared,
 * via `resolveEventTime`.
 *
 * Never wired into live writes, for the same cost reason as `Extractor`:
 * only `reprocessAll`, run explicitly via `npm run reprocess`.
 */
export class ReviewsExtractor {
  readonly #reviewsIndex: ReviewsIndex;
  readonly #categoriesIndex: CategoriesIndex;
  readonly #modelClient: ModelClient;

  constructor(reviewsIndex: ReviewsIndex, categoriesIndex: CategoriesIndex, modelClient: ModelClient) {
    this.#reviewsIndex = reviewsIndex;
    this.#categoriesIndex = categoriesIndex;
    this.#modelClient = modelClient;
  }

  async extractEntry(entry: { id: string; created: string; body: string }): Promise<void> {
    const approvedMedia = this.#categoriesIndex.approvedNames('review_medium');
    const { schema, system } = buildReviewExtractionRequest(approvedMedia);
    const result = await this.#modelClient.extract({ schema, system, prompt: buildExtractionPrompt(entry) });

    const extractedAt = nowTimestamp().canonical;
    const records: Omit<ReviewRecord, 'entryId'>[] = result.reviews.map((review) => {
      const resolved = resolveEventTime(review.eventTime, review.eventTimeExplicit, entry.created);
      return {
        id: ulid(Date.now()),
        title: review.title,
        medium: review.medium,
        rating: review.rating,
        opinion: review.opinion,
        ...resolved,
        extractedAt,
      };
    });

    this.#reviewsIndex.replaceEntry(entry.id, records);

    if (result.suggestedCategory) {
      this.#categoriesIndex.suggest({
        structureType: 'review_medium',
        name: result.suggestedCategory.name,
        reason: result.suggestedCategory.reason,
        entryId: entry.id,
        id: ulid(Date.now()),
        now: extractedAt,
      });
    }
  }

  removeEntry(entryId: string): void {
    this.#reviewsIndex.removeEntry(entryId);
  }

  /** Reprocess-from-scratch (`requirements.md` §6.4) — see `Extractor`'s
   * identical method for the full reasoning. */
  async reprocessAll(store: EntryStore): Promise<{ entryCount: number; reviewCount: number }> {
    this.#reviewsIndex.clear();
    let cursor: string | undefined;
    let entryCount = 0;
    do {
      const page = await store.list({ limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) });
      for (const summary of page.entries) {
        const entry = await store.get(summary.id);
        if (!entry) continue;
        await this.extractEntry(entry);
        entryCount += 1;
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    const { reviewCount } = this.#reviewsIndex.stats();
    return { entryCount, reviewCount };
  }
}
