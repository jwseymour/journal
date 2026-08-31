import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PendingItemsIndex, type CreatePendingItemInput } from '../../src/index/pending-items-index.js';

let index: PendingItemsIndex;

beforeEach(() => {
  index = new PendingItemsIndex(':memory:');
});

afterEach(() => {
  index.close();
});

const item = (overrides: Partial<CreatePendingItemInput> = {}): CreatePendingItemInput => ({
  id: 'p1',
  entryId: 'e1',
  processRunId: 'r1',
  structureType: 'metric',
  kind: 'new',
  targetRecordId: null,
  category: 'exercise',
  payload: { detail: 'a 5k run' },
  confidence: 'high',
  reason: null,
  createdAt: '2026-07-20T10:00:00+01:00',
  ...overrides,
});

describe('insertBatch / list', () => {
  it('stores items and lists them back, oldest first', () => {
    index.insertBatch([item({ id: 'p1', createdAt: '2026-07-20T10:00:00+01:00' })]);
    index.insertBatch([item({ id: 'p2', createdAt: '2026-07-20T10:00:01+01:00' })]);

    expect(index.list().map((i) => i.id)).toEqual(['p1', 'p2']);
  });

  it('every item starts pending', () => {
    index.insertBatch([item()]);
    expect(index.list()[0]?.status).toBe('pending');
    expect(index.list()[0]?.decidedAt).toBeNull();
  });

  it('round-trips the payload as a real object, not a string', () => {
    index.insertBatch([item({ payload: { detail: 'a 5k run', fields: { distanceKm: 5 } } })]);
    expect(index.list()[0]?.payload).toEqual({ detail: 'a 5k run', fields: { distanceKm: 5 } });
  });

  it('is a no-op on an empty batch', () => {
    index.insertBatch([]);
    expect(index.list()).toEqual([]);
  });

  it('is empty, not an error, when nothing has been extracted', () => {
    expect(index.list()).toEqual([]);
  });

  it('filters by entryId, structureType, and status together', () => {
    index.insertBatch([
      item({ id: 'p1', entryId: 'e1', structureType: 'metric' }),
      item({ id: 'p2', entryId: 'e1', structureType: 'review', category: 'book' }),
      item({ id: 'p3', entryId: 'e2', structureType: 'metric' }),
    ]);
    index.decide('p1', 'approved', '2026-07-20T11:00:00+01:00');

    expect(index.list({ entryId: 'e1' }).map((i) => i.id).sort()).toEqual(['p1', 'p2']);
    expect(index.list({ entryId: 'e1', structureType: 'metric' }).map((i) => i.id)).toEqual(['p1']);
    expect(index.list({ status: 'pending' }).map((i) => i.id).sort()).toEqual(['p2', 'p3']);
  });
});

describe('getById', () => {
  it('finds an item by id', () => {
    index.insertBatch([item({ id: 'p1' })]);
    expect(index.getById('p1')?.id).toBe('p1');
  });

  it('is null for an id that does not exist', () => {
    expect(index.getById('missing')).toBeNull();
  });
});

describe('decide', () => {
  it('approving flips status and sets decidedAt', () => {
    index.insertBatch([item({ id: 'p1' })]);
    const decided = index.decide('p1', 'approved', '2026-07-20T11:00:00+01:00');

    expect(decided).toMatchObject({ id: 'p1', status: 'approved', decidedAt: '2026-07-20T11:00:00+01:00' });
    expect(index.getById('p1')).toMatchObject({ status: 'approved' });
  });

  it('rejecting flips status the same way', () => {
    index.insertBatch([item({ id: 'p1' })]);
    index.decide('p1', 'rejected', '2026-07-20T11:00:00+01:00');
    expect(index.getById('p1')).toMatchObject({ status: 'rejected' });
  });

  it('is null and a no-op for an id that is not currently pending', () => {
    index.insertBatch([item({ id: 'p1' })]);
    index.decide('p1', 'approved', '2026-07-20T11:00:00+01:00');

    const second = index.decide('p1', 'rejected', '2026-07-20T12:00:00+01:00');
    expect(second).toBeNull();
    expect(index.getById('p1')).toMatchObject({ status: 'approved' });
  });

  it('is null for an id that does not exist', () => {
    expect(index.decide('missing', 'approved', '2026-07-20T11:00:00+01:00')).toBeNull();
  });
});

describe('supersedePendingForEntry', () => {
  it('marks other-run pending items for the same entry superseded, leaving this run alone', () => {
    index.insertBatch([item({ id: 'p1', entryId: 'e1', processRunId: 'r1' })]);
    index.insertBatch([item({ id: 'p2', entryId: 'e1', processRunId: 'r2' })]);

    index.supersedePendingForEntry('e1', 'r2', '2026-07-20T11:00:00+01:00');

    expect(index.getById('p1')).toMatchObject({ status: 'superseded', decidedAt: '2026-07-20T11:00:00+01:00' });
    expect(index.getById('p2')).toMatchObject({ status: 'pending' });
  });

  it('leaves already-decided items from an earlier run alone — only undecided leftovers are touched', () => {
    index.insertBatch([item({ id: 'p1', entryId: 'e1', processRunId: 'r1' })]);
    index.decide('p1', 'approved', '2026-07-20T10:30:00+01:00');

    index.insertBatch([item({ id: 'p2', entryId: 'e1', processRunId: 'r2' })]);
    index.supersedePendingForEntry('e1', 'r2', '2026-07-20T11:00:00+01:00');

    expect(index.getById('p1')).toMatchObject({ status: 'approved' });
  });

  it('never touches a different entry', () => {
    index.insertBatch([item({ id: 'p1', entryId: 'e1', processRunId: 'r1' })]);
    index.insertBatch([item({ id: 'p2', entryId: 'e2', processRunId: 'r2' })]);

    index.supersedePendingForEntry('e1', 'r-new', '2026-07-20T11:00:00+01:00');

    expect(index.getById('p2')).toMatchObject({ status: 'pending' });
  });
});

describe('removeEntry', () => {
  it('deletes every item for that entry, regardless of status', () => {
    index.insertBatch([item({ id: 'p1', entryId: 'e1' })]);
    index.insertBatch([item({ id: 'p2', entryId: 'e1' })]);
    index.decide('p1', 'approved', '2026-07-20T11:00:00+01:00');
    index.insertBatch([item({ id: 'p3', entryId: 'e2' })]);

    index.removeEntry('e1');

    expect(index.list().map((i) => i.id)).toEqual(['p3']);
  });
});
