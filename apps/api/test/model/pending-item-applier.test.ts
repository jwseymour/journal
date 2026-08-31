import { beforeEach, describe, expect, it } from 'vitest';
import { TouchedMirror, type DurableBlobStore } from '../../src/durable/touched-mirror.js';
import { ListsIndex } from '../../src/index/lists-index.js';
import { MetricsIndex } from '../../src/index/metrics-index.js';
import { OpinionStatementsIndex } from '../../src/index/opinion-statements-index.js';
import { OpinionSummariesIndex } from '../../src/index/opinion-summaries-index.js';
import type { PendingExtractionItem } from '../../src/index/pending-items-index.js';
import { QuestionsIndex } from '../../src/index/questions-index.js';
import { ReviewsIndex } from '../../src/index/reviews-index.js';
import { TodosIndex } from '../../src/index/todos-index.js';
import type { ExtractionRequest, ModelClient } from '../../src/model/model-client.js';
import { OpinionSummarizer } from '../../src/model/opinion-summarizer.js';
import { PendingItemApplier } from '../../src/model/pending-item-applier.js';

class FakeDurableBlobStore implements DurableBlobStore {
  files = new Map<string, string>();
  async put(key: string, json: string): Promise<void> {
    this.files.set(key, json);
  }
  async delete(key: string): Promise<void> {
    this.files.delete(key);
  }
  async list(prefix: string): Promise<{ key: string; json: string }[]> {
    return [...this.files.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, json]) => ({ key, json }));
  }
}

/** Records every call rather than producing a real summary — the applier
 * tests only care that `summarizeSubject` actually ran for the right
 * subject after an approval, not what a summary looks like (that is
 * `opinion-summarizer.test.ts`'s job). */
class SpyOpinionModelClient implements ModelClient {
  prompts: string[] = [];
  async extract<T>(request: ExtractionRequest<T>): Promise<T> {
    this.prompts.push(request.prompt);
    return { parts: [] } as unknown as T;
  }
}

let metricsIndex: MetricsIndex;
let reviewsIndex: ReviewsIndex;
let listsIndex: ListsIndex;
let opinionStatementsIndex: OpinionStatementsIndex;
let opinionSummariesIndex: OpinionSummariesIndex;
let questionsIndex: QuestionsIndex;
let todosIndex: TodosIndex;
let blobs: FakeDurableBlobStore;
let touchedMirror: TouchedMirror;
let applier: PendingItemApplier;
let opinionModelClient: SpyOpinionModelClient;

const NOW = '2026-07-20T12:00:00+01:00';

const item = (overrides: Partial<PendingExtractionItem> = {}): PendingExtractionItem => ({
  id: 'p1',
  entryId: 'e1',
  processRunId: 'r1',
  structureType: 'metric',
  kind: 'new',
  targetRecordId: null,
  category: 'exercise',
  payload: {},
  confidence: 'high',
  reason: null,
  status: 'approved',
  createdAt: NOW,
  decidedAt: NOW,
  ...overrides,
});

beforeEach(() => {
  metricsIndex = new MetricsIndex(':memory:');
  reviewsIndex = new ReviewsIndex(':memory:');
  listsIndex = new ListsIndex(':memory:');
  opinionStatementsIndex = new OpinionStatementsIndex(':memory:');
  opinionSummariesIndex = new OpinionSummariesIndex(':memory:');
  questionsIndex = new QuestionsIndex(':memory:');
  todosIndex = new TodosIndex(':memory:');
  blobs = new FakeDurableBlobStore();
  touchedMirror = new TouchedMirror(blobs, metricsIndex, reviewsIndex, listsIndex, opinionStatementsIndex, questionsIndex, todosIndex);
  opinionModelClient = new SpyOpinionModelClient();
  const opinionSummarizer = new OpinionSummarizer(opinionSummariesIndex, opinionStatementsIndex, opinionModelClient);
  applier = new PendingItemApplier(metricsIndex, reviewsIndex, listsIndex, opinionStatementsIndex, opinionSummarizer, questionsIndex, todosIndex, touchedMirror);
});

