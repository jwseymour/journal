import type { SearchIndexer } from '../search/indexer.js';
import type {
  CreateDocumentInput,
  DocumentStore,
  DocumentStoreStats,
  ListDocumentsOptions,
  ListDocumentsResult,
  StoredDocument,
  UpdateDocumentInput,
} from './document-store.js';

/**
 * The document twin of `SearchingEntryStore` (`plan.md` M17) — same
 * decorator shape, same reasoning: chunking and embedding are a separate
 * concern from documents' own storage, and indexing failure must never fail
 * the write. The files (and, once M12 gave documents durability of their
 * own, the documents) are what matters; the search index is a derived,
 * rebuildable cache of them (`requirements.md` §6.4).
 */
export class SearchingDocumentStore implements DocumentStore {
  readonly #inner: DocumentStore;
  readonly #indexer: SearchIndexer;

  constructor(inner: DocumentStore, indexer: SearchIndexer) {
    this.#inner = inner;
    this.#indexer = indexer;
  }

  async create(input: CreateDocumentInput): Promise<StoredDocument> {
    const document = await this.#inner.create(input);
    await this.#reindex(document);
    return document;
  }

  async update(id: string, input: UpdateDocumentInput): Promise<StoredDocument> {
    const document = await this.#inner.update(id, input);
    await this.#reindex(document);
    return document;
  }

  get(id: string): Promise<StoredDocument | null> {
    return this.#inner.get(id);
  }

  list(options: ListDocumentsOptions): Promise<ListDocumentsResult> {
    return this.#inner.list(options);
  }

  stats(): Promise<DocumentStoreStats> {
    return this.#inner.stats();
  }

  async #reindex(document: StoredDocument): Promise<void> {
    try {
      await this.#indexer.indexDocument(document.id, document.body);
    } catch (error) {
      console.error(`[journal] failed to index document ${document.id} for search`, error);
    }
  }
}
