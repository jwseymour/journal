import { beforeEach, describe, expect, it } from 'vitest';
import { TodosIndex } from '../../src/index/todos-index.js';
import { TodosExtractor } from '../../src/model/todos-extractor.js';
import type { ExtractionRequest, ModelClient } from '../../src/model/model-client.js';
import type { TodoExtractionResult } from '../../src/model/todos.js';
import type {
  CreateEntryInput,
  EntryStore,
  ListOptions,
  ListResult,
  StoredEntry,
  StoreStats,
  UpdateEntryInput,
} from '../../src/store/entry-store.js';

/**
 * Unlike the other extractors' fakes, this one is driven by a handler
 * function rather than a static result: `TodosExtractor` generates to-do
 * ids internally, so a test proving a completion actually matches a real,
 * currently-open to-do has to read that id back out of the prompt it was
 * just offered in, not know it in advance.
 */
class FakeModelClient implements ModelClient {
  calls: ExtractionRequest<unknown>[] = [];
  handler: (prompt: string) => Partial<TodoExtractionResult> = () => ({});

  async extract<T>(request: ExtractionRequest<T>): Promise<T> {
    this.calls.push(request as ExtractionRequest<unknown>);
    const result = this.handler(request.prompt);
    return { newTodos: [], completions: [], ...result } as unknown as T;
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
  listPeriods(): Promise<never> {
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

let todosIndex: TodosIndex;
let modelClient: FakeModelClient;
let extractor: TodosExtractor;

beforeEach(() => {
  todosIndex = new TodosIndex(':memory:');
  modelClient = new FakeModelClient();
  extractor = new TodosExtractor(todosIndex, modelClient);
});

describe('extractEntry', () => {
  it('raises a new open to-do when the model returns one', async () => {
    modelClient.handler = () => ({
      newTodos: [{ text: 'Call the dentist', eventTime: '2026-07-20T20:00:00+01:00', eventTimeExplicit: true }],
    });

    await extractor.extractEntry(entry('e1', 'Need to call the dentist.'));

    const [record] = todosIndex.list({ limit: 10 });
    expect(record).toMatchObject({
      entryId: 'e1',
      text: 'Call the dentist',
      status: 'open',
      doneEntryId: null,
      resolution: null,
      origin: 'extracted',
    });
  });

  it('stores nothing when the model raises nothing and completes nothing', async () => {
    await extractor.extractEntry(entry('e1', 'A day with nothing outstanding.'));
    expect(todosIndex.list({ limit: 10 })).toEqual([]);
  });

  it('completes an existing open, untouched to-do when the model cites its real, currently-open id', async () => {
    modelClient.handler = () => ({
      newTodos: [{ text: 'Call the dentist', eventTime: '2026-01-01T00:00:00Z', eventTimeExplicit: true }],
    });
    await extractor.extractEntry(entry('e1', 'Need to call the dentist.'));
    const [raised] = todosIndex.listOpen();

    modelClient.handler = () => ({
      completions: [{ todoId: raised!.id, resolution: 'Called and rescheduled for next week.' }],
    });
    await extractor.extractEntry(entry('e2', 'Finally called the dentist and rescheduled for next week.'));

    const [record] = todosIndex.list({ limit: 10 });
    expect(record).toMatchObject({
      id: raised!.id,
      entryId: 'e1',
      status: 'done',
      doneEntryId: 'e2',
      resolution: 'Called and rescheduled for next week.',
    });
  });

  it('proposes a completion suggestion, rather than applying or dropping it, when the matched to-do is touched', async () => {
    modelClient.handler = () => ({
      newTodos: [{ text: 'Call the dentist', eventTime: '2026-01-01T00:00:00Z', eventTimeExplicit: true }],
    });
    await extractor.extractEntry(entry('e1', 'Need to call the dentist.'));
    const [raised] = todosIndex.listOpen();
    todosIndex.validate(raised!.id, 'now');

    modelClient.handler = () => ({
      completions: [{ todoId: raised!.id, resolution: 'Called and rescheduled for next week.' }],
    });
    await extractor.extractEntry(entry('e2', 'Finally called the dentist and rescheduled for next week.'));

    // Not silently applied — still open.
    const [record] = todosIndex.list({ limit: 10 });
    expect(record).toMatchObject({ id: raised!.id, status: 'open', touched: true });

    // A suggestion was raised instead.
    const suggestions = todosIndex.listCompletionSuggestions({ status: 'pending' });
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({
      recordId: raised!.id,
      entryId: 'e2',
      resolution: 'Called and rescheduled for next week.',
    });
  });

  it('drops a completion citing an id that was never actually offered — never trusts a hallucinated citation', async () => {
    modelClient.handler = () => ({
      completions: [{ todoId: 'not-a-real-id', resolution: 'This should never be stored.' }],
    });

    await extractor.extractEntry(entry('e1', 'Some entry with nothing genuinely outstanding.'));

    expect(todosIndex.list({ limit: 10 })).toEqual([]);
    expect(todosIndex.stats()).toEqual({ todoCount: 0, openCount: 0, doneCount: 0 });
  });

  it('falls back to the entry’s own written time for a malformed eventTime', async () => {
    modelClient.handler = () => ({
      newTodos: [{ text: 'x', eventTime: 'not a timestamp', eventTimeExplicit: true }],
    });
    await extractor.extractEntry(entry('e1', 'x', '2026-07-20T21:00:00+01:00'));
    const [record] = todosIndex.list({ limit: 10 });
    expect(record!.eventTime).toBe('2026-07-20T21:00:00+01:00');
    expect(record!.eventTimeExplicit).toBe(false);
  });

  it('replaces only what this entry raised on a second extraction, leaving other entries’ to-dos alone', async () => {
    modelClient.handler = () => ({ newTodos: [{ text: 'A', eventTime: '2026-07-20T20:00:00Z', eventTimeExplicit: true }] });
    await extractor.extractEntry(entry('e1', 'a'));
    await extractor.extractEntry(entry('e2', 'b'));

    modelClient.handler = () => ({ newTodos: [{ text: 'A revised', eventTime: '2026-07-20T20:00:00Z', eventTimeExplicit: true }] });
    await extractor.extractEntry(entry('e1', 'a again'));

    const rows = todosIndex.list({ limit: 10 });
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.entryId === 'e1')!.text).toBe('A revised');
    expect(rows.find((r) => r.entryId === 'e2')!.text).toBe('A');
  });

  it('a directly user-created to-do participates in completion-matching despite having no entryId — and, being touched from creation, produces a suggestion rather than applying silently', async () => {
    const created = todosIndex.createDirect({ id: 'u1', text: 'Water the plants', now: '2026-07-01T00:00:00Z' });
    expect(created.touched).toBe(true);

    modelClient.handler = (prompt) => {
      expect(prompt).toContain(`[id: ${created.id}] Water the plants`);
      return { completions: [{ todoId: created.id, resolution: 'Watered them today.' }] };
    };
    await extractor.extractEntry(entry('e1', 'Watered the plants today.'));

    const [record] = todosIndex.list({ limit: 10 });
    expect(record).toMatchObject({ id: created.id, entryId: null, status: 'open' });
    expect(todosIndex.listCompletionSuggestions({ status: 'pending' })).toMatchObject([
      { recordId: created.id, entryId: 'e1', resolution: 'Watered them today.' },
    ]);
  });
});

describe('removeEntry', () => {
  it('delegates straight to the index', async () => {
    modelClient.handler = () => ({
      newTodos: [{ text: 'x', eventTime: '2026-07-20T20:00:00+01:00', eventTimeExplicit: true }],
    });
    await extractor.extractEntry(entry('e1', 'x'));
    extractor.removeEntry('e1');
    expect(todosIndex.list({ limit: 10 })).toEqual([]);
  });
});

describe('reprocessAll', () => {
  it('extracts every entry and clears what came before', async () => {
    modelClient.handler = () => ({ newTodos: [{ text: 'x', eventTime: '2026-07-20T20:00:00Z', eventTimeExplicit: true }] });
    await extractor.extractEntry(entry('stale', 'leftover'));

    const store = new FakeEntryStore([entry('e1', 'a'), entry('e2', 'b')]);
    const result = await extractor.reprocessAll(store);

    expect(result).toEqual({ entryCount: 2, todoCount: 2, openCount: 2, doneCount: 0 });
  });

  it('processes entries in chronological order regardless of the order the store hands them back, so a completion can match a to-do raised earlier', async () => {
    modelClient.handler = (prompt) => {
      if (prompt.includes('Need to switch my car insurance.')) {
        return {
          newTodos: [{ text: 'Switch car insurance', eventTime: '2026-01-01T00:00:00Z', eventTimeExplicit: true }],
        };
      }
      if (prompt.includes('Finally switched car insurance.')) {
        const match = /\[id: (\S+)\] Switch car insurance/.exec(prompt);
        return match ? { completions: [{ todoId: match[1]!, resolution: 'Switched to a cheaper provider.' }] } : {};
      }
      return {};
    };

    // Deliberately handed to the store in reverse-chronological order — the
    // same order `store.list()` gives real entries in — to prove the
    // extractor's own sort, not incidental input order, is what makes the
    // completion possible.
    const store = new FakeEntryStore([
      entry('later', 'Finally switched car insurance.', '2026-06-01T00:00:00Z'),
      entry('earlier', 'Need to switch my car insurance.', '2026-01-01T00:00:00Z'),
    ]);

    const result = await extractor.reprocessAll(store);

    expect(result).toEqual({ entryCount: 2, todoCount: 1, openCount: 0, doneCount: 1 });
    const [record] = todosIndex.list({ limit: 10 });
    expect(record).toMatchObject({
      entryId: 'earlier',
      status: 'done',
      doneEntryId: 'later',
      resolution: 'Switched to a cheaper provider.',
    });
  });

  it('preserves a user-created to-do across a from-scratch reprocess', async () => {
    todosIndex.createDirect({ id: 'u1', text: 'Water the plants', now: '2026-07-01T00:00:00Z' });

    const store = new FakeEntryStore([entry('e1', 'a')]);
    await extractor.reprocessAll(store);

    expect(todosIndex.list({ limit: 10 }).find((r) => r.id === 'u1')).toMatchObject({ origin: 'user', status: 'open' });
  });
});
