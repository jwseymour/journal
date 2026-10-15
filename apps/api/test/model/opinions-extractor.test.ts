import { beforeEach, describe, expect, it } from 'vitest';
import { CategoriesIndex } from '../../src/index/categories-index.js';
import { OpinionStatementsIndex } from '../../src/index/opinion-statements-index.js';
import type { ExtractionRequest, ModelClient } from '../../src/model/model-client.js';
import { OpinionsExtractor } from '../../src/model/opinions-extractor.js';
import { OPINION_SUBJECT_SEED_NAMES } from '../../src/model/opinions.js';
import type { OpinionExtractionResult } from '../../src/model/opinions.js';
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
  result: Partial<OpinionExtractionResult> = { statements: [], resolutions: [] };

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
  listAttachments(): Promise<never> {
    throw new Error('not used in these tests');
  }
  getAttachment(): Promise<never> {
    throw new Error('not used in these tests');
  }
  listPeriods(): Promise<never> {
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

let statementsIndex: OpinionStatementsIndex;
let categoriesIndex: CategoriesIndex;
let modelClient: FakeModelClient;
let extractor: OpinionsExtractor;

beforeEach(() => {
  statementsIndex = new OpinionStatementsIndex(':memory:');
  categoriesIndex = new CategoriesIndex(':memory:');
  categoriesIndex.seed('opinion_subject', OPINION_SUBJECT_SEED_NAMES, '2026-01-01T00:00:00Z');
  modelClient = new FakeModelClient();
  extractor = new OpinionsExtractor(statementsIndex, categoriesIndex, modelClient);
});

describe('extractCandidates', () => {
  it('shapes model output into candidates without writing to the index', async () => {
    modelClient.result = {
      statements: [
        { subject: 'philosophy', statement: 'Believes in taking things slowly.', eventTime: '2026-07-20T09:00:00+01:00', eventTimeExplicit: true, kind: 'note', confidence: 'medium', confidenceReason: 'reasonable reading of tone and context' },
      ],
      resolutions: [],
    };
    const result = await extractor.extractCandidates(entry('e1', 'I keep coming back to the idea that slow is fine.'));

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ subject: 'philosophy', confidence: 'medium' });
    expect(statementsIndex.list({ limit: 10 })).toEqual([]);
  });

  it('extractEntry still produces the exact same committed records as before this split', async () => {
    modelClient.result = {
      statements: [
        { subject: 'philosophy', statement: 'Believes in taking things slowly.', eventTime: '2026-07-20T09:00:00+01:00', eventTimeExplicit: true, kind: 'note', confidence: 'low', confidenceReason: 'borderline' },
      ],
      resolutions: [],
    };
    await extractor.extractEntry(entry('e1', 'x'));

    const [record] = statementsIndex.list({ limit: 10 });
    expect(record).not.toHaveProperty('confidence');
    expect(record).not.toHaveProperty('confidenceReason');
    expect(record).toMatchObject({ subject: 'philosophy', touched: false });
  });
});

describe('resolutions — conversation topics (requirements.md §11, resolved 2026-08-30)', () => {
  it('keeps a resolution matching a real open question and passes it through as a candidate', async () => {
    statementsIndex.replaceEntry('e1', [
      { id: 'q1', subject: 'philosophy', statement: 'Should I take the job?', kind: 'question', eventTime: '2026-07-20T09:00:00+01:00', eventEpochMs: 1000, eventTimeExplicit: true, extractedAt: '2026-07-20T09:00:00+01:00', touched: false },
    ]);
    modelClient.result = {
      statements: [],
      resolutions: [{ statementId: 'q1', resolution: 'Took the job.', confidence: 'high', confidenceReason: null }],
    };
    const result = await extractor.extractCandidates(entry('e2', 'Took the job today.'));
    expect(result.resolutions).toEqual([{ statementId: 'q1', resolution: 'Took the job.', confidence: 'high', confidenceReason: null }]);
  });

  it('drops a resolution whose id is not actually an open question — never trusted blindly', async () => {
    modelClient.result = {
      statements: [],
      resolutions: [{ statementId: 'hallucinated', resolution: 'x', confidence: 'high', confidenceReason: null }],
    };
    const result = await extractor.extractCandidates(entry('e1', 'x'));
    expect(result.resolutions).toEqual([]);
  });

  it('extractEntry commits a resolution via the guarded reprocess path', async () => {
    statementsIndex.replaceEntry('e1', [
      { id: 'q1', subject: 'philosophy', statement: 'Should I take the job?', kind: 'question', eventTime: '2026-07-20T09:00:00+01:00', eventEpochMs: 1000, eventTimeExplicit: true, extractedAt: '2026-07-20T09:00:00+01:00', touched: false },
    ]);
    modelClient.result = {
      statements: [],
      resolutions: [{ statementId: 'q1', resolution: 'Took the job.', confidence: 'high', confidenceReason: null }],
    };
    await extractor.extractEntry(entry('e2', 'Took the job today.'));
    expect(statementsIndex.getById('q1')).toMatchObject({ status: 'resolved', resolvedEntryId: 'e2', resolution: 'Took the job.' });
  });
});

