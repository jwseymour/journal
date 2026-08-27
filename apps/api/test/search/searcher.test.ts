import type { SearchHit } from '@journal/contract';
import { beforeEach, describe, expect, it } from 'vitest';
import { DocumentsIndex } from '../../src/index/documents-index.js';
import { SearchIndex, type SearchIndexHit } from '../../src/index/search-index.js';
import { SqliteIndex } from '../../src/index/sqlite-index.js';
import type { Embedder } from '../../src/search/embedder.js';
import type { Reranker } from '../../src/search/rerank.js';
import { HybridSearcher } from '../../src/search/searcher.js';

const DIMENSIONS = 4;

/** A lookup-table embedder: exact text in, a hand-picked vector out. Lets a
 * test place the query's embedding deliberately close to a chunk that shares
 * none of its words, so vector recall can be told apart from BM25 recall. */
class LookupEmbedder implements Embedder {
  readonly dimensions = DIMENSIONS;
  readonly #vectors = new Map<string, Float32Array>();

  set(text: string, vector: number[]): void {
    this.#vectors.set(text, new Float32Array(vector));
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => this.#vectors.get(text) ?? new Float32Array(DIMENSIONS));
  }
}

let searchIndex: SearchIndex;
let entryIndex: SqliteIndex;
let documentsIndex: DocumentsIndex;
let embedder: LookupEmbedder;

beforeEach(() => {
  searchIndex = new SearchIndex(':memory:', DIMENSIONS);
  entryIndex = new SqliteIndex(':memory:');
  documentsIndex = new DocumentsIndex(':memory:');
  embedder = new LookupEmbedder();
});

function putEntry(id: string, created: string, location?: { lat: number; lon: number }): void {
  entryIndex.upsert({
    id,
    absPath: `/journal/${id}.md`,
    relPath: `journal/${id}.md`,
    epochMs: Date.parse(created),
    created,
    ...(location ? { location } : {}),
    excerpt: 'excerpt',
    contentHash: `hash-${id}`,
  });
}

function putDocument(id: string, title: string, created: string): void {
  documentsIndex.upsert({
    id,
    absPath: `documents/${id}.md`,
    relPath: `documents/${id}.md`,
    title,
    createdEpochMs: Date.parse(created),
    created,
    updatedEpochMs: Date.parse(created),
    updated: created,
    excerpt: 'excerpt',
    contentHash: `hash-${id}`,
  });
}

/** Every hit in these tests is an entry hit unless a test says otherwise —
 * a small cast point rather than repeating the discriminant check everywhere. */
function entryIdOf(hit: SearchHit): string {
  if (hit.sourceType !== 'entry') throw new Error('expected an entry hit');
  return hit.entryId;
}

