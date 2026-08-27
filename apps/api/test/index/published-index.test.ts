import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PublishedIndex, type PublishedRow } from '../../src/index/published-index.js';

let index: PublishedIndex;

beforeEach(() => {
  index = new PublishedIndex(':memory:');
});

afterEach(() => {
  index.close();
});

function row(overrides: Partial<PublishedRow> = {}): PublishedRow {
  return {
    sourceType: 'document',
    sourceId: '01K3F9X2VQ8N7M4TQXYZ8ABCDE',
    mirrorKey: 'public/documents/01K3F9X2VQ8N7M4TQXYZ8ABCDE.json',
    sourceCreatedAt: '2026-07-20T10:00:00+01:00',
    publishedAt: '2026-08-25T09:00:00+01:00',
    sourceHashAtPublish: 'abc123',
    ...overrides,
  };
}

describe('upsert and lookup', () => {
  it('finds a row by (sourceType, sourceId) after inserting it', () => {
    index.upsert(row());
    expect(index.get('document', row().sourceId)?.mirrorKey).toBe(row().mirrorKey);
  });

  it('returns null for a source never published', () => {
    expect(index.get('document', '01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBeNull();
  });

  it('keeps entries and documents of the same id apart', () => {
    index.upsert(row({ sourceType: 'entry', mirrorKey: 'public/entries/x.json' }));
    index.upsert(row({ sourceType: 'document', mirrorKey: 'public/documents/x.json' }));

    expect(index.get('entry', row().sourceId)?.mirrorKey).toBe('public/entries/x.json');
    expect(index.get('document', row().sourceId)?.mirrorKey).toBe('public/documents/x.json');
  });

  it('upserting the same (sourceType, sourceId) updates in place rather than duplicating', () => {
    index.upsert(row({ sourceHashAtPublish: 'first' }));
    index.upsert(row({ sourceHashAtPublish: 'second' }));

    expect(index.listByType('document')).toHaveLength(1);
    expect(index.get('document', row().sourceId)?.sourceHashAtPublish).toBe('second');
  });

  it('isPublished reflects presence', () => {
    expect(index.isPublished('document', row().sourceId)).toBe(false);
    index.upsert(row());
    expect(index.isPublished('document', row().sourceId)).toBe(true);
  });
});

describe('remove', () => {
  it('clears a published row entirely', () => {
    index.upsert(row());
    index.remove('document', row().sourceId);
    expect(index.get('document', row().sourceId)).toBeNull();
    expect(index.isPublished('document', row().sourceId)).toBe(false);
  });

  it('is a no-op for a source that was never published', () => {
    expect(() => index.remove('document', '01ARZ3NDEKTSV4RRFFQ69G5FAV')).not.toThrow();
  });
});

describe('listByType', () => {
  it('orders newest source-created-first, and never mixes source types', () => {
    index.upsert(row({ sourceId: '01K3F9X2VQ8N7M4TQXYZ8ABC01', sourceCreatedAt: '2026-01-01T00:00:00Z' }));
    index.upsert(row({ sourceId: '01K3F9X2VQ8N7M4TQXYZ8ABC02', sourceCreatedAt: '2026-06-01T00:00:00Z' }));
    index.upsert(
      row({ sourceType: 'entry', sourceId: '01K3F9X2VQ8N7M4TQXYZ8ABC03', sourceCreatedAt: '2026-12-01T00:00:00Z' }),
    );

    expect(index.listByType('document').map((r) => r.sourceId)).toEqual([
      '01K3F9X2VQ8N7M4TQXYZ8ABC02',
      '01K3F9X2VQ8N7M4TQXYZ8ABC01',
    ]);
  });

  it('is an empty list, not an error, with nothing published', () => {
    expect(index.listByType('entry')).toEqual([]);
  });
});
