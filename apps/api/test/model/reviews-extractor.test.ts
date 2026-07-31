import { beforeEach, describe, expect, it } from 'vitest';
import { CategoriesIndex } from '../../src/index/categories-index.js';
import { ReviewsIndex } from '../../src/index/reviews-index.js';
import { ReviewsExtractor } from '../../src/model/reviews-extractor.js';
import type { ExtractionRequest, ModelClient } from '../../src/model/model-client.js';
import type { ReviewExtractionResult } from '../../src/model/reviews.js';
import { REVIEW_MEDIUM_SEED_NAMES } from '../../src/model/reviews.js';
import type {
  CreateEntryInput,
  EntryStore,
  ListOptions,
  ListResult,
  StoredEntry,
  StoreStats,
  UpdateEntryInput,
} from '../../src/store/entry-store.js';

class FakeModelClient implements ModelClient {
  calls: ExtractionRequest<unknown>[] = [];
  result: Partial<ReviewExtractionResult> = { reviews: [] };

  async extract<T>(request: ExtractionRequest<T>): Promise<T> {
    this.calls.push(request as ExtractionRequest<unknown>);
    return { suggestedCategory: null, ...this.result } as unknown as T;
  }
}

class FakeEntryStore implements EntryStore {
  constructor(private entries: StoredEntry[]) {}

  async list(options: ListOptions): Promise<ListResult> {
    const start = options.cursor ? Number(options.cursor) : 0;
    const end = Math.min(start + options.limit, this.entries.length);
    const page = this.entries.slice(start, end);
    return {
      entries: page.map((e) => ({ id: e.id, created: e.created, excerpt: e.body.slice(0, 20) })),
      nextCursor: end < this.entries.length ? String(end) : null,
    };
  }

  async get(id: string): Promise<StoredEntry | null> {
    return this.entries.find((e) => e.id === id) ?? null;
  }

  create(_input: CreateEntryInput): Promise<StoredEntry> {
    throw new Error('not used in these tests');
  }
  update(_id: string, _input: UpdateEntryInput): Promise<StoredEntry> {
    throw new Error('not used in these tests');
  }
  discardIfBlank(_id: string): Promise<void> {
    throw new Error('not used in these tests');
  }
  addAttachment(): Promise<never> {
    throw new Error('not used in these tests');
  }
  async stats(): Promise<StoreStats> {
    return { entryCount: this.entries.length, unreadableCount: 0 };
  }
}

const entry = (id: string, body: string, created = '2026-07-20T21:00:00+01:00'): StoredEntry => ({
  id,
  created,
  body,
  path: `journal/${id}.md`,
  contentHash: `hash-${id}`,
});

let reviewsIndex: ReviewsIndex;
let categoriesIndex: CategoriesIndex;
let modelClient: FakeModelClient;
let extractor: ReviewsExtractor;

beforeEach(() => {
  reviewsIndex = new ReviewsIndex(':memory:');
  categoriesIndex = new CategoriesIndex(':memory:');
  categoriesIndex.seed('review_medium', REVIEW_MEDIUM_SEED_NAMES, '2026-01-01T00:00:00Z');
  modelClient = new FakeModelClient();
  extractor = new ReviewsExtractor(reviewsIndex, categoriesIndex, modelClient);
});

