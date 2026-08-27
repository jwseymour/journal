import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DocumentsIndex, type DocumentIndexRow } from '../../src/index/documents-index.js';

let index: DocumentsIndex;

beforeEach(() => {
  index = new DocumentsIndex(':memory:');
});

afterEach(() => {
  index.close();
});

function row(overrides: Partial<DocumentIndexRow> = {}): DocumentIndexRow {
  return {
    id: '01K3F9X2VQ8N7M4TQXYZ8ABCDE',
    absPath: '/journal/documents/01K3F9X2VQ8N7M4TQXYZ8ABCDE.md',
    relPath: 'documents/01K3F9X2VQ8N7M4TQXYZ8ABCDE.md',
    title: 'The greenhouse project',
    createdEpochMs: Date.UTC(2026, 6, 20, 9, 0),
    created: '2026-07-20T10:00:00+01:00',
    updatedEpochMs: Date.UTC(2026, 6, 20, 9, 0),
    updated: '2026-07-20T10:00:00+01:00',
    excerpt: 'Notes so far.',
    contentHash: 'abc123',
    public: false,
    ...overrides,
  };
}

describe('upsert and lookup', () => {
  it('finds a row by id after inserting it', () => {
    index.upsert(row());
    expect(index.getById(row().id)?.title).toBe('The greenhouse project');
  });

  it('returns null for an id never indexed', () => {
    expect(index.getById('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBeNull();
  });

  it('upserting the same path twice updates in place rather than duplicating', () => {
    index.upsert(row({ title: 'Draft title' }));
    index.upsert(row({ title: 'Final title', contentHash: 'def456' }));

    expect(index.stats().documentCount).toBe(1);
    expect(index.getById(row().id)?.title).toBe('Final title');
  });

  it('clears the unreadable mark when a path becomes readable', () => {
    index.markUnreadable(row().absPath);
    index.upsert(row());
    expect(index.stats()).toEqual({ documentCount: 1, unreadableCount: 0 });
  });

  it('round-trips public through the same 0/1 storage `touched` uses elsewhere (`requirements.md` §9.3)', () => {
    index.upsert(row({ public: true }));
    expect(index.getById(row().id)?.public).toBe(true);

    index.upsert(row({ public: false }));
    expect(index.getById(row().id)?.public).toBe(false);
  });
});

describe('markUnreadable and remove', () => {
  it('counts an unreadable path without it being a readable document', () => {
    index.markUnreadable('/journal/documents/broken.md');
    expect(index.stats()).toEqual({ documentCount: 0, unreadableCount: 1 });
  });

  it('removing a readable document clears it entirely', () => {
    index.upsert(row());
    index.remove(row().absPath);
    expect(index.stats()).toEqual({ documentCount: 0, unreadableCount: 0 });
    expect(index.getById(row().id)).toBeNull();
  });
});

describe('list', () => {
  it('orders newest-updated-first — not newest-created-first', () => {
    // Deliberately reversed relative to creation time, to prove the
    // ordering key really is `updated`, not `created` (`requirements.md` §9.1).
    index.upsert(
      row({
        id: '01K3F9X2VQ8N7M4TQXYZ8ABC01',
        absPath: '/a.md',
        title: 'Started first, touched last',
        createdEpochMs: 1_000,
        updatedEpochMs: 3_000,
      }),
    );
    index.upsert(
      row({
        id: '01K3F9X2VQ8N7M4TQXYZ8ABC02',
        absPath: '/b.md',
        title: 'Started last, never touched again',
        createdEpochMs: 2_000,
        updatedEpochMs: 2_000,
      }),
    );

    const { rows } = index.list(null, 10);
    expect(rows.map((r) => r.title)).toEqual(['Started first, touched last', 'Started last, never touched again']);
  });

  it('is an empty page, not an error, with no documents', () => {
    expect(index.list(null, 10)).toEqual({ rows: [], hasMore: false });
  });

  it('pages with a cursor and reports hasMore correctly', () => {
    for (let i = 0; i < 5; i += 1) {
      index.upsert(
        row({
          id: `01K3F9X2VQ8N7M4TQXYZ8AB${String(i).padStart(2, '0')}`,
          absPath: `/${i}.md`,
          updatedEpochMs: i * 1000,
        }),
      );
    }

    const first = index.list(null, 2);
    expect(first.hasMore).toBe(true);
    expect(first.rows).toHaveLength(2);

    const last = first.rows.at(-1)!;
    const second = index.list({ epochMs: last.updatedEpochMs, id: last.id }, 2);
    expect(second.rows).toHaveLength(2);
    expect(second.rows[0]!.id).not.toBe(first.rows[0]!.id);
  });
});
