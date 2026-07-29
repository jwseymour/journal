import type { SearchIndex } from '../index/search-index.js';
import type { EntryStore } from '../store/entry-store.js';
import { chunkParagraphs } from './chunk.js';
import type { Embedder } from './embedder.js';

const PAGE_SIZE = 100;

/**
 * Turns one entry's body into the paragraph chunks and embeddings
 * `SearchIndex` stores, and drives the full-corpus rebuild (`plan.md` M6).
 */
export class SearchIndexer {
  readonly #index: SearchIndex;
  readonly #embedder: Embedder;

  constructor(index: SearchIndex, embedder: Embedder) {
    this.#index = index;
    this.#embedder = embedder;
  }

  async indexEntry(entryId: string, body: string): Promise<void> {
    const paragraphs = chunkParagraphs(body);
    if (paragraphs.length === 0) {
      // A body edited down to whitespace is still a real entry
      // (`fs-entry-store.ts` allows this without exception) — it just has
      // nothing left to search.
      this.#index.removeEntry(entryId);
      return;
    }
    const embeddings = await this.#embedder.embed(paragraphs);
    this.#index.replaceEntry(entryId, paragraphs, embeddings);
  }

  removeEntry(entryId: string): void {
    this.#index.removeEntry(entryId);
  }

  /**
   * Reprocess-from-scratch for search (`requirements.md` §6.4): every entry,
   * re-chunked and re-embedded, nothing carried over from before. Paged
   * through `store.list`/`store.get` rather than assuming direct filesystem
   * access, so this works against any `EntryStore`, not only `FsEntryStore`.
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
}
