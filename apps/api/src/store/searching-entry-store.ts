import type { SearchIndexer } from '../search/indexer.js';
import type {
  AddAttachmentInput,
  AddAttachmentResult,
  AttachmentBytes,
  AttachmentInfo,
  CreateEntryInput,
  EntryStore,
  ListOptions,
  ListPeriodsResult,
  ListResult,
  StoredEntry,
  StoreStats,
  UpdateEntryInput,
} from './entry-store.js';

/**
 * Keeps the search index (`plan.md` M6) in step with every write, the same
 * way `FsEntryStore` keeps `SqliteIndex` in step — but as a decorator around
 * a plain `EntryStore` rather than built into `FsEntryStore` itself, because
 * chunking and embedding are an entirely separate concern from files and
 * paths, and the M4 pattern (`Transcriber` is a seam `http/app.ts` calls, not
 * something baked into the store) says that separation is worth keeping here
 * too.
 *
 * Indexing failure never fails the write. The files are Pillar 1; the search
 * index is a derived, rebuildable cache of them (`requirements.md` §6.4) — an
 * entry that fails to index today is found again the next time it is saved,
 * or by the next `rebuild-index`. It must never be the reason writing itself
 * fails, particularly since the most likely cause is a one-time model
 * download still in progress.
 */
export class SearchingEntryStore implements EntryStore {
  readonly #inner: EntryStore;
  readonly #indexer: SearchIndexer;

  constructor(inner: EntryStore, indexer: SearchIndexer) {
    this.#inner = inner;
    this.#indexer = indexer;
  }

  async create(input: CreateEntryInput): Promise<StoredEntry> {
    const entry = await this.#inner.create(input);
    await this.#reindex(entry);
    return entry;
  }

  async update(id: string, input: UpdateEntryInput): Promise<StoredEntry> {
    const entry = await this.#inner.update(id, input);
    await this.#reindex(entry);
    return entry;
  }

  async discardIfBlank(id: string): Promise<void> {
    await this.#inner.discardIfBlank(id);
    this.#indexer.removeEntry(id);
  }

  get(id: string): Promise<StoredEntry | null> {
    return this.#inner.get(id);
  }

  addAttachment(id: string, input: AddAttachmentInput): Promise<AddAttachmentResult> {
    return this.#inner.addAttachment(id, input);
  }

  listAttachments(id: string): Promise<AttachmentInfo[]> {
    return this.#inner.listAttachments(id);
  }

  getAttachment(id: string, filename: string): Promise<AttachmentBytes | null> {
    return this.#inner.getAttachment(id, filename);
  }

  list(options: ListOptions): Promise<ListResult> {
    return this.#inner.list(options);
  }

  listPeriods(): Promise<ListPeriodsResult> {
    return this.#inner.listPeriods();
  }

  stats(): Promise<StoreStats> {
    return this.#inner.stats();
  }

  async #reindex(entry: StoredEntry): Promise<void> {
    try {
      await this.#indexer.indexEntry(entry.id, entry.body);
    } catch (error) {
      console.error(`[journal] failed to index entry ${entry.id} for search`, error);
    }
  }
}
