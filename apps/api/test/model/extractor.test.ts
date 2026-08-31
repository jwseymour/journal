import { beforeEach, describe, expect, it } from 'vitest';
import { CategoriesIndex } from '../../src/index/categories-index.js';
import { MetricFieldsIndex } from '../../src/index/metric-fields-index.js';
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
  listPeriods(): Promise<never> {
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
let metricFieldsIndex: MetricFieldsIndex;
let categoriesIndex: CategoriesIndex;
let modelClient: FakeModelClient;
let extractor: Extractor;

beforeEach(() => {
  metricsIndex = new MetricsIndex(':memory:');
  metricFieldsIndex = new MetricFieldsIndex(':memory:');
  categoriesIndex = new CategoriesIndex(':memory:');
  categoriesIndex.seed('metric', METRIC_SEED_NAMES, '2026-01-01T00:00:00Z');
  modelClient = new FakeModelClient();
  extractor = new Extractor(metricsIndex, metricFieldsIndex, categoriesIndex, modelClient);
});

describe('extractCandidates', () => {
  it('shapes model output into candidates without writing to the index', async () => {
    modelClient.result = {
      metrics: [
        { metric: 'exercise', eventTime: '2026-07-20T07:00:00+01:00', eventTimeExplicit: true, detail: 'a run', fields: {}, confidence: 'medium', confidenceReason: 'implied by "went out"' },
      ],
    };
    const result = await extractor.extractCandidates(entry('e1', 'Went out this morning.'));

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      metric: 'exercise',
      detail: 'a run',
      confidence: 'medium',
      confidenceReason: 'implied by "went out"',
    });
    // The whole point of `extractCandidates` — nothing committed yet.
    expect(metricsIndex.list({ limit: 10 })).toEqual([]);
  });

  it('passes suggestedCategory/Field/FieldValue through untouched', async () => {
    modelClient.result = {
      metrics: [],
      suggestedCategory: { name: 'meditation', reason: 'mentioned repeatedly' },
    };
    const result = await extractor.extractCandidates(entry('e1', 'Meditated for 10 minutes.'));

    expect(result.suggestedCategory).toEqual({ name: 'meditation', reason: 'mentioned repeatedly' });
    // Still nothing committed — `extractCandidates` never calls `suggest()`.
    expect(categoriesIndex.listSuggestions()).toEqual([]);
  });

  it('shares one extractedAt across every candidate in the same call', async () => {
    modelClient.result = {
      metrics: [
        { metric: 'exercise', eventTime: '2026-07-20T07:00:00+01:00', eventTimeExplicit: true, detail: 'a run', fields: {}, confidence: 'high', confidenceReason: null },
        { metric: 'sleep', eventTime: '2026-07-20T23:00:00+01:00', eventTimeExplicit: true, detail: 'ok', fields: {}, confidence: 'high', confidenceReason: null },
      ],
    };
    const result = await extractor.extractCandidates(entry('e1', 'x'));

    expect(result.candidates[0]!.extractedAt).toBe(result.extractedAt);
    expect(result.candidates[1]!.extractedAt).toBe(result.extractedAt);
  });

  it('extractEntry still produces the exact same committed records as before this split', async () => {
    modelClient.result = {
      metrics: [
        { metric: 'exercise', eventTime: '2026-07-20T07:00:00+01:00', eventTimeExplicit: true, detail: 'a run', fields: {}, confidence: 'low', confidenceReason: 'guessed' },
      ],
    };
    await extractor.extractEntry(entry('e1', 'Went out.'));

    const [record] = metricsIndex.list({ limit: 10 });
    // Confidence never reaches the committed record — it is not a field on
    // `TemporalMetricRecord` at all.
    expect(record).not.toHaveProperty('confidence');
    expect(record).not.toHaveProperty('confidenceReason');
    expect(record).toMatchObject({ metric: 'exercise', detail: 'a run', touched: false });
  });
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
        { metric: 'exercise', eventTime: '2026-07-20T07:00:00+01:00', eventTimeExplicit: true, detail: 'a run', fields: {}, confidence: 'high', confidenceReason: null },
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
      metrics: [{ metric: 'sleep', eventTime: 'not a timestamp', eventTimeExplicit: true, detail: 'ok', fields: {}, confidence: 'high', confidenceReason: null }],
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
      metrics: [{ metric: 'exercise', eventTime: '2026-07-20T07:00:00+01:00', eventTimeExplicit: true, detail: 'run', fields: {}, confidence: 'high', confidenceReason: null }],
    };
    await extractor.extractEntry(entry('e1', 'Went for a run.'));

    modelClient.result = {
      metrics: [{ metric: 'sleep', eventTime: '2026-07-20T23:00:00+01:00', eventTimeExplicit: true, detail: 'early night', fields: {}, confidence: 'high', confidenceReason: null }],
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
        { metric: 'exercise', eventTime: '2026-07-20T07:00:00+01:00', eventTimeExplicit: true, detail: 'run', fields: {}, confidence: 'high', confidenceReason: null },
        { metric: 'sleep', eventTime: '2026-07-20T23:00:00+01:00', eventTimeExplicit: true, detail: 'nap', fields: {}, confidence: 'high', confidenceReason: null },
      ],
    };
    await extractor.extractEntry(entry('e1', 'A busy day.'));
    const records = metricsIndex.list({ limit: 10 });
    expect(new Set(records.map((r) => r.id)).size).toBe(2);
  });
});

