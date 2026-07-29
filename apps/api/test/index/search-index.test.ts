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
    expect(hits).toEqual([{ entryId: 'e1', chunkIndex: 0, text: 'the quick brown fox' }]);
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
      { entryId: 'e1', chunkIndex: 0, text: 'revised text about mountains' },
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
    expect(index.searchVector(vec(0, 1, 0, 0), 10).map((h) => h.entryId)).not.toContain('e2');
  });

  it('is a no-op, not an error, for an entry never indexed', () => {
    expect(() => index.removeEntry('never-existed')).not.toThrow();
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
      { entryId: 'e1', chunkIndex: 0, text: 'durable text' },
    ]);
    expect(reopened.searchVector(vec(1, 0, 0, 0), 10)[0]!.text).toBe('durable text');
    reopened.close();
  });
});
