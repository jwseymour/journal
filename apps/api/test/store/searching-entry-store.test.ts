import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SearchIndex } from '../../src/index/search-index.js';
import { SqliteIndex } from '../../src/index/sqlite-index.js';
import type { Embedder } from '../../src/search/embedder.js';
import { SearchIndexer } from '../../src/search/indexer.js';
import { FsEntryStore } from '../../src/store/fs-entry-store.js';
import { SearchingEntryStore } from '../../src/store/searching-entry-store.js';

const DIMENSIONS = 4;

class FakeEmbedder implements Embedder {
  readonly dimensions = DIMENSIONS;
  shouldFail = false;

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (this.shouldFail) throw new Error('the model is still downloading');
    return texts.map(() => new Float32Array(DIMENSIONS));
  }
}

let root: string;
let entryIndex: SqliteIndex;
let searchIndex: SearchIndex;
let embedder: FakeEmbedder;
let store: SearchingEntryStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'journal-searching-store-'));
  entryIndex = new SqliteIndex(':memory:');
  searchIndex = new SearchIndex(':memory:', DIMENSIONS);
  embedder = new FakeEmbedder();
  const indexer = new SearchIndexer(searchIndex, embedder);
  store = new SearchingEntryStore(new FsEntryStore(root, entryIndex), indexer);
});

afterEach(async () => {
  entryIndex.close();
  searchIndex.close();
  await rm(root, { recursive: true, force: true });
});

describe('create', () => {
  it('indexes the new entry for search', async () => {
    const entry = await store.create({ body: 'A walk along the coast.', created: '2026-07-26T22:55:13+01:00' });
    expect(searchIndex.searchText('coast', 10)).toEqual([
      { entryId: entry.id, chunkIndex: 0, text: 'A walk along the coast.' },
    ]);
  });

  it('still creates the entry on disk even if indexing fails', async () => {
    embedder.shouldFail = true;
    const entry = await store.create({ body: 'Written despite a broken embedder.', created: '2026-07-26T22:55:13+01:00' });

    expect(await store.get(entry.id)).not.toBeNull();
    expect(searchIndex.stats()).toEqual({ chunkCount: 0 });
  });
});

describe('update', () => {
  it('reindexes with the new body, replacing the old chunks', async () => {
    const entry = await store.create({ body: 'Original text about rivers.', created: '2026-07-26T22:55:13+01:00' });
    await store.update(entry.id, { body: 'Revised text about mountains.', contentHash: entry.contentHash });

    expect(searchIndex.searchText('rivers', 10)).toEqual([]);
    expect(searchIndex.searchText('mountains', 10)).toHaveLength(1);
  });

  it('still updates the entry on disk even if indexing fails', async () => {
    const entry = await store.create({ body: 'Before.', created: '2026-07-26T22:55:13+01:00' });
    embedder.shouldFail = true;
    const updated = await store.update(entry.id, { body: 'After.', contentHash: entry.contentHash });

    expect(updated.body).toBe('After.\n');
  });
});

describe('discardIfBlank', () => {
  it('removes the entry from the search index too', async () => {
    const entry = await store.create({ body: 'placeholder', created: '2026-07-26T22:55:13+01:00' });
    await store.update(entry.id, { body: '   ', contentHash: entry.contentHash });

    await store.discardIfBlank(entry.id);

    expect(searchIndex.stats()).toEqual({ chunkCount: 0 });
  });
});

describe('pass-through methods', () => {
  it('delegates get, list, stats and addAttachment to the inner store unchanged', async () => {
    const entry = await store.create({ body: 'Something to find.', created: '2026-07-26T22:55:13+01:00' });

    expect((await store.get(entry.id))?.body).toBe('Something to find.\n');
    expect((await store.list({ limit: 10 })).entries.map((e) => e.id)).toEqual([entry.id]);
    expect(await store.stats()).toEqual({ entryCount: 1, unreadableCount: 0 });

    const result = await store.addAttachment(entry.id, { filename: 'x.jpg', data: Buffer.from('x') });
    expect(result.relativeLink).toMatch(/x\.jpg$/);
  });

  it('delegates listPeriods to the inner store unchanged', async () => {
    await store.create({ body: 'Something to find.', created: '2026-07-26T22:55:13+01:00' });
    expect(await store.listPeriods()).toEqual({ periods: [{ year: 2026, month: 7 }] });
  });
});

it('logs rather than throws when indexing a create fails', async () => {
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  embedder.shouldFail = true;

  await store.create({ body: 'This must not throw.', created: '2026-07-26T22:55:13+01:00' });

  expect(errorSpy).toHaveBeenCalled();
  errorSpy.mockRestore();
});
