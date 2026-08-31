import type { CategoriesIndex } from '../index/categories-index.js';
import type { ReviewRecord, ReviewsIndex } from '../index/reviews-index.js';
import { ulid } from '../record/id.js';
import { nowTimestamp } from '../record/time.js';
import type { EntryStore } from '../store/entry-store.js';
import type { Confidence } from './confidence.js';
import { resolveEventTime } from './event-time.js';
import type { ModelClient } from './model-client.js';
import { buildExtractionPrompt, buildReviewExtractionRequest, type ReviewExtractionResult } from './reviews.js';

const PAGE_SIZE = 100;

/** One review candidate from a live Process run (`plan.md` M18) — see
 * `MetricCandidate` in `extractor.ts` for the full reasoning. */
export interface ReviewCandidate {
  id: string;
  title: string;
  medium: string;
  rating: number | null;
  progress: number | null;
  opinion: string;
  eventTime: string;
  eventEpochMs: number;
  eventTimeExplicit: boolean;
  extractedAt: string;
  confidence: Confidence;
  confidenceReason: string | null;
}

export interface ReviewExtractionCandidates {
  extractedAt: string;
  candidates: ReviewCandidate[];
  suggestedCategory: ReviewExtractionResult['suggestedCategory'];
}

/**
 * Turns one entry's body into review candidates via `ModelClient` — the same
 * shape as `Extractor` (`plan.md` M7's temporal metrics), a deliberately
 * separate class rather than a shared generic: the record shape (title,
 * medium, rating, opinion) is different enough from a temporal metric's
 * (metric, detail) that a generic abstraction would mostly be indirection.
 * What genuinely is identical — event-time resolution — is already shared,
 * via `resolveEventTime`. `extractCandidates`/`extractEntry` split the same
 * way as `Extractor`'s — see that file for the full reasoning.
 *
 * Never wired into autosave — a paid call on every keystroke would be both
 * wasteful and a surprise on the user's bill. Reached two ways instead:
 * `reprocessAll` (`npm run reprocess`, batch, corpus-wide) and
 * `LivePendingProcessor` (`POST /entries/:id/process`, live, one entry, only
 * ever on an explicit user action — `plan.md` M15, M18).
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

  /** The pure model-call-and-shape step (`plan.md` M18) — see
   * `Extractor.extractCandidates` for the full reasoning. */
  async extractCandidates(entry: { id: string; created: string; body: string }): Promise<ReviewExtractionCandidates> {
    const approvedMedia = this.#categoriesIndex.approvedNames('review_medium');
    const { schema, system } = buildReviewExtractionRequest(approvedMedia);
    const result = await this.#modelClient.extract({ schema, system, prompt: buildExtractionPrompt(entry) });

    const extractedAt = nowTimestamp().canonical;
    const candidates: ReviewCandidate[] = result.reviews.map((review) => {
      const resolved = resolveEventTime(review.eventTime, review.eventTimeExplicit, entry.created);
      return {
        id: ulid(Date.now()),
        title: review.title,
        medium: review.medium,
        rating: review.rating,
        progress: review.progress,
        opinion: review.opinion,
        ...resolved,
        extractedAt,
        confidence: review.confidence,
        confidenceReason: review.confidenceReason,
      };
    });

    return { extractedAt, candidates, suggestedCategory: result.suggestedCategory };
  }

  async extractEntry(entry: { id: string; created: string; body: string }): Promise<{ reviewCount: number }> {
    const { extractedAt, candidates, suggestedCategory } = await this.extractCandidates(entry);
    const records: Omit<ReviewRecord, 'entryId'>[] = candidates.map((candidate) => ({
      id: candidate.id,
      title: candidate.title,
      medium: candidate.medium,
      rating: candidate.rating,
      progress: candidate.progress,
      opinion: candidate.opinion,
      eventTime: candidate.eventTime,
      eventEpochMs: candidate.eventEpochMs,
      eventTimeExplicit: candidate.eventTimeExplicit,
      extractedAt: candidate.extractedAt,
      touched: false,
    }));
    const result = { suggestedCategory };

    // See `Extractor.extractEntry` for the full reasoning — touched records
    // are protected from reprocess; a clean 1:1 match against fresh output
    // proposes an update instead of applying it and inserts nothing new
    // untouched (`plan.md` M10).
    const touched = this.#reviewsIndex.touchedForEntry(entry.id);
    let untouchedRecords = records;
    if (touched.length > 0 && touched.length === records.length) {
      for (let i = 0; i < touched.length; i += 1) {
        const before = touched[i];
        const after = records[i];
        if (!before || !after) continue;
        if (
          before.title !== after.title ||
          before.rating !== after.rating ||
          before.progress !== after.progress ||
          before.opinion !== after.opinion ||
          before.eventTime !== after.eventTime
        ) {
          this.#reviewsIndex.proposeUpdate({
            id: ulid(Date.now()),
            recordId: before.id,
            entryId: entry.id,
            title: after.title,
            rating: after.rating,
            progress: after.progress,
            opinion: after.opinion,
            eventTime: after.eventTime,
            eventEpochMs: after.eventEpochMs,
            eventTimeExplicit: after.eventTimeExplicit,
            reason: 'Reprocessing this entry now extracts different content.',
            now: extractedAt,
          });
        }
      }
      untouchedRecords = [];
    }
    this.#reviewsIndex.replaceUntouchedForEntry(entry.id, untouchedRecords);

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

    return { reviewCount: records.length };
  }

  removeEntry(entryId: string): void {
    this.#reviewsIndex.removeEntry(entryId);
  }

  /** Reprocess-from-scratch (`requirements.md` §6.4) — see `Extractor`'s
   * identical method for the full reasoning. */
  async reprocessAll(store: EntryStore): Promise<{ entryCount: number; reviewCount: number }> {
    this.#reviewsIndex.clearUntouched();
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