describe('extractEntry', () => {
  it('stores a record for each review the model returns, rating included', async () => {
    modelClient.result = {
      reviews: [
        {
          title: 'Some Film',
          medium: 'film',
          rating: 4,
          progress: 100,
          opinion: 'Really enjoyed it.',
          eventTime: '2026-07-20T20:00:00+01:00',
          eventTimeExplicit: true,
        },
      ],
    };
    await extractor.extractEntry(entry('e1', 'Watched Some Film tonight, really enjoyed it. 4 stars.'));

    const [record] = reviewsIndex.list({ limit: 10 });
    expect(record).toMatchObject({
      entryId: 'e1',
      title: 'Some Film',
      medium: 'film',
      rating: 4,
      progress: 100,
      opinion: 'Really enjoyed it.',
    });
  });

  it('stores a null progress when the model gives none — never invents one', async () => {
    modelClient.result = {
      reviews: [
        {
          title: 'A Book',
          medium: 'book',
          rating: null,
          progress: null,
          opinion: 'Interesting premise.',
          eventTime: '2026-07-20T20:00:00+01:00',
          eventTimeExplicit: true,
        },
      ],
    };
    await extractor.extractEntry(entry('e1', 'Reading A Book, interesting premise so far.'));
    expect(reviewsIndex.list({ limit: 10 })[0]!.progress).toBeNull();
  });

  it('stores a partial progress value the model infers from the entry', async () => {
    modelClient.result = {
      reviews: [
        {
          title: 'A Book',
          medium: 'book',
          rating: null,
          progress: 50,
          opinion: 'Halfway through, enjoying it.',
          eventTime: '2026-07-20T20:00:00+01:00',
          eventTimeExplicit: true,
        },
      ],
    };
    await extractor.extractEntry(entry('e1', "I'm halfway through A Book."));
    expect(reviewsIndex.list({ limit: 10 })[0]!.progress).toBe(50);
  });

  it('stores a null rating when the model gives none — never invents one', async () => {
    modelClient.result = {
      reviews: [
        { title: 'A Book', medium: 'book', rating: null, progress: null, opinion: 'Interesting premise.', eventTime: '2026-07-20T20:00:00+01:00', eventTimeExplicit: true },
      ],
    };
    await extractor.extractEntry(entry('e1', 'Reading A Book, interesting premise so far.'));
    expect(reviewsIndex.list({ limit: 10 })[0]!.rating).toBeNull();
  });

  it('stores nothing when the model finds no review', async () => {
    modelClient.result = { reviews: [] };
    await extractor.extractEntry(entry('e1', 'A day with nothing reviewed.'));
    expect(reviewsIndex.list({ limit: 10 })).toEqual([]);
  });

  it('falls back to the entry’s own written time for a malformed eventTime', async () => {
    modelClient.result = {
      reviews: [{ title: 'X', medium: 'film', rating: null, progress: null, opinion: 'ok', eventTime: 'not a timestamp', eventTimeExplicit: true }],
    };
    await extractor.extractEntry(entry('e1', 'Watched X.', '2026-07-20T21:00:00+01:00'));
    const [record] = reviewsIndex.list({ limit: 10 });
    expect(record!.eventTime).toBe('2026-07-20T21:00:00+01:00');
    expect(record!.eventTimeExplicit).toBe(false);
  });

  it('keeps two encounters with the same title as two separate records across two extractions', async () => {
    modelClient.result = {
      reviews: [{ title: 'Rewatched Film', medium: 'film', rating: 5, progress: 100, opinion: 'even better this time', eventTime: '2026-07-20T20:00:00+01:00', eventTimeExplicit: true }],
    };
    await extractor.extractEntry(entry('e1', 'Watched it again.'));
    await extractor.extractEntry(entry('e2', 'Watched it a third time.'));
    expect(reviewsIndex.list({ limit: 10 })).toHaveLength(2);
  });

  it('records a suggested medium without inventing a review record for it', async () => {
    modelClient.result = {
      reviews: [],
      suggestedCategory: { name: 'podcast', reason: 'reviewed a podcast episode' },
    };
    await extractor.extractEntry(entry('e1', 'Listened to a great podcast episode.'));

    expect(reviewsIndex.list({ limit: 10 })).toEqual([]);
    expect(categoriesIndex.listSuggestions()).toMatchObject([
      { structureType: 'review_medium', name: 'podcast', reason: 'reviewed a podcast episode', entryId: 'e1' },
    ]);
  });
});

describe('removeEntry', () => {
  it('delegates straight to the index', async () => {
    modelClient.result = {
      reviews: [{ title: 'X', medium: 'film', rating: null, progress: null, opinion: 'ok', eventTime: '2026-07-20T20:00:00+01:00', eventTimeExplicit: true }],
    };
    await extractor.extractEntry(entry('e1', 'Watched X.'));
    extractor.removeEntry('e1');
    expect(reviewsIndex.list({ limit: 10 })).toEqual([]);
  });
});

describe('reprocessAll', () => {
  it('extracts every entry and clears what came before', async () => {
    await extractor.extractEntry(entry('stale', 'leftover'));
    modelClient.result = {
      reviews: [{ title: 'X', medium: 'film', rating: null, progress: null, opinion: 'ok', eventTime: '2026-07-20T20:00:00+01:00', eventTimeExplicit: true }],
    };
    const store = new FakeEntryStore([entry('e1', 'a'), entry('e2', 'b')]);

    const result = await extractor.reprocessAll(store);

    expect(result).toEqual({ entryCount: 2, reviewCount: 2 });
  });
});
