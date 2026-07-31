import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteIndex, type IndexRow } from '../../src/index/sqlite-index.js';

let index: SqliteIndex;

beforeEach(() => {
  index = new SqliteIndex(':memory:');
});

afterEach(() => {
  index.close();
});

function row(overrides: Partial<IndexRow> = {}): IndexRow {
  return {
    id: '01K3F9X2VQ8N7M4TQXYZ8ABCDE',
    absPath: '/journal/2026/07/entry.md',
    relPath: 'journal/2026/07/entry.md',
    epochMs: Date.UTC(2026, 6, 26, 21, 55),
    created: '2026-07-26T22:55:00+01:00',
    excerpt: 'A first entry.',
    contentHash: 'abc123',
    ...overrides,
  };
}

describe('upsert and lookup', () => {
  it('finds a row by id and by path after inserting it', () => {
    index.upsert(row());
    expect(index.getById('01K3F9X2VQ8N7M4TQXYZ8ABCDE')?.excerpt).toBe('A first entry.');
    expect(index.getByPath('/journal/2026/07/entry.md')?.excerpt).toBe('A first entry.');
  });

  it('returns null for an id or path never indexed', () => {
    expect(index.getById('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBeNull();
    expect(index.getByPath('/nope.md')).toBeNull();
  });

  it('round-trips location exactly', () => {
    index.upsert(row({ location: { lat: 51.5072, lon: -0.1276 } }));
    expect(index.getById(row().id)?.location).toEqual({ lat: 51.5072, lon: -0.1276 });
  });

  it('omits location entirely when absent — not null, not zero', () => {
    index.upsert(row());
    const found = index.getById(row().id);
    expect(found).not.toHaveProperty('location');
  });

  it('upserting the same path twice updates in place rather than duplicating', () => {
    index.upsert(row({ excerpt: 'First version.' }));
    index.upsert(row({ excerpt: 'Edited version.', contentHash: 'def456' }));

    expect(index.stats().entryCount).toBe(1);
    expect(index.getById(row().id)?.excerpt).toBe('Edited version.');
    expect(index.getById(row().id)?.contentHash).toBe('def456');
  });

  it('clears the unreadable mark when a path becomes readable', () => {
    index.markUnreadable('/journal/2026/07/entry.md');
    expect(index.isUnreadable('/journal/2026/07/entry.md')).toBe(true);

    index.upsert(row());
    expect(index.isUnreadable('/journal/2026/07/entry.md')).toBe(false);
  });
});

describe('markUnreadable and remove', () => {
  it('counts an unreadable path in stats without it being a readable entry', () => {
    index.markUnreadable('/journal/2026/07/broken.md');
    expect(index.stats()).toEqual({ entryCount: 0, unreadableCount: 1 });
  });

  it('removing an unreadable path clears it entirely', () => {
    index.markUnreadable('/journal/2026/07/broken.md');
    index.remove('/journal/2026/07/broken.md');
    expect(index.stats()).toEqual({ entryCount: 0, unreadableCount: 0 });
    expect(index.isUnreadable('/journal/2026/07/broken.md')).toBe(false);
  });

  it('removing a readable entry clears it entirely', () => {
    index.upsert(row());
    index.remove(row().absPath);
    expect(index.stats()).toEqual({ entryCount: 0, unreadableCount: 0 });
    expect(index.getById(row().id)).toBeNull();
  });
});

describe('knownPaths', () => {
  it('includes both readable and unreadable paths', () => {
    index.upsert(row({ absPath: '/a.md', relPath: 'a.md' }));
    index.markUnreadable('/b.md');
    expect(index.knownPaths()).toEqual(new Set(['/a.md', '/b.md']));
  });

  it('is empty for a fresh index', () => {
    expect(index.knownPaths()).toEqual(new Set());
  });
});

describe('list', () => {
  it('orders newest first by instant, id as the tiebreak', () => {
    index.upsert(row({ id: 'A', absPath: '/a.md', epochMs: 100 }));
    index.upsert(row({ id: 'C', absPath: '/c.md', epochMs: 300 }));
    index.upsert(row({ id: 'B', absPath: '/b.md', epochMs: 200 }));

    const { rows } = index.list(null, 10);
    expect(rows.map((r) => r.id)).toEqual(['C', 'B', 'A']);
  });

  it('breaks a tie in epoch by id, descending', () => {
    index.upsert(row({ id: 'A', absPath: '/a.md', epochMs: 100 }));
    index.upsert(row({ id: 'Z', absPath: '/z.md', epochMs: 100 }));
    index.upsert(row({ id: 'M', absPath: '/m.md', epochMs: 100 }));

    const { rows } = index.list(null, 10);
    expect(rows.map((r) => r.id)).toEqual(['Z', 'M', 'A']);
  });

  it('paginates without skipping or repeating a row', () => {
    for (let i = 0; i < 25; i++) {
      index.upsert(row({ id: `E${String(i).padStart(3, '0')}`, absPath: `/${i}.md`, epochMs: i }));
    }

    const seen: string[] = [];
    let cursor: import('../../src/store/cursor.js').Cursor | null = null;
    let pages = 0;
    for (;;) {
      const { rows, hasMore } = index.list(cursor, 7);
      seen.push(...rows.map((r) => r.id));
      pages += 1;
      expect(pages).toBeLessThan(10);
      if (!hasMore) break;
      const last = rows.at(-1)!;
      cursor = { epochMs: last.epochMs, id: last.id };
    }

    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
    expect(pages).toBe(4);
  });

  it('is empty, not an error, on an empty index', () => {
    expect(index.list(null, 10)).toEqual({ rows: [], hasMore: false });
  });

  it('reports hasMore correctly at the exact boundary', () => {
    index.upsert(row({ id: 'A', absPath: '/a.md', epochMs: 1 }));
    index.upsert(row({ id: 'B', absPath: '/b.md', epochMs: 2 }));
    expect(index.list(null, 2).hasMore).toBe(false);
    expect(index.list(null, 1).hasMore).toBe(true);
  });

  it('restricts to one calendar month when a period is given', () => {
    index.upsert(row({ id: 'A', absPath: '/a.md', epochMs: 1, created: '2026-06-15T10:00:00+00:00' }));
    index.upsert(row({ id: 'B', absPath: '/b.md', epochMs: 2, created: '2026-07-01T10:00:00+00:00' }));
    index.upsert(row({ id: 'C', absPath: '/c.md', epochMs: 3, created: '2026-07-26T10:00:00+00:00' }));

    const { rows } = index.list(null, 10, { year: 2026, month: 7 });
    expect(rows.map((r) => r.id)).toEqual(['C', 'B']);
  });

  it('combines a period filter with keyset pagination correctly', () => {
    index.upsert(row({ id: 'A', absPath: '/a.md', epochMs: 1, created: '2026-07-01T10:00:00+00:00' }));
    index.upsert(row({ id: 'B', absPath: '/b.md', epochMs: 2, created: '2026-07-10T10:00:00+00:00' }));
    index.upsert(row({ id: 'C', absPath: '/c.md', epochMs: 3, created: '2026-08-01T10:00:00+00:00' }));

    const first = index.list(null, 1, { year: 2026, month: 7 });
    expect(first.rows.map((r) => r.id)).toEqual(['B']);
    expect(first.hasMore).toBe(true);

    const last = first.rows.at(-1)!;
    const second = index.list({ epochMs: last.epochMs, id: last.id }, 1, { year: 2026, month: 7 });
    expect(second.rows.map((r) => r.id)).toEqual(['A']);
    expect(second.hasMore).toBe(false);
  });

  it('a period with no entries returns an empty page, not an error', () => {
    index.upsert(row({ id: 'A', absPath: '/a.md', epochMs: 1, created: '2026-07-01T10:00:00+00:00' }));
    expect(index.list(null, 10, { year: 2020, month: 1 })).toEqual({ rows: [], hasMore: false });
  });
});

describe('listPeriods', () => {
  it('is empty for a fresh index', () => {
    expect(index.listPeriods()).toEqual([]);
  });

  it('lists each distinct year-month once, newest first', () => {
    index.upsert(row({ id: 'A', absPath: '/a.md', created: '2026-06-15T10:00:00+00:00' }));
    index.upsert(row({ id: 'B', absPath: '/b.md', created: '2026-07-01T10:00:00+00:00' }));
    index.upsert(row({ id: 'C', absPath: '/c.md', created: '2026-07-26T10:00:00+00:00' }));
    index.upsert(row({ id: 'D', absPath: '/d.md', created: '2025-12-31T10:00:00+00:00' }));

    expect(index.listPeriods()).toEqual([
      { year: 2026, month: 7 },
      { year: 2026, month: 6 },
      { year: 2025, month: 12 },
    ]);
  });
});

describe('rebuild via clear', () => {
  it('wipes every row, readable and unreadable alike', () => {
    index.upsert(row());
    index.markUnreadable('/broken.md');
    expect(index.stats()).toEqual({ entryCount: 1, unreadableCount: 1 });

    index.clear();

    expect(index.stats()).toEqual({ entryCount: 0, unreadableCount: 0 });
    expect(index.knownPaths()).toEqual(new Set());
  });
});

describe('what must be true of a persistent file, not just :memory:', () => {
  it('survives being closed and reopened at the same path', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const dir = await mkdtemp(join(tmpdir(), 'journal-index-'));
    const dbPath = join(dir, 'nested', 'index.db');
    try {
      const first = new SqliteIndex(dbPath);
      first.upsert(row());
      first.close();

      const second = new SqliteIndex(dbPath);
      expect(second.getById(row().id)?.excerpt).toBe('A first entry.');
      second.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