describe('HybridSearcher', () => {
  it('returns nothing for an empty or whitespace-only query, without touching the embedder or index', async () => {
    const searcher = new HybridSearcher(searchIndex, embedder, entryIndex, documentsIndex);
    expect(await searcher.search('', 10)).toEqual([]);
    expect(await searcher.search('   ', 10)).toEqual([]);
  });

  it('finds a passage by an exact shared word', async () => {
    putEntry('e1', '2026-07-01T09:00:00Z');
    searchIndex.replaceEntry('e1', ['the quick brown fox'], [new Float32Array(DIMENSIONS)]);
    embedder.set('fox', [0, 0, 0, 0]);

    const searcher = new HybridSearcher(searchIndex, embedder, entryIndex, documentsIndex);
    const hits = await searcher.search('fox', 10);

    expect(hits).toHaveLength(1);
    expect(hits[0]).toEqual({
      sourceType: 'entry',
      entryId: 'e1',
      created: '2026-07-01T09:00:00Z',
      passage: 'the quick brown fox',
    });
  });

  it('finds a passage by meaning alone, when it shares no words with the query', async () => {
    putEntry('e1', '2026-07-01T09:00:00Z');
    // "feline behaviour" and "the cat sat on the mat" share zero words, but
    // are given the same embedding direction, simulating a semantic match.
    searchIndex.replaceEntry('e1', ['the cat sat on the mat'], [new Float32Array([1, 0, 0, 0])]);
    embedder.set('feline behaviour', [1, 0, 0, 0]);

    const searcher = new HybridSearcher(searchIndex, embedder, entryIndex, documentsIndex);
    const hits = await searcher.search('feline behaviour', 10);

    expect(hits).toEqual([
      { sourceType: 'entry', entryId: 'e1', created: '2026-07-01T09:00:00Z', passage: 'the cat sat on the mat' },
    ]);
  });

  it('ranks a passage found by both text and meaning above one found by only one', async () => {
    putEntry('both', '2026-07-01T09:00:00Z');
    putEntry('text-only', '2026-07-02T09:00:00Z');
    searchIndex.replaceEntry('both', ['fox meaning and word'], [new Float32Array([1, 0, 0, 0])]);
    searchIndex.replaceEntry('text-only', ['just the word fox'], [new Float32Array([0, 1, 0, 0])]);
    embedder.set('fox', [1, 0, 0, 0]); // close to "both", far from "text-only"

    const searcher = new HybridSearcher(searchIndex, embedder, entryIndex, documentsIndex);
    const hits = await searcher.search('fox', 10);

    expect(entryIdOf(hits[0]!)).toBe('both');
  });

  it('includes the location when the entry has one', async () => {
    putEntry('e1', '2026-07-01T09:00:00Z', { lat: 51.5072, lon: -0.1276 });
    searchIndex.replaceEntry('e1', ['a walk in the park'], [new Float32Array(DIMENSIONS)]);
    embedder.set('park', [0, 0, 0, 0]);

    const searcher = new HybridSearcher(searchIndex, embedder, entryIndex, documentsIndex);
    const hits = await searcher.search('park', 10);

    expect(hits[0]).toMatchObject({ location: { lat: 51.5072, lon: -0.1276 } });
  });

  it('skips a chunk whose entry no longer exists in the entry index', async () => {
    // Indexed but never registered with `entryIndex` — as if the entry was
    // discarded after the chunk was written and before a rebuild caught up.
    searchIndex.replaceEntry('ghost', ['a passage with no entry behind it'], [new Float32Array(DIMENSIONS)]);
    embedder.set('passage', [0, 0, 0, 0]);

    const searcher = new HybridSearcher(searchIndex, embedder, entryIndex, documentsIndex);
    expect(await searcher.search('passage', 10)).toEqual([]);
  });

  it('respects the limit after fusion', async () => {
    for (const id of ['e1', 'e2', 'e3']) {
      putEntry(id, '2026-07-01T09:00:00Z');
      searchIndex.replaceEntry(id, [`apple ${id}`], [new Float32Array(DIMENSIONS)]);
    }
    embedder.set('apple', [0, 0, 0, 0]);

    const searcher = new HybridSearcher(searchIndex, embedder, entryIndex, documentsIndex);
    expect(await searcher.search('apple', 2)).toHaveLength(2);
  });

  it('runs results through the reranker before returning them', async () => {
    putEntry('e1', '2026-07-01T09:00:00Z');
    putEntry('e2', '2026-07-02T09:00:00Z');
    searchIndex.replaceEntry('e1', ['apple one'], [new Float32Array(DIMENSIONS)]);
    searchIndex.replaceEntry('e2', ['apple two'], [new Float32Array(DIMENSIONS)]);
    embedder.set('apple', [0, 0, 0, 0]);

    // A reranker that reverses whatever order it is given — proves the
    // searcher actually defers to it rather than only using RRF's order.
    const reversingReranker: Reranker<SearchIndexHit> = {
      async rerank(_query, results) {
        return [...results].reverse();
      },
    };

    const searcher = new HybridSearcher(searchIndex, embedder, entryIndex, documentsIndex, reversingReranker);
    const direct = await new HybridSearcher(searchIndex, embedder, entryIndex, documentsIndex).search('apple', 10);
    const withReranker = await searcher.search('apple', 10);

    expect(withReranker.map(entryIdOf)).toEqual([...direct.map(entryIdOf)].reverse());
  });

  describe('documents (`plan.md` M17)', () => {
    it('finds a passage in a document, distinguished from an entry hit', async () => {
      putDocument('d1', 'A project', '2026-07-01T09:00:00Z');
      searchIndex.replaceSource('document', 'd1', ['notes about a lighthouse'], [new Float32Array(DIMENSIONS)]);
      embedder.set('lighthouse', [0, 0, 0, 0]);

      const searcher = new HybridSearcher(searchIndex, embedder, entryIndex, documentsIndex);
      const hits = await searcher.search('lighthouse', 10);

      expect(hits).toEqual([
        {
          sourceType: 'document',
          documentId: 'd1',
          title: 'A project',
          created: '2026-07-01T09:00:00Z',
          passage: 'notes about a lighthouse',
        },
      ]);
    });

    it('returns both an entry hit and a document hit for the same query', async () => {
      putEntry('e1', '2026-07-01T09:00:00Z');
      putDocument('d1', 'A project', '2026-07-02T09:00:00Z');
      searchIndex.replaceEntry('e1', ['a walk by the lighthouse'], [new Float32Array(DIMENSIONS)]);
      searchIndex.replaceSource('document', 'd1', ['plans for the lighthouse'], [new Float32Array(DIMENSIONS)]);
      embedder.set('lighthouse', [0, 0, 0, 0]);

      const searcher = new HybridSearcher(searchIndex, embedder, entryIndex, documentsIndex);
      const hits = await searcher.search('lighthouse', 10);

      expect(hits.map((h) => h.sourceType).sort()).toEqual(['document', 'entry']);
    });

    it('skips a document chunk whose document no longer exists in the documents index', async () => {
      searchIndex.replaceSource('document', 'ghost', ['a passage with no document behind it'], [
        new Float32Array(DIMENSIONS),
      ]);
      embedder.set('passage', [0, 0, 0, 0]);

      const searcher = new HybridSearcher(searchIndex, embedder, entryIndex, documentsIndex);
      expect(await searcher.search('passage', 10)).toEqual([]);
    });
  });
});