describe('structured fields', () => {
  it('sends a defined field to the model, described in the system prompt', async () => {
    metricFieldsIndex.define({
      id: 'f1',
      metric: 'exercise',
      fieldKey: 'distance_km',
      label: 'Distance',
      fieldType: 'numeric',
      unit: 'km',
      scoreMin: null,
      scoreMax: null,
      description: 'How far the run covered.',
      now: '2026-01-01T00:00:00Z',
    });

    await extractor.extractEntry(entry('e1', 'Ran 8k this morning.'));

    expect(modelClient.calls[0]!.system).toContain('distance_km');
    expect(modelClient.calls[0]!.system).toContain('How far the run covered.');
  });

  it('stores whatever structured field values the model returns', async () => {
    metricFieldsIndex.define({
      id: 'f1',
      metric: 'exercise',
      fieldKey: 'distance_km',
      label: 'Distance',
      fieldType: 'numeric',
      unit: 'km',
      scoreMin: null,
      scoreMax: null,
      description: 'How far, in km.',
      now: '2026-01-01T00:00:00Z',
    });
    modelClient.result = {
      metrics: [
        {
          metric: 'exercise',
          eventTime: '2026-07-20T07:00:00+01:00',
          eventTimeExplicit: true,
          detail: 'ran 8k',
          fields: { distance_km: 8 }, confidence: 'high', confidenceReason: null,
        },
      ],
    };

    await extractor.extractEntry(entry('e1', 'Ran 8k this morning.'));

    const [record] = metricsIndex.list({ limit: 10 });
    expect(record!.fields).toEqual({ distance_km: 8 });
  });

  it('records a suggested field without inventing a definition for it', async () => {
    modelClient.result = {
      metrics: [],
      suggestedField: {
        metric: 'exercise',
        fieldKey: 'pace_min_per_km',
        label: 'Pace',
        fieldType: 'numeric',
        unit: 'min/km',
        description: 'How fast, in minutes per km.',
        reason: 'pace mentioned repeatedly',
      },
    };

    await extractor.extractEntry(entry('e1', 'Ran at a 5 min/km pace.'));

    expect(metricFieldsIndex.listForMetric('exercise')).toEqual([]);
    const suggestions = metricFieldsIndex.listSuggestions();
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({
      metric: 'exercise',
      fieldKey: 'pace_min_per_km',
      reason: 'pace mentioned repeatedly',
      entryId: 'e1',
      status: 'pending',
    });
  });

  it('does not record a field suggestion when the model returns none', async () => {
    modelClient.result = { metrics: [] };
    await extractor.extractEntry(entry('e1', 'Nothing notable.'));
    expect(metricFieldsIndex.listSuggestions()).toEqual([]);
  });

  it('records a suggested value for an existing enum field', async () => {
    metricFieldsIndex.define({
      id: 'f1',
      metric: 'exercise',
      fieldKey: 'sport',
      label: 'Sport',
      fieldType: 'enum',
      unit: null,
      scoreMin: null,
      scoreMax: null,
      description: 'Which sport.',
      now: '2026-01-01T00:00:00Z',
    });
    modelClient.result = {
      metrics: [],
      suggestedFieldValue: { metric: 'exercise', fieldKey: 'sport', value: 'climbing', reason: 'first time mentioned' },
    };

    await extractor.extractEntry(entry('e1', 'Went climbing for the first time.'));

    const suggestions = categoriesIndex.listSuggestions();
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({
      structureType: 'metric_field:exercise:sport',
      name: 'climbing',
      reason: 'first time mentioned',
      entryId: 'e1',
      status: 'pending',
    });
  });

  it('never trusts a suggested field value for a field that does not really exist', async () => {
    modelClient.result = {
      metrics: [],
      suggestedFieldValue: { metric: 'exercise', fieldKey: 'not-a-real-field', value: 'climbing', reason: 'x' },
    };
    await extractor.extractEntry(entry('e1', 'Went climbing.'));
    expect(categoriesIndex.listSuggestions()).toEqual([]);
  });

  it('never trusts a suggested field value naming a non-enum field', async () => {
    metricFieldsIndex.define({
      id: 'f1',
      metric: 'exercise',
      fieldKey: 'distance_km',
      label: 'Distance',
      fieldType: 'numeric',
      unit: 'km',
      scoreMin: null,
      scoreMax: null,
      description: 'How far.',
      now: '2026-01-01T00:00:00Z',
    });
    modelClient.result = {
      metrics: [],
      suggestedFieldValue: { metric: 'exercise', fieldKey: 'distance_km', value: '8', reason: 'x' },
    };
    await extractor.extractEntry(entry('e1', 'Ran 8k.'));
    expect(categoriesIndex.listSuggestions()).toEqual([]);
  });

  it('lists the approved enum values in the system prompt', async () => {
    metricFieldsIndex.define({
      id: 'f1',
      metric: 'exercise',
      fieldKey: 'sport',
      label: 'Sport',
      fieldType: 'enum',
      unit: null,
      scoreMin: null,
      scoreMax: null,
      description: 'Which sport.',
      now: '2026-01-01T00:00:00Z',
    });
    categoriesIndex.approveDirectly('metric_field:exercise:sport', 'rowing', '2026-01-01T00:00:00Z');

    await extractor.extractEntry(entry('e1', 'Went rowing.'));

    expect(modelClient.calls[0]!.system).toContain('rowing');
  });
});