describe('metric', () => {
  it('"new" commits a live, untouched record', async () => {
    await applier.apply(
      item({ structureType: 'metric', kind: 'new', category: 'exercise', payload: { metric: 'exercise', eventTime: '2026-07-20T07:00:00+01:00', eventTimeExplicit: true, detail: 'a run', fields: {} } }),
      NOW,
    );
    const [record] = metricsIndex.list({ limit: 10 });
    expect(record).toMatchObject({ entryId: 'e1', metric: 'exercise', detail: 'a run', touched: false });
    // Confidence never reaches the committed record.
    expect(record).not.toHaveProperty('confidence');
  });

  it('"update" applies to the target and marks it touched, mirrored durably', async () => {
    metricsIndex.insertApproved({
      id: 'm1', entryId: 'e1', metric: 'exercise', eventTime: '2026-07-20T07:00:00+01:00',
      eventEpochMs: Date.parse('2026-07-20T07:00:00+01:00'), eventTimeExplicit: true, detail: 'a run', fields: {},
      extractedAt: NOW, touched: false,
    });

    await applier.apply(
      item({ structureType: 'metric', kind: 'update', targetRecordId: 'm1', payload: { metric: 'exercise', eventTime: '2026-07-20T07:00:00+01:00', eventTimeExplicit: true, detail: 'a 10k run', fields: {} } }),
      NOW,
    );

    expect(metricsIndex.getById('m1')).toMatchObject({ detail: 'a 10k run', touched: true });
    expect(blobs.files.has('derived/touched/metrics/m1.json')).toBe(true);
  });
});

describe('review', () => {
  it('"new" commits untouched, "update" commits touched and mirrors', async () => {
    await applier.apply(
      item({ structureType: 'review', kind: 'new', category: 'film', payload: { title: 'A Film', medium: 'film', rating: 4, progress: 100, opinion: 'good', eventTime: NOW, eventTimeExplicit: true } }),
      NOW,
    );
    const [record] = reviewsIndex.list({ limit: 10 });
    expect(record).toMatchObject({ title: 'A Film', touched: false });

    await applier.apply(
      item({ structureType: 'review', kind: 'update', targetRecordId: record!.id, payload: { title: 'A Film', medium: 'film', rating: 5, progress: 100, opinion: 'even better', eventTime: NOW, eventTimeExplicit: true } }),
      NOW,
    );
    expect(reviewsIndex.getById(record!.id)).toMatchObject({ rating: 5, opinion: 'even better', touched: true });
  });
});

describe('list_item', () => {
  it('"new" commits untouched, "update" commits touched', async () => {
    await applier.apply(
      item({ structureType: 'list_item', kind: 'new', category: 'quote', payload: { listType: 'quote', text: 'Say it plainly.', context: '', importance: null, eventTime: NOW, eventTimeExplicit: true } }),
      NOW,
    );
    const [record] = listsIndex.list({ limit: 10 });
    expect(record).toMatchObject({ text: 'Say it plainly.', touched: false });

    await applier.apply(
      item({ structureType: 'list_item', kind: 'update', targetRecordId: record!.id, payload: { listType: 'quote', text: 'Say it plainly, always.', context: '', importance: null, eventTime: NOW, eventTimeExplicit: true } }),
      NOW,
    );
    expect(listsIndex.getById(record!.id)).toMatchObject({ text: 'Say it plainly, always.', touched: true });
  });
});

