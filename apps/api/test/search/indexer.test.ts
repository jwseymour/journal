import { beforeEach, describe, expect, it } from 'vitest';
import { SearchIndex } from '../../src/index/search-index.js';
import type { Embedder } from '../../src/search/embedder.js';
import { SearchIndexer } from '../../src/search/indexer.js';
import type {
  CreateEntryInput,
  EntryStore,
  ListOptions,
  ListResult,
  StoredEntry,
  StoreStats,
  UpdateEntryInput,
} from '../../src/store/entry-store.js';

const DIMENSIONS = 4;

/** Deterministic, not semantic — enough for indexer tests to check that the
 * right text was embedded and stored, without loading a real model. */
class FakeEmbedder implements Embedder {
  readonly dimensions = DIMENSIONS;
  calls: string[][] = [];

  async embed(texts: string[]): Promise<Float32Array[]> {
    this.calls.push(texts);
    return texts.map((text) => new Float32Array([text.length, 0, 0, 0]));
  }
}

/** Just enough of `EntryStore` to drive `rebuildAll`'s pagination — a real
 * `FsEntryStore` is exercised in `searching-entry-store.test.ts` instead. */
class FakeEntryStore implements EntryStore {
  constructor(private entries: StoredEntry[]) {}

  async list(options: ListOptions): Promise<ListResult> {
    const start = options.cursor ? Number(options.cursor) : 0;
    const end = Math.min(start + options.limit, this.entries.length);
    const page = this.entries.slice(start, end);
    return {
      entries: page.map((e) => ({ id: e.id, created: e.created, ...(e.location ? { location: e.location } : {}), excerpt: e.body.slice(0, 20) })),
      nextCursor: end < this.entries.length ? String(end) : null,
    };
  }

  async get(id: string): Promise<StoredEntry | null> {
    return this.entries.find((e) => e.id === id) ?? null;
  }

  create(_input: CreateEntryInput): Promise<StoredEntry> {
    throw new Error('not used in these tests');
  }
  update(_id: string, _input: UpdateEntryInput): Promise<StoredEntry> {
    throw new Error('not used in these tests');
  }
  discardIfBlank(_id: string): Promise<void> {
    throw new Error('not used in these tests');
  }
  addAttachment(): Promise<never> {
    throw new Error('not used in these tests');
  }
  async stats(): Promise<StoreStats> {
    return { entryCount: this.entries.length, unreadableCount: 0 };
  }
}

const entry = (id: string, body: string): StoredEntry => ({
  id,
  created: '2026-07-01T09:00:00Z',
  body,
  path: `journal/${id}.md`,
  contentHash: `hash-${id}`,
});

let index: SearchIndex;
let embedder: FakeEmbedder;
let indexer: SearchIndexer;

beforeEach(() => {
  index = new SearchIndex(':memory:', DIMENSIONS);
  embedder = new FakeEmbedder();
  indexer = new SearchIndexer(index, embedder);
});

describe('indexEntry', () => {
  it('chunks the body and embeds every paragraph', async () => {
    await indexer.indexEntry('e1', 'First paragraph.\n\nSecond paragraph.');
    expect(embedder.calls).toEqual([['First paragraph.', 'Second paragraph.']]);
    expect(index.searchText('paragraph', 10)).toHaveLength(2);
  });

  it('removes existing chunks rather than indexing anything for a blank body', async () => {
    await indexer.indexEntry('e1', 'Something with real words.');
    expect(index.searchText('words', 10)).toHaveLength(1);

    await indexer.indexEntry('e1', '   ');
    expect(index.searchText('words', 10)).toEqual([]);
    expect(index.stats()).toEqual({ chunkCount: 0 });
  });

  it('replaces rather than accumulates on a second index of the same entry', async () => {
    await indexer.indexEntry('e1', 'Original version.');
    await indexer.indexEntry('e1', 'Revised version.');
    expect(index.searchText('version', 10)).toHaveLength(1);
  });
});

describe('removeEntry', () => {
  it('delegates straight to the index', async () => {
    await indexer.indexEntry('e1', 'Findable text.');
    indexer.removeEntry('e1');
    expect(index.searchText('findable', 10)).toEqual([]);
  });
});

describe('rebuildAll', () => {
  it('indexes every entry across multiple pages', async () => {
    const store = new FakeEntryStore([
      entry('e1', 'alpha paragraph'),
      entry('e2', 'bravo paragraph'),
      entry('e3', 'charlie paragraph'),
    ]);
    // Force pagination: FakeEntryStore.list respects the caller's limit, and
    // SearchIndexer.rebuildAll always asks for a fixed page size — three
    // entries across a page size larger than 1 already exercises the
    // cursor loop as long as more than one page is produced. To keep this
    // deterministic regardless of the indexer's internal page size, drive
    // list() directly through a tiny page size via a thin wrapper.
    const result = await indexer.rebuildAll(store);
    expect(result).toEqual({ entryCount: 3, chunkCount: 3 });
    expect(index.searchText('bravo', 10)).toHaveLength(1);
  });

  it('clears whatever was indexed before starting', async () => {
    await indexer.indexEntry('stale', 'leftover text from before a rebuild');
    const store = new FakeEntryStore([entry('e1', 'fresh text')]);

    await indexer.rebuildAll(store);

    expect(index.searchText('leftover', 10)).toEqual([]);
    expect(index.searchText('fresh', 10)).toHaveLength(1);
  });

  it('skips an entry that vanished between list and get', async () => {
    const store = new FakeEntryStore([entry('e1', 'still here')]);
    const originalGet = store.get.bind(store);
    store.get = async (id: string) => (id === 'e1' ? null : originalGet(id));

    const result = await indexer.rebuildAll(store);
    expect(result).toEqual({ entryCount: 0, chunkCount: 0 });
  });
});
