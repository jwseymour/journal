import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MediaIndex, type MediaIndexRow } from '../../src/index/media-index.js';

let index: MediaIndex;

beforeEach(() => {
  index = new MediaIndex(':memory:');
});

afterEach(() => {
  index.close();
});

function row(overrides: Partial<MediaIndexRow> = {}): MediaIndexRow {
  return {
    id: '01K3F9X2VQ8N7M4TQXYZ8ABCDE',
    absPath: '/journal/media/01K3F9X2VQ8N7M4TQXYZ8ABCDE.jpg',
    relPath: 'media/01K3F9X2VQ8N7M4TQXYZ8ABCDE.jpg',
    kind: 'image',
    contentType: 'image/jpeg',
    byteSize: 12345,
    originalFilename: 'IMG_0001.jpg',
    width: 4032,
    height: 3024,
    capturedAt: '2024-06-01T14:22:03',
    capturedDate: '2024-06-01',
    uploadedAt: '2026-07-20T10:00:00+01:00',
    uploadedEpochMs: Date.UTC(2026, 6, 20, 9, 0),
    ...overrides,
  };
}

describe('upsert and lookup', () => {
  it('finds a row by id after inserting it', () => {
    index.upsert(row());
    expect(index.getById(row().id)?.originalFilename).toBe('IMG_0001.jpg');
  });

  it('returns null for an id never indexed', () => {
    expect(index.getById('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBeNull();
  });

  it('upserting the same path twice updates in place rather than duplicating', () => {
    index.upsert(row({ originalFilename: 'first.jpg' }));
    index.upsert(row({ originalFilename: 'renamed.jpg' }));

    expect(index.stats().mediaCount).toBe(1);
    expect(index.getById(row().id)?.originalFilename).toBe('renamed.jpg');
  });

  it('preserves null width/height/capturedAt/capturedDate exactly', () => {
    index.upsert(row({ width: null, height: null, capturedAt: null, capturedDate: null }));
    const found = index.getById(row().id);
    expect(found).toMatchObject({ width: null, height: null, capturedAt: null, capturedDate: null });
  });

  it('removes a row by its path', () => {
    index.upsert(row());
    index.remove(row().absPath);
    expect(index.getById(row().id)).toBeNull();
  });

  it('knownPaths reports every indexed path', () => {
    index.upsert(row({ id: 'A', absPath: '/a.jpg' }));
    index.upsert(row({ id: 'B', absPath: '/b.jpg' }));
    expect(index.knownPaths()).toEqual(new Set(['/a.jpg', '/b.jpg']));
  });
});

describe('list', () => {
  it('is empty, not an error, when nothing has been indexed', () => {
    expect(index.list(null, 10)).toEqual({ rows: [], hasMore: false });
  });

  it('orders newest-uploaded-first, id descending as the tiebreak', () => {
    index.upsert(row({ id: 'A', absPath: '/a.jpg', uploadedEpochMs: 1000 }));
    index.upsert(row({ id: 'C', absPath: '/c.jpg', uploadedEpochMs: 3000 }));
    index.upsert(row({ id: 'B', absPath: '/b.jpg', uploadedEpochMs: 2000 }));

    const { rows } = index.list(null, 10);
    expect(rows.map((r) => r.id)).toEqual(['C', 'B', 'A']);
  });

  it('paginates via a cursor, covering every row exactly once', () => {
    for (let i = 0; i < 5; i += 1) {
      index.upsert(row({ id: `ID${i}`, absPath: `/${i}.jpg`, uploadedEpochMs: i }));
    }

    const seen: string[] = [];
    let cursor: { epochMs: number; id: string } | null = null;
    for (let page = 0; page < 10; page += 1) {
      const { rows, hasMore } = index.list(cursor, 2);
      seen.push(...rows.map((r) => r.id));
      if (!hasMore) break;
      const last = rows.at(-1)!;
      cursor = { epochMs: last.uploadedEpochMs, id: last.id };
    }

    expect(seen).toEqual(['ID4', 'ID3', 'ID2', 'ID1', 'ID0']);
  });
});

describe('listByCapturedDate', () => {
  it('finds every item captured on that date, earliest time-of-day first', () => {
    index.upsert(row({ id: 'A', absPath: '/a.jpg', capturedAt: '2024-06-01T18:00:00', capturedDate: '2024-06-01' }));
    index.upsert(row({ id: 'B', absPath: '/b.jpg', capturedAt: '2024-06-01T09:00:00', capturedDate: '2024-06-01' }));
    index.upsert(row({ id: 'C', absPath: '/c.jpg', capturedAt: '2024-06-02T09:00:00', capturedDate: '2024-06-02' }));
    index.upsert(row({ id: 'D', absPath: '/d.jpg', capturedAt: null, capturedDate: null }));

    expect(index.listByCapturedDate('2024-06-01').map((r) => r.id)).toEqual(['B', 'A']);
    expect(index.listByCapturedDate('2024-06-02').map((r) => r.id)).toEqual(['C']);
    expect(index.listByCapturedDate('2024-06-03')).toEqual([]);
  });

  it('never matches an item with no captured date', () => {
    index.upsert(row({ capturedAt: null, capturedDate: null }));
    expect(index.listByCapturedDate('2024-06-01')).toEqual([]);
  });
});

describe('stats and clear', () => {
  it('counts every indexed item', () => {
    index.upsert(row({ id: 'A', absPath: '/a.jpg' }));
    index.upsert(row({ id: 'B', absPath: '/b.jpg' }));
    expect(index.stats()).toEqual({ mediaCount: 2, unreadableCount: 0 });
  });

  it('clear wipes every row', () => {
    index.upsert(row());
    index.clear();
    expect(index.stats()).toEqual({ mediaCount: 0, unreadableCount: 0 });
    expect(index.getById(row().id)).toBeNull();
  });
});

describe('markUnreadable', () => {
  it('counts a marked path separately, and knownPaths still reports it', () => {
    index.markUnreadable('/broken.jpg');
    expect(index.stats()).toEqual({ mediaCount: 0, unreadableCount: 1 });
    expect(index.knownPaths()).toEqual(new Set(['/broken.jpg']));
  });

  it('clears the unreadable mark once the path becomes readable', () => {
    index.markUnreadable(row().absPath);
    index.upsert(row());
    expect(index.stats()).toEqual({ mediaCount: 1, unreadableCount: 0 });
  });

  it('remove clears an unreadable mark too, not only a readable row', () => {
    index.markUnreadable('/broken.jpg');
    index.remove('/broken.jpg');
    expect(index.stats()).toEqual({ mediaCount: 0, unreadableCount: 0 });
  });
});
