import { beforeEach, describe, expect, it } from 'vitest';
import { CategoriesIndex } from '../../src/index/categories-index.js';
import { ListsIndex } from '../../src/index/lists-index.js';
import { ListsExtractor } from '../../src/model/lists-extractor.js';
import type { ListExtractionResult } from '../../src/model/lists.js';
import { LIST_TYPE_SEED_NAMES } from '../../src/model/lists.js';
import type { ExtractionRequest, ModelClient } from '../../src/model/model-client.js';
import type {
  CreateEntryInput,
  EntryStore,
  ListOptions,
  ListResult,
  StoredEntry,
  StoreStats,
  UpdateEntryInput,
} from '../../src/store/entry-store.js';

class FakeModelClient implements ModelClient {
  calls: ExtractionRequest<unknown>[] = [];
  result: Partial<ListExtractionResult> = { items: [] };

  async extract<T>(request: ExtractionRequest<T>): Promise<T> {
    this.calls.push(request as ExtractionRequest<unknown>);
    return { suggestedCategory: null, ...this.result } as unknown as T;
  }
}

class FakeEntryStore implements EntryStore {
  constructor(private entries: StoredEntry[]) {}

  async list(options: ListOptions): Promise<ListResult> {
    const start = options.cursor ? Number(options.cursor) : 0;
    const end = Math.min(start + options.limit, this.entries.length);
    const page = this.entries.slice(start, end);
    return {
      entries: page.map((e) => ({ id: e.id, created: e.created, excerpt: e.body.slice(0, 20) })),
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

const entry = (id: string, body: string, created = '2026-07-20T21:00:00+01:00'): StoredEntry => ({
  id,
  created,
  body,
  path: `journal/${id}.md`,
  contentHash: `hash-${id}`,
});

let listsIndex: ListsIndex;
let categoriesIndex: CategoriesIndex;
let modelClient: FakeModelClient;
let extractor: ListsExtractor;

beforeEach(() => {
  listsIndex = new ListsIndex(':memory:');
  categoriesIndex = new CategoriesIndex(':memory:');
  categoriesIndex.seed('list_type', LIST_TYPE_SEED_NAMES, '2026-01-01T00:00:00Z');
  modelClient = new FakeModelClient();
  extractor = new ListsExtractor(listsIndex, categoriesIndex, modelClient);
});

describe('extractEntry', () => {
  it('stores a record for each item the model returns, verbatim text preserved', async () => {
    modelClient.result = {
      items: [
        {
          listType: 'quote',
          text: '"The unexamined life is not worth living."',
          context: 'Socrates',
          eventTime: '2026-07-20T20:00:00+01:00',
          eventTimeExplicit: true,
        },
      ],
    };
    await extractor.extractEntry(entry('e1', 'Read a great quote today: "The unexamined life is not worth living." — Socrates.'));

    const [record] = listsIndex.list({ limit: 10 });
    expect(record).toMatchObject({
      entryId: 'e1',
      listType: 'quote',
      text: '"The unexamined life is not worth living."',
      context: 'Socrates',
    });
  });

  it('stores nothing when the model finds no atomic item', async () => {
    modelClient.result = { items: [] };
    await extractor.extractEntry(entry('e1', 'A day with nothing to note.'));
    expect(listsIndex.list({ limit: 10 })).toEqual([]);
  });

  it('falls back to the entry’s own written time for a malformed eventTime', async () => {
    modelClient.result = {
      items: [{ listType: 'quote', text: 'x', context: '', eventTime: 'not a timestamp', eventTimeExplicit: true }],
    };
    await extractor.extractEntry(entry('e1', 'x', '2026-07-20T21:00:00+01:00'));
    const [record] = listsIndex.list({ limit: 10 });
    expect(record!.eventTime).toBe('2026-07-20T21:00:00+01:00');
    expect(record!.eventTimeExplicit).toBe(false);
  });

  it('records a suggested list type without inventing an item for it', async () => {
    modelClient.result = {
      items: [],
      suggestedCategory: { name: 'recipe', reason: 'noted down a recipe' },
    };
    await extractor.extractEntry(entry('e1', 'Jotting down this recipe for later.'));

    expect(listsIndex.list({ limit: 10 })).toEqual([]);
    expect(categoriesIndex.listSuggestions()).toMatchObject([
      { structureType: 'list_type', name: 'recipe', reason: 'noted down a recipe', entryId: 'e1' },
    ]);
  });
});

describe('removeEntry', () => {
  it('delegates straight to the index', async () => {
    modelClient.result = {
      items: [{ listType: 'quote', text: 'x', context: '', eventTime: '2026-07-20T20:00:00+01:00', eventTimeExplicit: true }],
    };
    await extractor.extractEntry(entry('e1', 'x'));
    extractor.removeEntry('e1');
    expect(listsIndex.list({ limit: 10 })).toEqual([]);
  });
});

describe('reprocessAll', () => {
  it('extracts every entry and clears what came before', async () => {
    await extractor.extractEntry(entry('stale', 'leftover'));
    modelClient.result = {
      items: [{ listType: 'quote', text: 'x', context: '', eventTime: '2026-07-20T20:00:00+01:00', eventTimeExplicit: true }],
    };
    const store = new FakeEntryStore([entry('e1', 'a'), entry('e2', 'b')]);

    const result = await extractor.reprocessAll(store);

    expect(result).toEqual({ entryCount: 2, itemCount: 2 });
  });
});
