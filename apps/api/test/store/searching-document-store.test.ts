import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentsIndex } from '../../src/index/documents-index.js';
import { SearchIndex } from '../../src/index/search-index.js';
import type { Embedder } from '../../src/search/embedder.js';
import { SearchIndexer } from '../../src/search/indexer.js';
import { FsDocumentStore } from '../../src/store/fs-document-store.js';
import { SearchingDocumentStore } from '../../src/store/searching-document-store.js';

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
let documentsIndex: DocumentsIndex;
let searchIndex: SearchIndex;
let embedder: FakeEmbedder;
let store: SearchingDocumentStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'journal-searching-document-store-'));
  documentsIndex = new DocumentsIndex(':memory:');
  searchIndex = new SearchIndex(':memory:', DIMENSIONS);
  embedder = new FakeEmbedder();
  const indexer = new SearchIndexer(searchIndex, embedder);
  store = new SearchingDocumentStore(new FsDocumentStore(root, documentsIndex), indexer);
});

afterEach(async () => {
  documentsIndex.close();
  searchIndex.close();
  await rm(root, { recursive: true, force: true });
});

describe('create', () => {
  it('indexes the new document for search, distinct from an entry', async () => {
    const document = await store.create({ title: 'A project', body: 'Notes about a lighthouse.' });
    expect(searchIndex.searchText('lighthouse', 10)).toEqual([
      { sourceType: 'document', sourceId: document.id, chunkIndex: 0, text: 'Notes about a lighthouse.' },
    ]);
  });

  it('still creates the document on disk even if indexing fails', async () => {
    embedder.shouldFail = true;
    const document = await store.create({ title: 'x', body: 'Written despite a broken embedder.' });

    expect(await store.get(document.id)).not.toBeNull();
    expect(searchIndex.stats()).toEqual({ chunkCount: 0 });
  });
});

describe('update', () => {
  it('reindexes with the new body, replacing the old chunks', async () => {
    const document = await store.create({ title: 'x', body: 'Original text about rivers.' });
    await store.update(document.id, {
      title: 'x',
      body: 'Revised text about mountains.',
      contentHash: document.contentHash,
    });

    expect(searchIndex.searchText('rivers', 10)).toEqual([]);
    expect(searchIndex.searchText('mountains', 10)).toHaveLength(1);
  });

  it('still updates the document on disk even if indexing fails', async () => {
    const document = await store.create({ title: 'x', body: 'Before.' });
    embedder.shouldFail = true;
    const updated = await store.update(document.id, { title: 'x', body: 'After.', contentHash: document.contentHash });

    expect(updated.body).toBe('After.\n');
  });
});

describe('pass-through methods', () => {
  it('delegates get, list and stats to the inner store unchanged', async () => {
    const document = await store.create({ title: 'x', body: 'Something to find.' });

    expect((await store.get(document.id))?.body).toBe('Something to find.\n');
    expect((await store.list({ limit: 10 })).documents.map((d) => d.id)).toEqual([document.id]);
    expect(await store.stats()).toEqual({ documentCount: 1, unreadableCount: 0 });
  });
});

it('logs rather than throws when indexing a create fails', async () => {
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  embedder.shouldFail = true;

  await store.create({ title: 'x', body: 'This must not throw.' });

  expect(errorSpy).toHaveBeenCalled();
  errorSpy.mockRestore();
});
