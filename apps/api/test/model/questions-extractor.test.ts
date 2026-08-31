import { beforeEach, describe, expect, it } from 'vitest';
import { QuestionsIndex } from '../../src/index/questions-index.js';
import { QuestionsExtractor } from '../../src/model/questions-extractor.js';
import type { ExtractionRequest, ModelClient } from '../../src/model/model-client.js';
import type { OpenQuestionExtractionResult } from '../../src/model/questions.js';
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
 * function rather than a static result: `QuestionsExtractor` generates
 * question ids internally, so a test proving a resolution actually matches
 * a real, currently-open question has to read that id back out of the
 * prompt it was just offered in, not know it in advance.
 */
class FakeModelClient implements ModelClient {
  calls: ExtractionRequest<unknown>[] = [];
  handler: (prompt: string) => Partial<OpenQuestionExtractionResult> = () => ({});

  async extract<T>(request: ExtractionRequest<T>): Promise<T> {
    this.calls.push(request as ExtractionRequest<unknown>);
    const result = this.handler(request.prompt);
    return { newQuestions: [], resolutions: [], ...result } as unknown as T;
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

let questionsIndex: QuestionsIndex;
let modelClient: FakeModelClient;
let extractor: QuestionsExtractor;

beforeEach(() => {
  questionsIndex = new QuestionsIndex(':memory:');
  modelClient = new FakeModelClient();
  extractor = new QuestionsExtractor(questionsIndex, modelClient);
});

describe('extractCandidates', () => {
  it('shapes new-question output into candidates without writing to the index', async () => {
    modelClient.handler = () => ({
      newQuestions: [{ question: 'Should I stay in this job?', eventTime: '2026-01-01T00:00:00Z', eventTimeExplicit: true, confidence: 'medium', confidenceReason: 'borderline but genuine' }],
    });
    const result = await extractor.extractCandidates(entry('e1', 'Wondering if I should stay.'));

    expect(result.newQuestions).toHaveLength(1);
    expect(result.newQuestions[0]).toMatchObject({ question: 'Should I stay in this job?', confidence: 'medium' });
    expect(result.resolutions).toEqual([]);
    expect(questionsIndex.list({ limit: 10 })).toEqual([]);
  });

  it('drops a resolution citing an id that was never actually offered, before it ever becomes a candidate', async () => {
    modelClient.handler = () => ({
      resolutions: [{ questionId: 'not-a-real-id', resolution: 'x', confidence: 'high', confidenceReason: null }],
    });
    const result = await extractor.extractCandidates(entry('e1', 'x'));
    expect(result.resolutions).toEqual([]);
  });

  it('keeps a resolution candidate that cites a genuinely open id', async () => {
    modelClient.handler = () => ({
      newQuestions: [{ question: 'Should I stay in this job?', eventTime: '2026-01-01T00:00:00Z', eventTimeExplicit: true, confidence: 'high', confidenceReason: null }],
    });
    await extractor.extractEntry(entry('e1', 'Wondering if I should stay.'));
    const [raised] = questionsIndex.listOpen();

    modelClient.handler = () => ({
      resolutions: [{ questionId: raised!.id, resolution: 'Decided to leave.', confidence: 'low', confidenceReason: 'uncertain link' }],
    });
    const result = await extractor.extractCandidates(entry('e2', 'x'));

    expect(result.resolutions).toEqual([{ questionId: raised!.id, resolution: 'Decided to leave.', confidence: 'low', confidenceReason: 'uncertain link' }]);
    // Still nothing committed — the question is still open.
    expect(questionsIndex.getById(raised!.id)).toMatchObject({ status: 'open' });
  });
});

describe('extractEntry', () => {
  it('raises a new open question when the model returns one', async () => {
    modelClient.handler = () => ({
      newQuestions: [{ question: 'Should I stay in this job?', eventTime: '2026-07-20T20:00:00+01:00', eventTimeExplicit: true, confidence: 'high', confidenceReason: null }],
    });

    await extractor.extractEntry(entry('e1', 'Wondering if I should stay in this job.'));

    const [record] = questionsIndex.list({ limit: 10 });
    expect(record).toMatchObject({
      entryId: 'e1',
      question: 'Should I stay in this job?',
      status: 'open',
      resolvedEntryId: null,
      resolution: null,
    });
  });

  it('stores nothing when the model raises nothing and resolves nothing', async () => {
    await extractor.extractEntry(entry('e1', 'A day with nothing unresolved.'));
    expect(questionsIndex.list({ limit: 10 })).toEqual([]);
  });

  it('resolves an existing open question when the model cites its real, currently-open id', async () => {
    modelClient.handler = () => ({
      newQuestions: [{ question: 'Should I stay in this job?', eventTime: '2026-01-01T00:00:00Z', eventTimeExplicit: true, confidence: 'high', confidenceReason: null }],
    });
    await extractor.extractEntry(entry('e1', 'Wondering if I should stay in this job.'));
    const [raised] = questionsIndex.listOpen();

    modelClient.handler = () => ({
      resolutions: [{ questionId: raised!.id, resolution: 'Decided to leave and start freelancing.', confidence: 'high', confidenceReason: null }],
    });
    await extractor.extractEntry(entry('e2', 'I finally decided to leave and start freelancing.'));

    const [record] = questionsIndex.list({ limit: 10 });
    expect(record).toMatchObject({
      id: raised!.id,
      entryId: 'e1',
      status: 'resolved',
      resolvedEntryId: 'e2',
      resolution: 'Decided to leave and start freelancing.',
    });
  });

  it('drops a resolution citing an id that was never actually offered — never trusts a hallucinated citation', async () => {
    modelClient.handler = () => ({
      resolutions: [{ questionId: 'not-a-real-id', resolution: 'This should never be stored.', confidence: 'high', confidenceReason: null }],
    });

    await extractor.extractEntry(entry('e1', 'Some entry with nothing genuinely open.'));

    expect(questionsIndex.list({ limit: 10 })).toEqual([]);
    expect(questionsIndex.stats()).toEqual({ questionCount: 0, openCount: 0, resolvedCount: 0 });
  });

  it('falls back to the entry’s own written time for a malformed eventTime', async () => {
    modelClient.handler = () => ({
      newQuestions: [{ question: 'x', eventTime: 'not a timestamp', eventTimeExplicit: true, confidence: 'high', confidenceReason: null }],
    });
    await extractor.extractEntry(entry('e1', 'x', '2026-07-20T21:00:00+01:00'));
    const [record] = questionsIndex.list({ limit: 10 });
    expect(record!.eventTime).toBe('2026-07-20T21:00:00+01:00');
    expect(record!.eventTimeExplicit).toBe(false);
  });

  it('replaces only what this entry raised on a second extraction, leaving other entries’ questions alone', async () => {
    modelClient.handler = () => ({ newQuestions: [{ question: 'A', eventTime: '2026-07-20T20:00:00Z', eventTimeExplicit: true, confidence: 'high', confidenceReason: null }] });
    await extractor.extractEntry(entry('e1', 'a'));
    await extractor.extractEntry(entry('e2', 'b'));

    modelClient.handler = () => ({ newQuestions: [{ question: 'A revised', eventTime: '2026-07-20T20:00:00Z', eventTimeExplicit: true, confidence: 'high', confidenceReason: null }] });
    await extractor.extractEntry(entry('e1', 'a again'));

    const rows = questionsIndex.list({ limit: 10 });
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.entryId === 'e1')!.question).toBe('A revised');
    expect(rows.find((r) => r.entryId === 'e2')!.question).toBe('A');
  });
});