describe('extractEntry', () => {
  it('stores a record for each statement the model returns', async () => {
    modelClient.result = {
      statements: [
        {
          subject: 'philosophy',
          statement: 'Believes in living deliberately.',
          eventTime: '2026-07-20T20:00:00+01:00',
          eventTimeExplicit: true,
          kind: 'note',
          confidence: 'high',
          confidenceReason: null,
        },
      ],
      resolutions: [],
    };
    await extractor.extractEntry(entry('e1', 'Reflecting on how I want to live.'));

    const [record] = statementsIndex.list({ limit: 10 });
    expect(record).toMatchObject({
      entryId: 'e1',
      subject: 'philosophy',
      statement: 'Believes in living deliberately.',
    });
  });

  it('stores nothing when the model finds no opinion', async () => {
    modelClient.result = { statements: [], resolutions: [] };
    await extractor.extractEntry(entry('e1', 'A day with no opinions expressed.'));
    expect(statementsIndex.list({ limit: 10 })).toEqual([]);
  });

  it('stores two distinct statements on the same subject within one entry as two records', async () => {
    modelClient.result = {
      statements: [
        { subject: 'philosophy', statement: 'First view.', eventTime: '2026-07-20T20:00:00+01:00', eventTimeExplicit: true, kind: 'note', confidence: 'high', confidenceReason: null },
        { subject: 'philosophy', statement: 'Second, distinct view.', eventTime: '2026-07-20T20:00:00+01:00', eventTimeExplicit: true, kind: 'note', confidence: 'high', confidenceReason: null },
      ],
      resolutions: [],
    };
    await extractor.extractEntry(entry('e1', 'Two thoughts today.'));
    expect(statementsIndex.list({ limit: 10 })).toHaveLength(2);
  });

  it('falls back to the entry’s own written time for a malformed eventTime', async () => {
    modelClient.result = {
      statements: [
        { subject: 'future', statement: 'Wants to travel more.', eventTime: 'not a timestamp', eventTimeExplicit: true, kind: 'note', confidence: 'high', confidenceReason: null },
      ],
      resolutions: [],
    };
    await extractor.extractEntry(entry('e1', 'Thinking about the future.', '2026-07-20T21:00:00+01:00'));
    const [record] = statementsIndex.list({ limit: 10 });
    expect(record!.eventTime).toBe('2026-07-20T21:00:00+01:00');
    expect(record!.eventTimeExplicit).toBe(false);
  });

  it('records a suggested subject without inventing a statement record for it', async () => {
    modelClient.result = {
      statements: [],
      suggestedCategory: { name: 'career', reason: 'reflected on a career change' },
      resolutions: [],
    };
    await extractor.extractEntry(entry('e1', 'Thinking about switching careers.'));

    expect(statementsIndex.list({ limit: 10 })).toEqual([]);
    expect(categoriesIndex.listSuggestions()).toMatchObject([
      { structureType: 'opinion_subject', name: 'career', reason: 'reflected on a career change', entryId: 'e1' },
    ]);
  });
});

describe('removeEntry', () => {
  it('delegates straight to the index', async () => {
    modelClient.result = {
      statements: [{ subject: 'philosophy', statement: 'x', eventTime: '2026-07-20T20:00:00+01:00', eventTimeExplicit: true, kind: 'note', confidence: 'high', confidenceReason: null }],
      resolutions: [],
    };
    await extractor.extractEntry(entry('e1', 'x'));
    extractor.removeEntry('e1');
    expect(statementsIndex.list({ limit: 10 })).toEqual([]);
  });
});

describe('reprocessAll', () => {
  it('extracts every entry and clears what came before', async () => {
    await extractor.extractEntry(entry('stale', 'leftover'));
    modelClient.result = {
      statements: [{ subject: 'philosophy', statement: 'x', eventTime: '2026-07-20T20:00:00+01:00', eventTimeExplicit: true, kind: 'note', confidence: 'high', confidenceReason: null }],
      resolutions: [],
    };
    const store = new FakeEntryStore([entry('e1', 'a'), entry('e2', 'b')]);

    const result = await extractor.reprocessAll(store);

    expect(result).toEqual({ entryCount: 2, statementCount: 2 });
  });
});