describe('touched-record protection during reprocess (`plan.md` M10)', () => {
  it('a touched record survives reprocessAll unchanged, and an untouched sibling is still replaced', async () => {
    modelClient.result = {
      metrics: [
        { metric: 'exercise', eventTime: '2026-07-20T07:00:00+01:00', eventTimeExplicit: true, detail: 'a run', fields: {}, confidence: 'high', confidenceReason: null },
        { metric: 'sleep', eventTime: '2026-07-20T23:00:00+01:00', eventTimeExplicit: true, detail: 'ok', fields: {}, confidence: 'high', confidenceReason: null },
      ],
    };
    await extractor.extractEntry(entry('e1', 'Went for a run, slept fine.'));

    const [run, sleep] = metricsIndex.list({ limit: 10 }).sort((a, b) => (a.metric < b.metric ? -1 : 1));
    metricsIndex.update(run!.id, { detail: 'my own correction' }, 'now');

    // Reprocessing this entry again would now find a different fresh
    // candidate set than what's stored (two records vs. the touched pair),
    // so per the "clean 1:1 match only" rule, nothing is proposed and both
    // untouched records are simply replaced — but the touched one survives.
    modelClient.result = {
      metrics: [
        { metric: 'exercise', eventTime: '2026-07-20T07:00:00+01:00', eventTimeExplicit: true, detail: 'a run', fields: {}, confidence: 'high', confidenceReason: null },
        { metric: 'sleep', eventTime: '2026-07-20T23:00:00+01:00', eventTimeExplicit: true, detail: 'ok', fields: {}, confidence: 'high', confidenceReason: null },
        { metric: 'sleep', eventTime: '2026-07-20T23:30:00+01:00', eventTimeExplicit: true, detail: 'woke once', fields: {}, confidence: 'high', confidenceReason: null },
      ],
    };
    const store = new FakeEntryStore([entry('e1', 'Went for a run, slept fine, woke once.')]);
    await extractor.reprocessAll(store);

    const rows = metricsIndex.list({ limit: 10 });
    const kept = rows.find((r) => r.detail === 'my own correction');
    expect(kept).toMatchObject({ touched: true });
    expect(rows).toHaveLength(4); // the touched record, plus 3 freshly (re)extracted
  });

  it('a clean 1:1 touched match proposes an update instead of overwriting, and inserts nothing new untouched', async () => {
    modelClient.result = {
      metrics: [{ metric: 'exercise', eventTime: '2026-07-20T07:00:00+01:00', eventTimeExplicit: true, detail: 'a run', fields: {}, confidence: 'high', confidenceReason: null }],
    };
    await extractor.extractEntry(entry('e1', 'Went for a run.'));
    const [original] = metricsIndex.list({ limit: 10 });
    metricsIndex.update(original!.id, { detail: 'my own correction' }, 'now');

    modelClient.result = {
      metrics: [{ metric: 'exercise', eventTime: '2026-07-20T07:00:00+01:00', eventTimeExplicit: true, detail: 'a jog', fields: {}, confidence: 'high', confidenceReason: null }],
    };
    const store = new FakeEntryStore([entry('e1', 'Went for a jog.')]);
    await extractor.reprocessAll(store);

    const rows = metricsIndex.list({ limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ detail: 'my own correction', touched: true });

    const suggestions = metricsIndex.listUpdateSuggestions();
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({ recordId: original!.id, detail: 'a jog' });
  });

  it('proposes nothing when the fresh extraction agrees with the touched record', async () => {
    modelClient.result = {
      metrics: [{ metric: 'exercise', eventTime: '2026-07-20T07:00:00+01:00', eventTimeExplicit: true, detail: 'a run', fields: {}, confidence: 'high', confidenceReason: null }],
    };
    await extractor.extractEntry(entry('e1', 'Went for a run.'));
    const [original] = metricsIndex.list({ limit: 10 });
    metricsIndex.validate(original!.id, 'now');

    // Same result the second time — nothing has actually changed.
    const store = new FakeEntryStore([entry('e1', 'Went for a run.')]);
    await extractor.reprocessAll(store);

    expect(metricsIndex.listUpdateSuggestions()).toHaveLength(0);
  });
});

describe('removeEntry', () => {
  it('delegates straight to the index', async () => {
    modelClient.result = {
      metrics: [{ metric: 'exercise', eventTime: '2026-07-20T07:00:00+01:00', eventTimeExplicit: true, detail: 'run', fields: {}, confidence: 'high', confidenceReason: null }],
    };
    await extractor.extractEntry(entry('e1', 'Went for a run.'));
    extractor.removeEntry('e1');
    expect(metricsIndex.list({ limit: 10 })).toEqual([]);
  });
});

describe('reprocessAll', () => {
  it('extracts every entry across multiple pages', async () => {
    modelClient.result = {
      metrics: [{ metric: 'sleep', eventTime: '2026-07-20T23:00:00+01:00', eventTimeExplicit: false, detail: '', fields: {}, confidence: 'high', confidenceReason: null }],
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
