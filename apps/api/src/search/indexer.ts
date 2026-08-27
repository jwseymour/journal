import type { SearchIndex, SearchSourceType } from '../index/search-index.js';
import type { DocumentStore } from '../store/document-store.js';
import type { EntryStore } from '../store/entry-store.js';
import { chunkParagraphs } from './chunk.js';
import type { Embedder } from './embedder.js';

const PAGE_SIZE = 100;

/**
 * Turns one source's body into the paragraph chunks and embeddings
 * `SearchIndex` stores, and drives the full-corpus rebuild (`plan.md` M6,
 * generalised to documents in M17).
 */
export class SearchIndexer {
  readonly #index: SearchIndex;
  readonly #embedder: Embedder;

  constructor(index: SearchIndex, embedder: Embedder) {
    this.#index = index;
    this.#embedder = embedder;
  }

  async indexEntry(entryId: string, body: string): Promise<void> {
    await this.#indexSource('entry', entryId, body);
  }

  removeEntry(entryId: string): void {
    this.#index.removeEntry(entryId);
  }

  /** The document twin of `indexEntry` (`plan.md` M17) — same chunk/embed/
   * replace shape, just against a document's id and body instead of an
   * entry's. */
  async indexDocument(documentId: string, body: string): Promise<void> {
    await this.#indexSource('document', documentId, body);
  }

  removeDocument(documentId: string): void {
    this.#index.removeSource('document', documentId);
  }

  async #indexSource(sourceType: SearchSourceType, sourceId: string, body: string): Promise<void> {
    const paragraphs = chunkParagraphs(body);
    if (paragraphs.length === 0) {
      // A body edited down to whitespace is still a real source — it just
      // has nothing left to search.
      this.#index.removeSource(sourceType, sourceId);
      return;
    }
    const embeddings = await this.#embedder.embed(paragraphs);
    this.#index.replaceSource(sourceType, sourceId, paragraphs, embeddings);
  }

  /**
   * Reprocess-from-scratch for search (`requirements.md` §6.4): every entry,
   * re-chunked and re-embedded, nothing carried over from before. Paged
   * through `store.list`/`store.get` rather than assuming direct filesystem
   * access, so this works against any `EntryStore`, not only `FsEntryStore`.
   *
   * Clears the whole index first, entries and documents alike — a caller
   * doing a full rebuild of both must run this one first, then
   * `rebuildAllDocuments`, which deliberately does not clear again.
   */
  async rebuildAll(store: EntryStore): Promise<{ entryCount: number; chunkCount: number }> {
    this.#index.clear();
    let cursor: string | undefined;
    let entryCount = 0;
    do {
      const page = await store.list({ limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) });
      for (const summary of page.entries) {
        const entry = await store.get(summary.id);
        if (!entry) continue; // vanished between list and get — same tolerance M1 already has
        await this.indexEntry(entry.id, entry.body);
        entryCount += 1;
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    const { chunkCount } = this.#index.stats();
    return { entryCount, chunkCount };
  }

  /**
   * The document twin of `rebuildAll` (`plan.md` M17) — every document,
   * re-chunked and re-embedded. Never clears the index itself: run after
   * `rebuildAll` in the same rebuild, so entries already re-indexed are not
   * wiped out from under them.
   */
  async rebuildAllDocuments(store: DocumentStore): Promise<{ documentCount: number; chunkCount: number }> {
    let cursor: string | undefined;
    let documentCount = 0;
    do {
      const page = await store.list({ limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) });
      for (const summary of page.documents) {
        const document = await store.get(summary.id);
        if (!document) continue; // vanished between list and get — same tolerance the entry path has
        await this.indexDocument(document.id, document.body);
        documentCount += 1;
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    const { chunkCount } = this.#index.stats();
    return { documentCount, chunkCount };
  }
}
