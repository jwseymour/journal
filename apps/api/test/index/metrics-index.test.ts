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
  extractedAt: '2026-07-20T10:00:00+01:00',
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
