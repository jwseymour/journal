import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MetricsIndex, type TemporalMetricRecord } from '../../src/index/metrics-index.js';

let index: MetricsIndex;

beforeEach(() => {
  index = new MetricsIndex(':memory:');
});

afterEach(() => {
  index.close();
});

const record = (overrides: Partial<Omit<TemporalMetricRecord, 'entryId'>> = {}): Omit<TemporalMetricRecord, 'entryId'> => ({
  id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  metric: 'exercise',
  eventTime: '2026-07-20T09:00:00+01:00',
  eventEpochMs: Date.parse('2026-07-20T08:00:00Z'),
  eventTimeExplicit: true,
  detail: 'a 5k run',
  fields: {},
  extractedAt: '2026-07-20T10:00:00+01:00',
  touched: false,
  ...overrides,
});

describe('replaceEntry / list', () => {
  it('stores a record and lists it back', () => {
    index.replaceEntry('e1', [record()]);
    const [row] = index.list({ limit: 10 });
    expect(row).toEqual({ entryId: 'e1', ...record() });
  });

  it('is empty, not an error, when nothing has been extracted', () => {
    expect(index.list({ limit: 10 })).toEqual([]);
  });

  it('orders newest event first', () => {
    index.replaceEntry('e1', [record({ id: 'm1', eventEpochMs: 1000 })]);
    index.replaceEntry('e2', [record({ id: 'm2', eventEpochMs: 3000 })]);
    index.replaceEntry('e3', [record({ id: 'm3', eventEpochMs: 2000 })]);

    expect(index.list({ limit: 10 }).map((r) => r.id)).toEqual(['m2', 'm3', 'm1']);
  });

  it('filters by metric', () => {
    index.replaceEntry('e1', [record({ id: 'm1', metric: 'exercise' })]);
    index.replaceEntry('e2', [record({ id: 'm2', metric: 'sleep' })]);

    expect(index.list({ metric: 'sleep', limit: 10 }).map((r) => r.id)).toEqual(['m2']);
  });

  it('respects the limit', () => {
    index.replaceEntry('e1', [record({ id: 'm1' })]);
    index.replaceEntry('e2', [record({ id: 'm2' })]);
    expect(index.list({ limit: 1 })).toHaveLength(1);
  });

  it('replaces the previous records for an entry entirely on a second call', () => {
    index.replaceEntry('e1', [record({ id: 'm1', detail: 'first' })]);
    index.replaceEntry('e1', [record({ id: 'm2', detail: 'second' })]);

    const rows = index.list({ limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.detail).toBe('second');
  });

  it('stores every record for an entry when an entry produces more than one', () => {
    index.replaceEntry('e1', [
      record({ id: 'm1', metric: 'exercise', detail: 'run' }),
      record({ id: 'm2', metric: 'sleep', detail: 'nap' }),
    ]);
    expect(index.list({ limit: 10 })).toHaveLength(2);
  });

  it('round-trips eventTimeExplicit false correctly', () => {
    index.replaceEntry('e1', [record({ eventTimeExplicit: false })]);
    expect(index.list({ limit: 10 })[0]!.eventTimeExplicit).toBe(false);
  });

  it('round-trips structured field values — numbers, strings, and nulls', () => {
    index.replaceEntry('e1', [record({ fields: { distance_km: 8.4, sport: 'rowing', intensity: null } })]);
    expect(index.list({ limit: 10 })[0]!.fields).toEqual({ distance_km: 8.4, sport: 'rowing', intensity: null });
  });

  it('defaults to an empty fields object when a metric has none defined', () => {
    index.replaceEntry('e1', [record()]);
    expect(index.list({ limit: 10 })[0]!.fields).toEqual({});
  });
});

describe('removeEntry', () => {
  it('removes every record belonging to that entry, and no others', () => {
    index.replaceEntry('e1', [record({ id: 'm1' })]);
    index.replaceEntry('e2', [record({ id: 'm2' })]);

    index.removeEntry('e1');

    expect(index.list({ limit: 10 }).map((r) => r.id)).toEqual(['m2']);
  });
});

describe('remove', () => {
  it('discards one record by id, leaving the rest of the entry alone', () => {
    index.replaceEntry('e1', [record({ id: 'm1' }), record({ id: 'm2' })]);
    index.remove('m1');
    expect(index.list({ limit: 10 }).map((r) => r.id)).toEqual(['m2']);
  });

  it('is a no-op, not an error, for an id that does not exist', () => {
    expect(() => index.remove('never-existed')).not.toThrow();
  });
});

describe('stats / clear', () => {
  it('counts records across every entry', () => {
    index.replaceEntry('e1', [record({ id: 'm1' }), record({ id: 'm2' })]);
    index.replaceEntry('e2', [record({ id: 'm3' })]);
    expect(index.stats()).toEqual({ metricCount: 3 });
  });

  it('wipes everything', () => {
    index.replaceEntry('e1', [record()]);
    index.clear();
    expect(index.stats()).toEqual({ metricCount: 0 });
    expect(index.list({ limit: 10 })).toEqual([]);
  });
});

describe('touching a record (`plan.md` M10)', () => {
  it('update() edits the given fields and sets touched, leaving the rest alone', () => {
    index.replaceEntry('e1', [record({ id: 'm1', detail: 'first draft', fields: { distance_km: 5 } })]);
    const updated = index.update('m1', { detail: 'corrected' }, 'now');
    expect(updated).toMatchObject({ id: 'm1', detail: 'corrected', fields: { distance_km: 5 }, touched: true });
    expect(index.list({ limit: 10 })[0]).toMatchObject({ detail: 'corrected', touched: true });
  });

  it('update() returns null for an id that does not exist', () => {
    expect(index.update('never-existed', { detail: 'x' }, 'now')).toBeNull();
  });

  it('validate() marks touched with no content change', () => {
    index.replaceEntry('e1', [record({ id: 'm1', detail: 'unchanged' })]);
    index.validate('m1', 'now');
    expect(index.list({ limit: 10 })[0]).toMatchObject({ detail: 'unchanged', touched: true });
  });

  it('validate() is a no-op, not an error, for an id that does not exist', () => {
    expect(() => index.validate('never-existed', 'now')).not.toThrow();
  });

  it('untouch() reverts a touched record back to untouched', () => {
    index.replaceEntry('e1', [record({ id: 'm1' })]);
    index.validate('m1', 'now');
    index.untouch('m1', 'now');
    expect(index.list({ limit: 10 })[0]!.touched).toBe(false);
  });

  it('touchedForEntry() returns only the touched rows for that entry', () => {
    index.replaceEntry('e1', [record({ id: 'm1' }), record({ id: 'm2' })]);
    index.validate('m1', 'now');
    expect(index.touchedForEntry('e1').map((r) => r.id)).toEqual(['m1']);
  });
});

describe('replaceUntouchedForEntry (`plan.md` M10)', () => {
  it('leaves a touched row alone and replaces the untouched rows around it', () => {
    index.replaceEntry('e1', [record({ id: 'm1', detail: 'keep me' }), record({ id: 'm2', detail: 'stale' })]);
    index.validate('m1', 'now');

    index.replaceUntouchedForEntry('e1', [record({ id: 'm3', detail: 'fresh' })]);

    const rows = index.list({ limit: 10 });
    expect(rows.map((r) => r.id).sort()).toEqual(['m1', 'm3']);
    expect(rows.find((r) => r.id === 'm1')).toMatchObject({ detail: 'keep me', touched: true });
    expect(rows.find((r) => r.id === 'm3')).toMatchObject({ detail: 'fresh', touched: false });
  });

  it('replaces everything for an entry with no touched rows, same as replaceEntry', () => {
    index.replaceEntry('e1', [record({ id: 'm1' })]);
    index.replaceUntouchedForEntry('e1', [record({ id: 'm2' })]);
    expect(index.list({ limit: 10 }).map((r) => r.id)).toEqual(['m2']);
  });
});

describe('update suggestions (`plan.md` M10)', () => {
  it('propose then approve applies the proposed fields via update(), staying touched', () => {
    index.replaceEntry('e1', [record({ id: 'm1', detail: 'original' })]);
    index.validate('m1', 'now');

    index.proposeUpdate({
      id: 's1',
      recordId: 'm1',
      entryId: 'e1',
      detail: 'reprocessed differently',
      fields: {},
      eventTime: record().eventTime,
      eventEpochMs: record().eventEpochMs,
      eventTimeExplicit: true,
      reason: 'Reprocessing this entry now extracts different content.',
      now: 'suggested-now',
    });

    expect(index.listUpdateSuggestions()).toHaveLength(1);
    expect(index.listUpdateSuggestions({ status: 'pending' })[0]).toMatchObject({ recordId: 'm1', status: 'pending' });

    index.decideUpdate('s1', 'approved', 'decided-now');

    expect(index.listUpdateSuggestions({ status: 'pending' })).toHaveLength(0);
    expect(index.list({ limit: 10 })[0]).toMatchObject({ detail: 'reprocessed differently', touched: true });
  });

  it('rejecting leaves the touched record exactly as it was', () => {
    index.replaceEntry('e1', [record({ id: 'm1', detail: 'original' })]);
    index.validate('m1', 'now');
    index.proposeUpdate({
      id: 's1',
      recordId: 'm1',
      entryId: 'e1',
      detail: 'proposed change',
      fields: {},
      eventTime: record().eventTime,
      eventEpochMs: record().eventEpochMs,
      eventTimeExplicit: true,
      reason: 'reason',
      now: 'now',
    });

    index.decideUpdate('s1', 'rejected', 'now');

    expect(index.list({ limit: 10 })[0]).toMatchObject({ detail: 'original', touched: true });
    expect(index.listUpdateSuggestions()[0]!.status).toBe('rejected');
  });

  it('does not file a second pending suggestion for the same record', () => {
    index.replaceEntry('e1', [record({ id: 'm1' })]);
    index.validate('m1', 'now');
    const propose = () =>
      index.proposeUpdate({
        id: `s-${Math.random()}`,
        recordId: 'm1',
        entryId: 'e1',
        detail: 'x',
        fields: {},
        eventTime: record().eventTime,
        eventEpochMs: record().eventEpochMs,
        eventTimeExplicit: true,
        reason: 'reason',
        now: 'now',
      });
    propose();
    propose();
    expect(index.listUpdateSuggestions()).toHaveLength(1);
  });
});

describe('clearUntouched (`plan.md` M10)', () => {
  it('wipes untouched rows but leaves a touched row in place', () => {
    index.replaceEntry('e1', [record({ id: 'm1' })]);
    index.replaceEntry('e2', [record({ id: 'm2' })]);
    index.validate('m1', 'now');

    index.clearUntouched();

    expect(index.list({ limit: 10 }).map((r) => r.id)).toEqual(['m1']);
  });

  it('clear() (the pre-M10 primitive) still wipes everything, touched or not', () => {
    index.replaceEntry('e1', [record({ id: 'm1' })]);
    index.validate('m1', 'now');
    index.clear();
    expect(index.list({ limit: 10 })).toEqual([]);
  });
});

describe('persistence', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'journal-metrics-index-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('survives a close and reopen against the same file', async () => {
    const dbPath = join(root, 'index.db');
    const first = new MetricsIndex(dbPath);
    first.replaceEntry('e1', [record()]);
    first.close();

    const reopened = new MetricsIndex(dbPath);
    expect(reopened.list({ limit: 10 })).toEqual([{ entryId: 'e1', ...record() }]);
    reopened.close();
  });
});

