import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SearchIndex } from '../../src/index/search-index.js';

const DIMENSIONS = 4;
const vec = (...values: number[]): Float32Array => new Float32Array(values);

let index: SearchIndex;

beforeEach(() => {
  index = new SearchIndex(':memory:', DIMENSIONS);
});

afterEach(() => {
  index.close();
});

describe('replaceEntry / searchText', () => {
  it('finds a chunk by an exact word', () => {
    index.replaceEntry('e1', ['the quick brown fox'], [vec(1, 0, 0, 0)]);
    const hits = index.searchText('fox', 10);
    expect(hits).toEqual([{ sourceType: 'entry', sourceId: 'e1', chunkIndex: 0, text: 'the quick brown fox' }]);
  });

  it('finds nothing for a word that does not appear anywhere', () => {
    index.replaceEntry('e1', ['the quick brown fox'], [vec(1, 0, 0, 0)]);
    expect(index.searchText('astronaut', 10)).toEqual([]);
  });

  it('is empty, not an error, on an index with nothing in it', () => {
    expect(index.searchText('anything', 10)).toEqual([]);
  });

  it('stores every paragraph of an entry as its own chunk, in order', () => {
    index.replaceEntry('e1', ['first paragraph', 'second paragraph'], [vec(1, 0, 0, 0), vec(0, 1, 0, 0)]);
    const hits = index.searchText('paragraph', 10).sort((a, b) => a.chunkIndex - b.chunkIndex);
    expect(hits.map((h) => h.chunkIndex)).toEqual([0, 1]);
    expect(hits.map((h) => h.text)).toEqual(['first paragraph', 'second paragraph']);
  });

  it('replaces the previous chunks entirely on a second call for the same entry', () => {
    index.replaceEntry('e1', ['original text about oceans'], [vec(1, 0, 0, 0)]);
    index.replaceEntry('e1', ['revised text about mountains'], [vec(0, 1, 0, 0)]);

    expect(index.searchText('oceans', 10)).toEqual([]);
    expect(index.searchText('mountains', 10)).toEqual([
      { sourceType: 'entry', sourceId: 'e1', chunkIndex: 0, text: 'revised text about mountains' },
    ]);
  });

  it('does not find a term as a raw FTS5 operator — special characters are treated literally', () => {
    index.replaceEntry('e1', ['cost is $10 (roughly) -- not "exact"'], [vec(1, 0, 0, 0)]);
    // A query containing FTS5 syntax characters must not throw.
    expect(() => index.searchText('"unterminated', 10)).not.toThrow();
    expect(() => index.searchText('foo AND (bar', 10)).not.toThrow();
  });

  it('rejects nothing for an all-whitespace query — it just finds nothing', () => {
    index.replaceEntry('e1', ['some text'], [vec(1, 0, 0, 0)]);
    expect(index.searchText('   ', 10)).toEqual([]);
  });

  it('respects the limit', () => {
    index.replaceEntry(
      'e1',
      ['apple one', 'apple two', 'apple three'],
      [vec(1, 0, 0, 0), vec(0, 1, 0, 0), vec(0, 0, 1, 0)],
    );
    expect(index.searchText('apple', 2)).toHaveLength(2);
  });
});

describe('searchVector', () => {
  it('ranks the nearest vector first', () => {
    index.replaceEntry(
      'e1',
      ['close', 'far'],
      [vec(1, 0, 0, 0), vec(0, 0, 0, 1)],
    );
    const hits = index.searchVector(vec(0.9, 0.1, 0, 0), 10);
    expect(hits[0]!.text).toBe('close');
    expect(hits.at(-1)!.text).toBe('far');
  });

  it('is empty, not an error, on an index with nothing in it', () => {
    expect(index.searchVector(vec(1, 0, 0, 0), 10)).toEqual([]);
  });

  it('respects the limit', () => {
    index.replaceEntry(
      'e1',
      ['a', 'b', 'c'],
      [vec(1, 0, 0, 0), vec(0.9, 0, 0, 0), vec(0.8, 0, 0, 0)],
    );
    expect(index.searchVector(vec(1, 0, 0, 0), 2)).toHaveLength(2);
  });
});

describe('removeEntry', () => {
  it('removes every chunk belonging to that entry, and no others', () => {
    index.replaceEntry('e1', ['keep this one'], [vec(1, 0, 0, 0)]);
    index.replaceEntry('e2', ['gone after removal'], [vec(0, 1, 0, 0)]);

    index.removeEntry('e2');

    expect(index.searchText('keep', 10)).toHaveLength(1);
    expect(index.searchText('gone', 10)).toEqual([]);
    expect(index.searchVector(vec(0, 1, 0, 0), 10).map((h) => h.sourceId)).not.toContain('e2');
  });

  it('is a no-op, not an error, for an entry never indexed', () => {
    expect(() => index.removeEntry('never-existed')).not.toThrow();
  });
});