describe('removeEntry', () => {
  it('delegates straight to the index', async () => {
    modelClient.handler = () => ({
      newQuestions: [{ question: 'x', eventTime: '2026-07-20T20:00:00+01:00', eventTimeExplicit: true, confidence: 'high', confidenceReason: null }],
    });
    await extractor.extractEntry(entry('e1', 'x'));
    extractor.removeEntry('e1');
    expect(questionsIndex.list({ limit: 10 })).toEqual([]);
  });
});

describe('reprocessAll', () => {
  it('extracts every entry and clears what came before', async () => {
    modelClient.handler = () => ({ newQuestions: [{ question: 'x', eventTime: '2026-07-20T20:00:00Z', eventTimeExplicit: true, confidence: 'high', confidenceReason: null }] });
    await extractor.extractEntry(entry('stale', 'leftover'));

    const store = new FakeEntryStore([entry('e1', 'a'), entry('e2', 'b')]);
    const result = await extractor.reprocessAll(store);

    expect(result).toEqual({ entryCount: 2, questionCount: 2, openCount: 2, resolvedCount: 0 });
  });

  it('processes entries in chronological order regardless of the order the store hands them back, so a resolution can match a question raised earlier', async () => {
    modelClient.handler = (prompt) => {
      if (prompt.includes('Wondering if I should switch careers.')) {
        return {
          newQuestions: [{ question: 'Should I switch careers?', eventTime: '2026-01-01T00:00:00Z', eventTimeExplicit: true, confidence: 'high', confidenceReason: null }],
        };
      }
      if (prompt.includes('I finally decided to switch careers.')) {
        const match = /\[id: (\S+)\] Should I switch careers\?/.exec(prompt);
        return match
          ? { resolutions: [{ questionId: match[1]!, resolution: 'Decided to switch after all.', confidence: 'high', confidenceReason: null }] }
          : {};
      }
      return {};
    };

    // Deliberately handed to the store in reverse-chronological order — the
    // same order `store.list()` gives real entries in — to prove the
    // extractor's own sort, not incidental input order, is what makes the
    // resolution possible.
    const store = new FakeEntryStore([
      entry('later', 'I finally decided to switch careers.', '2026-06-01T00:00:00Z'),
      entry('earlier', 'Wondering if I should switch careers.', '2026-01-01T00:00:00Z'),
    ]);

    const result = await extractor.reprocessAll(store);

    expect(result).toEqual({ entryCount: 2, questionCount: 1, openCount: 0, resolvedCount: 1 });
    const [record] = questionsIndex.list({ limit: 10 });
    expect(record).toMatchObject({
      entryId: 'earlier',
      status: 'resolved',
      resolvedEntryId: 'later',
      resolution: 'Decided to switch after all.',
    });
  });
});
