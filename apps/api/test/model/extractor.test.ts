import { beforeEach, describe, expect, it } from 'vitest';
import { CategoriesIndex } from '../../src/index/categories-index.js';
import { MetricsIndex } from '../../src/index/metrics-index.js';
import { Extractor } from '../../src/model/extractor.js';
import { METRIC_SEED_NAMES } from '../../src/model/temporal-metrics.js';
import type { ExtractionRequest, ModelClient } from '../../src/model/model-client.js';
import type { ExtractionResult } from '../../src/model/temporal-metrics.js';
import type {
  CreateEntryInput,
  EntryStore,
  ListOptions,
  ListResult,
  StoredEntry,
  StoreStats,
  UpdateEntryInput,
} from '../../src/store/entry-store.js';

/** Returns whatever `result` is queued, regardless of the prompt — these
 * tests exercise `Extractor`'s own logic (event-time validation, storage,
 * pagination), not the model's judgement. That is a live drill's job
 * (`plan.md` M7). */
class FakeModelClient implements ModelClient {
  calls: ExtractionRequest<unknown>[] = [];
  // `suggestedCategory` defaults to null so most tests, which only care
  // about `metrics`, don't have to repeat it.
  result: Partial<ExtractionResult> = { metrics: [] };

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

const entry = (id: string, body: string, created = '2026-07-20T09:00:00+01:00'): StoredEntry => ({
  id,
  created,
  body,
  path: `journal/${id}.md`,
  contentHash: `hash-${id}`,
});

let metricsIndex: MetricsIndex;
let categoriesIndex: CategoriesIndex;
let modelClient: FakeModelClient;
let extractor: Extractor;

beforeEach(() => {
  metricsIndex = new MetricsIndex(':memory:');
  categoriesIndex = new CategoriesIndex(':memory:');
  categoriesIndex.seed('metric', METRIC_SEED_NAMES, '2026-01-01T00:00:00Z');
  modelClient = new FakeModelClient();
  extractor = new Extractor(metricsIndex, categoriesIndex, modelClient);
});

describe('extractEntry', () => {
  it('sends the entry body and its written time to the model', async () => {
    await extractor.extractEntry(entry('e1', 'Went for a run this morning.'));
    expect(modelClient.calls).toHaveLength(1);
    expect(modelClient.calls[0]!.prompt).toContain('Went for a run this morning.');
    expect(modelClient.calls[0]!.prompt).toContain('2026-07-20T09:00:00+01:00');
  });

  it('stores a record for each metric the model returns', async () => {
    modelClient.result = {
      metrics: [
        { metric: 'exercise', eventTime: '2026-07-20T07:00:00+01:00', eventTimeExplicit: true, detail: 'a run' },
      ],
    };
    await extractor.extractEntry(entry('e1', 'Went for a run this morning.'));

    const [record] = metricsIndex.list({ limit: 10 });
    expect(record).toMatchObject({
      entryId: 'e1',
      metric: 'exercise',
      eventTime: '2026-07-20T07:00:00+01:00',
      eventTimeExplicit: true,
      detail: 'a run',
    });
  });

  it('stores nothing when the model finds nothing', async () => {
    modelClient.result = { metrics: [] };
    await extractor.extractEntry(entry('e1', 'A day with nothing notable.'));
    expect(metricsIndex.list({ limit: 10 })).toEqual([]);
  });

  it('falls back to the entry’s own written time when the model returns a malformed eventTime', async () => {
    modelClient.result = {
      metrics: [{ metric: 'sleep', eventTime: 'not a timestamp', eventTimeExplicit: true, detail: 'ok' }],
    };
    await extractor.extractEntry(entry('e1', 'Slept fine.', '2026-07-20T09:00:00+01:00'));

    const [record] = metricsIndex.list({ limit: 10 });
    expect(record!.eventTime).toBe('2026-07-20T09:00:00+01:00');
    // The model's claim of "explicit" is not trusted once its own time
    // could not be parsed — falling back silently while still calling it
    // explicit would misrepresent where the timestamp actually came from.
    expect(record!.eventTimeExplicit).toBe(false);
  });

  it('replaces old records for an entry rather than accumulating them', async () => {
    modelClient.result = {
      metrics: [{ metric: 'exercise', eventTime: '2026-07-20T07:00:00+01:00', eventTimeExplicit: true, detail: 'run' }],
    };
    await extractor.extractEntry(entry('e1', 'Went for a run.'));

    modelClient.result = {
      metrics: [{ metric: 'sleep', eventTime: '2026-07-20T23:00:00+01:00', eventTimeExplicit: true, detail: 'early night' }],
    };
    await extractor.extractEntry(entry('e1', 'Revised: went to bed early instead.'));

    const records = metricsIndex.list({ limit: 10 });
    expect(records).toHaveLength(1);
    expect(records[0]!.metric).toBe('sleep');
  });

  it('records a suggested category without inventing a metric record for it', async () => {
    modelClient.result = {
      metrics: [],
      suggestedCategory: { name: 'meditation', reason: 'mentioned a 10-minute meditation' },
    };
    await extractor.extractEntry(entry('e1', 'Did a 10-minute meditation.'));

    expect(metricsIndex.list({ limit: 10 })).toEqual([]);
    const suggestions = categoriesIndex.listSuggestions();
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({
      structureType: 'metric',
      name: 'meditation',
      reason: 'mentioned a 10-minute meditation',
      entryId: 'e1',
      status: 'pending',
    });
  });

  it('does not record a suggestion when the model returns none', async () => {
    modelClient.result = { metrics: [] };
    await extractor.extractEntry(entry('e1', 'Nothing notable.'));
    expect(categoriesIndex.listSuggestions()).toEqual([]);
  });

  it('sends the currently approved category names to the model', async () => {
    categoriesIndex.approveDirectly('metric', 'meditation', '2026-01-01T00:00:00Z');
    await extractor.extractEntry(entry('e1', 'Did a 10-minute meditation.'));
    expect(modelClient.calls[0]!.system).toContain('meditation');
    expect(modelClient.calls[0]!.system).toContain('exercise');
  });

  it('gives every record a distinct id, even within the same extraction', async () => {
    modelClient.result = {
      metrics: [
        { metric: 'exercise', eventTime: '2026-07-20T07:00:00+01:00', eventTimeExplicit: true, detail: 'run' },
        { metric: 'sleep', eventTime: '2026-07-20T23:00:00+01:00', eventTimeExplicit: true, detail: 'nap' },
      ],
    };
    await extractor.extractEntry(entry('e1', 'A busy day.'));
    const records = metricsIndex.list({ limit: 10 });
    expect(new Set(records.map((r) => r.id)).size).toBe(2);
  });
});

describe('removeEntry', () => {
  it('delegates straight to the index', async () => {
    modelClient.result = {
      metrics: [{ metric: 'exercise', eventTime: '2026-07-20T07:00:00+01:00', eventTimeExplicit: true, detail: 'run' }],
    };
    await extractor.extractEntry(entry('e1', 'Went for a run.'));
    extractor.removeEntry('e1');
    expect(metricsIndex.list({ limit: 10 })).toEqual([]);
  });
});

describe('reprocessAll', () => {
  it('extracts every entry across multiple pages', async () => {
    modelClient.result = {
      metrics: [{ metric: 'sleep', eventTime: '2026-07-20T23:00:00+01:00', eventTimeExplicit: false, detail: '' }],
    };
    const store = new FakeEntryStore([entry('e1', 'a'), entry('e2', 'b'), entry('e3', 'c')]);

    const result = await extractor.reprocessAll(store);

    expect(result).toEqual({ entryCount: 3, metricCount: 3 });
  });

  it('clears whatever was extracted before starting', async () => {
    await extractor.extractEntry(entry('stale', 'leftover from before a reprocess'));
    modelClient.result = { metrics: [] };
    const store = new FakeEntryStore([entry('e1', 'fresh')]);

    await extractor.reprocessAll(store);

    expect(metricsIndex.stats()).toEqual({ metricCount: 0 });
  });

  it('skips an entry that vanished between list and get', async () => {
    const store = new FakeEntryStore([entry('e1', 'still here')]);
    const originalGet = store.get.bind(store);
    store.get = async (id: string) => (id === 'e1' ? null : originalGet(id));

    const result = await extractor.reprocessAll(store);
    expect(result).toEqual({ entryCount: 0, metricCount: 0 });
  });
});