describe('opinion_statement', () => {
  it('"new" commits untouched and regenerates the subject summary', async () => {
    await applier.apply(
      item({ structureType: 'opinion_statement', kind: 'new', category: 'philosophy', payload: { subject: 'philosophy', statement: 'Slow is fine.', kind: 'note', eventTime: NOW, eventTimeExplicit: true } }),
      NOW,
    );
    const [record] = opinionStatementsIndex.list({ limit: 10 });
    expect(record).toMatchObject({ subject: 'philosophy', statement: 'Slow is fine.', touched: false });
    // The summary pass actually ran for this subject.
    expect(opinionModelClient.prompts).toHaveLength(1);
    expect(opinionModelClient.prompts[0]).toContain('Slow is fine.');
  });

  it('"update" commits touched, mirrors, and regenerates the subject summary', async () => {
    opinionStatementsIndex.insertApproved({
      id: 'o1', entryId: 'e1', subject: 'philosophy', statement: 'Slow is fine.', kind: 'note',
      status: null, resolvedEntryId: null, resolution: null, resolvedAt: null,
      eventTime: NOW, eventEpochMs: Date.parse(NOW), eventTimeExplicit: true, extractedAt: NOW, touched: false,
    });
    await applier.apply(
      item({ structureType: 'opinion_statement', kind: 'update', targetRecordId: 'o1', category: 'philosophy', payload: { subject: 'philosophy', statement: 'Slow is better than fast.', eventTime: NOW, eventTimeExplicit: true } }),
      NOW,
    );
    expect(opinionStatementsIndex.getById('o1')).toMatchObject({ statement: 'Slow is better than fast.', touched: true });
    expect(blobs.files.has('derived/touched/opinion_statements/o1.json')).toBe(true);
  });

  it('"resolution" resolves the targeted question, mirrors it, and regenerates its subject summary', async () => {
    opinionStatementsIndex.insertApproved({
      id: 'q1', entryId: 'e1', subject: 'philosophy', statement: 'Should I take the job?', kind: 'question',
      status: 'open', resolvedEntryId: null, resolution: null, resolvedAt: null,
      eventTime: NOW, eventEpochMs: Date.parse(NOW), eventTimeExplicit: true, extractedAt: NOW, touched: false,
    });
    await applier.apply(
      item({ structureType: 'opinion_statement', kind: 'resolution', targetRecordId: 'q1', entryId: 'e2', category: null, payload: { resolution: 'Took the job.' } }),
      NOW,
    );
    expect(opinionStatementsIndex.getById('q1')).toMatchObject({
      status: 'resolved',
      resolvedEntryId: 'e2',
      resolution: 'Took the job.',
      touched: true,
    });
    expect(blobs.files.has('derived/touched/opinion_statements/q1.json')).toBe(true);
    expect(opinionModelClient.prompts).toHaveLength(1);
  });
});

describe('question', () => {
  it('"new" commits an open, untouched question', async () => {
    await applier.apply(
      item({ structureType: 'question', kind: 'new', category: null, payload: { question: 'Should I stay?', eventTime: NOW, eventTimeExplicit: true } }),
      NOW,
    );
    const [record] = questionsIndex.list({ limit: 10 });
    expect(record).toMatchObject({ question: 'Should I stay?', status: 'open', touched: false });
  });

  it('"resolution" resolves the target even though it is touched — the gap resolve() used to leave', async () => {
    questionsIndex.insertApproved({
      id: 'q1', entryId: 'e0', question: 'Should I stay?', eventTime: NOW, eventEpochMs: Date.parse(NOW),
      eventTimeExplicit: true, extractedAt: NOW, status: 'open', resolvedEntryId: null, resolution: null, resolvedAt: null, touched: true,
    });
    await applier.apply(
      item({ structureType: 'question', kind: 'resolution', targetRecordId: 'q1', entryId: 'e1', payload: { resolution: 'Decided to leave.' } }),
      NOW,
    );
    expect(questionsIndex.getById('q1')).toMatchObject({ status: 'resolved', resolvedEntryId: 'e1', resolution: 'Decided to leave.', touched: true });
    expect(blobs.files.has('derived/touched/questions/q1.json')).toBe(true);
  });
});

describe('todo', () => {
  it('"new" commits an open, untouched, extracted-origin todo', async () => {
    await applier.apply(
      item({ structureType: 'todo', kind: 'new', category: null, payload: { text: 'Call the dentist', eventTime: NOW, eventTimeExplicit: true } }),
      NOW,
    );
    const [record] = todosIndex.list({ limit: 10 });
    expect(record).toMatchObject({ text: 'Call the dentist', status: 'open', origin: 'extracted', touched: false });
  });

  it('"completion" completes the target even though it is touched — mirrors the todo_completion_suggestions bypass', async () => {
    todosIndex.insertApproved({
      id: 't1', entryId: 'e0', text: 'Call the dentist', eventTime: NOW, eventEpochMs: Date.parse(NOW),
      eventTimeExplicit: true, extractedAt: NOW, status: 'open', doneEntryId: null, resolution: null, doneAt: null, origin: 'extracted', touched: true,
    });
    await applier.apply(
      item({ structureType: 'todo', kind: 'completion', targetRecordId: 't1', entryId: 'e1', payload: { resolution: 'Called them.' } }),
      NOW,
    );
    expect(todosIndex.getById('t1')).toMatchObject({ status: 'done', doneEntryId: 'e1', resolution: 'Called them.', touched: true });
    expect(blobs.files.has('derived/touched/todos/t1.json')).toBe(true);
  });
});