describe('summarize', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  // A fixed "now" so the window is deterministic across test runs.
  const NOW = Date.parse('2026-07-20T12:00:00Z');

  it('gives a zero-filled tile for a category with no occurrences at all', () => {
    const [summary] = index.summarize(['exercise'], 7, NOW);
    expect(summary).toMatchObject({ metric: 'exercise', totalCount: 0 });
    expect(summary!.days).toHaveLength(7);
    expect(summary!.days.every((d) => d.count === 0)).toBe(true);
  });

  it('counts an occurrence on the correct UTC day', () => {
    index.replaceEntry('e1', [record({ eventEpochMs: NOW })]);
    const [summary] = index.summarize(['exercise'], 7, NOW);
    const today = summary!.days.at(-1)!;
    expect(today.date).toBe('2026-07-20');
    expect(today.count).toBe(1);
  });

  it('excludes an occurrence outside the window from the days, but not from totalCount', () => {
    index.replaceEntry('e1', [record({ eventEpochMs: NOW - 30 * DAY_MS })]);
    const [summary] = index.summarize(['exercise'], 7, NOW);
    expect(summary!.totalCount).toBe(1);
    expect(summary!.days.every((d) => d.count === 0)).toBe(true);
  });

  it('orders days oldest first, ending on "now"', () => {
    const [summary] = index.summarize(['exercise'], 3, NOW);
    expect(summary!.days.map((d) => d.date)).toEqual(['2026-07-18', '2026-07-19', '2026-07-20']);
  });

  it('returns one summary per approved name, in the order given, even with mixed data', () => {
    index.replaceEntry('e1', [record({ id: 'm1', metric: 'sleep', eventEpochMs: NOW })]);
    const summaries = index.summarize(['exercise', 'sleep'], 7, NOW);
    expect(summaries.map((s) => s.metric)).toEqual(['exercise', 'sleep']);
    expect(summaries[0]!.totalCount).toBe(0);
    expect(summaries[1]!.totalCount).toBe(1);
  });

  it('sums more than one occurrence on the same day', () => {
    index.replaceEntry('e1', [record({ id: 'm1', eventEpochMs: NOW })]);
    index.replaceEntry('e2', [record({ id: 'm2', eventEpochMs: NOW - 1000 })]);
    const [summary] = index.summarize(['exercise'], 7, NOW);
    expect(summary!.days.at(-1)!.count).toBe(2);
  });
});

