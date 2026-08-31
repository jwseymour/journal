import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EntryProcessingStatusIndex } from '../../src/index/entry-processing-status-index.js';

let index: EntryProcessingStatusIndex;

beforeEach(() => {
  index = new EntryProcessingStatusIndex(':memory:');
});

afterEach(() => {
  index.close();
});

describe('get / recordProcessed', () => {
  it('is null for an entry never processed', () => {
    expect(index.get('e1')).toBeNull();
  });

  it('records the hash and timestamp of a successful process run', () => {
    index.recordProcessed('e1', 'hash-a', '2026-07-20T10:00:00+01:00');
    expect(index.get('e1')).toEqual({ entryId: 'e1', lastProcessedContentHash: 'hash-a', lastProcessedAt: '2026-07-20T10:00:00+01:00' });
  });

  it('overwrites on a later process run rather than accumulating rows', () => {
    index.recordProcessed('e1', 'hash-a', '2026-07-20T10:00:00+01:00');
    index.recordProcessed('e1', 'hash-b', '2026-07-20T11:00:00+01:00');
    expect(index.get('e1')).toEqual({ entryId: 'e1', lastProcessedContentHash: 'hash-b', lastProcessedAt: '2026-07-20T11:00:00+01:00' });
  });

  it('tracks entries independently', () => {
    index.recordProcessed('e1', 'hash-a', '2026-07-20T10:00:00+01:00');
    index.recordProcessed('e2', 'hash-c', '2026-07-20T10:05:00+01:00');
    expect(index.get('e1')?.lastProcessedContentHash).toBe('hash-a');
    expect(index.get('e2')?.lastProcessedContentHash).toBe('hash-c');
  });
});

describe('removeEntry', () => {
  it('deletes the row for that entry, leaving others alone', () => {
    index.recordProcessed('e1', 'hash-a', '2026-07-20T10:00:00+01:00');
    index.recordProcessed('e2', 'hash-b', '2026-07-20T10:00:00+01:00');
    index.removeEntry('e1');
    expect(index.get('e1')).toBeNull();
    expect(index.get('e2')).not.toBeNull();
  });

  it('is a tolerant no-op for an entry with no recorded status', () => {
    expect(() => index.removeEntry('missing')).not.toThrow();
  });
});
