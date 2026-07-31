import type { CategoriesIndex } from '../index/categories-index.js';
import type { ListItemRecord, ListsIndex } from '../index/lists-index.js';
import { ulid } from '../record/id.js';
import { nowTimestamp } from '../record/time.js';
import type { EntryStore } from '../store/entry-store.js';
import { resolveEventTime } from './event-time.js';
import { buildExtractionPrompt, buildListExtractionRequest } from './lists.js';
import type { ModelClient } from './model-client.js';

const PAGE_SIZE = 100;

/**
 * Turns one entry's body into atomic list-item records via `ModelClient` —
 * the third instance of the same shape as `Extractor` and
 * `ReviewsExtractor`. See `ReviewsExtractor`'s comment for why this stays
 * its own class rather than a shared generic.
 */
export class ListsExtractor {
  readonly #listsIndex: ListsIndex;
  readonly #categoriesIndex: CategoriesIndex;
  readonly #modelClient: ModelClient;

  constructor(listsIndex: ListsIndex, categoriesIndex: CategoriesIndex, modelClient: ModelClient) {
    this.#listsIndex = listsIndex;
    this.#categoriesIndex = categoriesIndex;
    this.#modelClient = modelClient;
  }

  async extractEntry(entry: { id: string; created: string; body: string }): Promise<void> {
    const approvedTypes = this.#categoriesIndex.approvedNames('list_type');
    const { schema, system } = buildListExtractionRequest(approvedTypes);
    const result = await this.#modelClient.extract({ schema, system, prompt: buildExtractionPrompt(entry) });

    const extractedAt = nowTimestamp().canonical;
    const records: Omit<ListItemRecord, 'entryId'>[] = result.items.map((item) => {
      const resolved = resolveEventTime(item.eventTime, item.eventTimeExplicit, entry.created);
      return {
        id: ulid(Date.now()),
        listType: item.listType,
        text: item.text,
        context: item.context,
        importance: item.importance,
        ...resolved,
        extractedAt,
      };
    });

    this.#listsIndex.replaceEntry(entry.id, records);

    if (result.suggestedCategory) {
      this.#categoriesIndex.suggest({
        structureType: 'list_type',
        name: result.suggestedCategory.name,
        reason: result.suggestedCategory.reason,
        entryId: entry.id,
        id: ulid(Date.now()),
        now: extractedAt,
      });
    }
  }

  removeEntry(entryId: string): void {
    this.#listsIndex.removeEntry(entryId);
  }

  async reprocessAll(store: EntryStore): Promise<{ entryCount: number; itemCount: number }> {
    this.#listsIndex.clear();
    let cursor: string | undefined;
    let entryCount = 0;
    do {
      const page = await store.list({ limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) });
      for (const summary of page.entries) {
        const entry = await store.get(summary.id);
        if (!entry) continue;
        await this.extractEntry(entry);
        entryCount += 1;
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    const { itemCount } = this.#listsIndex.stats();
    return { entryCount, itemCount };
  }
}