describe('sumByField', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const NOW = Date.parse('2026-07-20T12:00:00Z');

  it("answers the user's own example — total distance for one sport, filtered", () => {
    index.replaceEntry('e1', [
      record({ id: 'm1', metric: 'exercise', eventEpochMs: NOW, fields: { distance_km: 8, sport: 'rowing' } }),
    ]);
    index.replaceEntry('e2', [
      record({ id: 'm2', metric: 'exercise', eventEpochMs: NOW - DAY_MS, fields: { distance_km: 5, sport: 'running' } }),
    ]);
    index.replaceEntry('e3', [
      record({ id: 'm3', metric: 'exercise', eventEpochMs: NOW - 2 * DAY_MS, fields: { distance_km: 12, sport: 'rowing' } }),
    ]);

    const summary = index.sumByField('exercise', 'distance_km', 7, { field: 'sport', value: 'rowing' }, NOW);

    expect(summary.total).toBe(20);
    expect(summary.count).toBe(2);
    expect(summary.average).toBe(10);
  });

  it('gives a zero total, not an error, when nothing has been recorded', () => {
    const summary = index.sumByField('exercise', 'distance_km', 7, undefined, NOW);
    expect(summary).toEqual({ total: 0, average: 0, count: 0, days: summary.days });
    expect(summary.days).toHaveLength(7);
    expect(summary.days.every((d) => d.value === 0)).toBe(true);
  });

  it('excludes a null field value from both the total and the count', () => {
    index.replaceEntry('e1', [record({ id: 'm1', eventEpochMs: NOW, fields: { distance_km: 8 } })]);
    index.replaceEntry('e2', [record({ id: 'm2', eventEpochMs: NOW, fields: { distance_km: null } })]);

    const summary = index.sumByField('exercise', 'distance_km', 7, undefined, NOW);
    expect(summary.total).toBe(8);
    expect(summary.count).toBe(1);
  });

  it('excludes an occurrence outside the window from the days, but not from the total', () => {
    index.replaceEntry('e1', [record({ eventEpochMs: NOW - 30 * DAY_MS, fields: { distance_km: 8 } })]);
    const summary = index.sumByField('exercise', 'distance_km', 7, undefined, NOW);
    expect(summary.total).toBe(8);
    expect(summary.days.every((d) => d.value === 0)).toBe(true);
  });

  it('sums more than one occurrence on the same day', () => {
    index.replaceEntry('e1', [record({ id: 'm1', eventEpochMs: NOW, fields: { distance_km: 3 } })]);
    index.replaceEntry('e2', [record({ id: 'm2', eventEpochMs: NOW - 1000, fields: { distance_km: 4 } })]);
    const summary = index.sumByField('exercise', 'distance_km', 7, undefined, NOW);
    expect(summary.days.at(-1)!.value).toBe(7);
  });

  it('orders days oldest first, ending on "now"', () => {
    const summary = index.sumByField('exercise', 'distance_km', 3, undefined, NOW);
    expect(summary.days.map((d) => d.date)).toEqual(['2026-07-18', '2026-07-19', '2026-07-20']);
  });

  it('only sums fields belonging to the given metric', () => {
    index.replaceEntry('e1', [record({ id: 'm1', metric: 'exercise', eventEpochMs: NOW, fields: { distance_km: 8 } })]);
    index.replaceEntry('e2', [record({ id: 'm2', metric: 'cycling', eventEpochMs: NOW, fields: { distance_km: 100 } })]);
    const summary = index.sumByField('exercise', 'distance_km', 7, undefined, NOW);
    expect(summary.total).toBe(8);
  });
});

describe('restoreTouched (durable/touched-mirror.ts)', () => {
  it('inserts a record read back from the durable mirror into an index that never had it', () => {
    index.restoreTouched({ entryId: 'e1', ...record({ touched: true }) });
    expect(index.getById('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toEqual({ entryId: 'e1', ...record({ touched: true }) });
  });

  it('is idempotent — restoring the same record twice leaves exactly one row', () => {
    index.restoreTouched({ entryId: 'e1', ...record({ touched: true }) });
    index.restoreTouched({ entryId: 'e1', ...record({ touched: true }) });
    expect(index.list({ limit: 10 })).toHaveLength(1);
  });

  it('always writes touched = 1, even if the mirrored record somehow said otherwise', () => {
    index.restoreTouched({ entryId: 'e1', ...record({ touched: false }) });
    expect(index.getById('01ARZ3NDEKTSV4RRFFQ69G5FAV')!.touched).toBe(true);
  });
});