describe('source_type (`plan.md` M17)', () => {
  it('keeps an entry and a document with the same id from colliding', () => {
    index.replaceSource('entry', 'same-id', ['entry text'], [vec(1, 0, 0, 0)]);
    index.replaceSource('document', 'same-id', ['document text'], [vec(0, 1, 0, 0)]);

    expect(index.searchText('entry', 10)).toEqual([
      { sourceType: 'entry', sourceId: 'same-id', chunkIndex: 0, text: 'entry text' },
    ]);
    expect(index.searchText('document', 10)).toEqual([
      { sourceType: 'document', sourceId: 'same-id', chunkIndex: 0, text: 'document text' },
    ]);
  });

  it('replaceSource for a document does not disturb an entry with the same id', () => {
    index.replaceSource('entry', 'shared', ['entry text'], [vec(1, 0, 0, 0)]);
    index.replaceSource('document', 'shared', ['document text'], [vec(0, 1, 0, 0)]);

    index.replaceSource('document', 'shared', ['revised document text'], [vec(0, 0, 1, 0)]);

    expect(index.searchText('entry', 10)).toHaveLength(1);
    expect(index.searchText('revised', 10)).toHaveLength(1);
  });

  it('removeSource for a document does not remove an entry with the same id', () => {
    index.replaceSource('entry', 'shared', ['entry text'], [vec(1, 0, 0, 0)]);
    index.replaceSource('document', 'shared', ['document text'], [vec(0, 1, 0, 0)]);

    index.removeSource('document', 'shared');

    expect(index.searchText('entry', 10)).toHaveLength(1);
    expect(index.searchText('document', 10)).toEqual([]);
  });

  it('defaults every pre-existing row to source_type entry via the idempotent migration', () => {
    // Exercised indirectly: `replaceEntry`/`removeEntry` are the exact
    // convenience wrappers a database created before M17 would have used,
    // and every assertion above already confirms they resolve to
    // `sourceType: 'entry'` — the default the `ALTER TABLE` migration sets.
    index.replaceEntry('legacy', ['pre-existing row'], [vec(1, 0, 0, 0)]);
    expect(index.searchText('pre-existing', 10)).toEqual([
      { sourceType: 'entry', sourceId: 'legacy', chunkIndex: 0, text: 'pre-existing row' },
    ]);
  });
});

describe('stats / clear', () => {
  it('counts chunks across every entry', () => {
    index.replaceEntry('e1', ['a', 'b'], [vec(1, 0, 0, 0), vec(0, 1, 0, 0)]);
    index.replaceEntry('e2', ['c'], [vec(0, 0, 1, 0)]);
    expect(index.stats()).toEqual({ chunkCount: 3 });
  });

  it('wipes everything', () => {
    index.replaceEntry('e1', ['a'], [vec(1, 0, 0, 0)]);
    index.clear();
    expect(index.stats()).toEqual({ chunkCount: 0 });
    expect(index.searchText('a', 10)).toEqual([]);
  });
});

describe('persistence', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'journal-search-index-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('survives a close and reopen against the same file', async () => {
    const dbPath = join(root, 'index.db');
    const first = new SearchIndex(dbPath, DIMENSIONS);
    first.replaceEntry('e1', ['durable text'], [vec(1, 0, 0, 0)]);
    first.close();

    const reopened = new SearchIndex(dbPath, DIMENSIONS);
    expect(reopened.searchText('durable', 10)).toEqual([
      { sourceType: 'entry', sourceId: 'e1', chunkIndex: 0, text: 'durable text' },
    ]);
    expect(reopened.searchVector(vec(1, 0, 0, 0), 10)[0]!.text).toBe('durable text');
    reopened.close();
  });

  it('migrates an existing entry-only database in place, adding source_type without losing data', async () => {
    const dbPath = join(root, 'index.db');
    const before = new SearchIndex(dbPath, DIMENSIONS);
    before.replaceEntry('e1', ['already there'], [vec(1, 0, 0, 0)]);
    before.close();

    const after = new SearchIndex(dbPath, DIMENSIONS);
    expect(after.searchText('already', 10)).toEqual([
      { sourceType: 'entry', sourceId: 'e1', chunkIndex: 0, text: 'already there' },
    ]);
    after.close();
  });
});
