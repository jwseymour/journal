import { beforeEach, describe, expect, it } from 'vitest';
import { CategoriesIndex } from '../../src/index/categories-index.js';
import { ListsIndex } from '../../src/index/lists-index.js';
import { MetricFieldsIndex } from '../../src/index/metric-fields-index.js';
import { MetricsIndex } from '../../src/index/metrics-index.js';
import { OpinionStatementsIndex } from '../../src/index/opinion-statements-index.js';
import { PendingItemsIndex } from '../../src/index/pending-items-index.js';
import { QuestionsIndex } from '../../src/index/questions-index.js';
import { ReviewsIndex } from '../../src/index/reviews-index.js';
import { TodosIndex } from '../../src/index/todos-index.js';
import { Extractor } from '../../src/model/extractor.js';
import { ListsExtractor } from '../../src/model/lists-extractor.js';
import { LIST_TYPE_SEED_NAMES } from '../../src/model/lists.js';
import type { ExtractionRequest, ModelClient } from '../../src/model/model-client.js';
import { OpinionsExtractor } from '../../src/model/opinions-extractor.js';
import { OPINION_SUBJECT_SEED_NAMES } from '../../src/model/opinions.js';
import { LivePendingProcessor } from '../../src/model/pending-processor.js';
import { QuestionsExtractor } from '../../src/model/questions-extractor.js';
import { ReviewsExtractor } from '../../src/model/reviews-extractor.js';
import { REVIEW_MEDIUM_SEED_NAMES } from '../../src/model/reviews.js';
import { METRIC_SEED_NAMES } from '../../src/model/temporal-metrics.js';
import { TodosExtractor } from '../../src/model/todos-extractor.js';

/** One result-driven fake per extractor that takes a static
 * `Partial<T>` — the metric/review/list/opinion shape. Each extractor gets
 * its own instance, so tests never need to distinguish calls by prompt. */
class StaticFakeModelClient implements ModelClient {
  calls: ExtractionRequest<unknown>[] = [];
  result: Record<string, unknown> = {};

  async extract<T>(request: ExtractionRequest<T>): Promise<T> {
    this.calls.push(request as ExtractionRequest<unknown>);
    return this.result as unknown as T;
  }
}

/** Questions/todos need to read ids back out of the prompt they were just
 * offered, same as their own extractor test files. Defaults both array
 * fields to `[]` the same way the real schema always would, since this fake
 * bypasses Zod validation entirely. */
class QuestionModelClient implements ModelClient {
  handler: (prompt: string) => Record<string, unknown> = () => ({});

  async extract<T>(request: ExtractionRequest<T>): Promise<T> {
    return { newQuestions: [], resolutions: [], ...this.handler(request.prompt) } as unknown as T;
  }
}

class TodoModelClient implements ModelClient {
  handler: (prompt: string) => Record<string, unknown> = () => ({});

  async extract<T>(request: ExtractionRequest<T>): Promise<T> {
    return { newTodos: [], completions: [], ...this.handler(request.prompt) } as unknown as T;
  }
}

let pendingItems: PendingItemsIndex;
let metricsIndex: MetricsIndex;
let metricFieldsIndex: MetricFieldsIndex;
let reviewsIndex: ReviewsIndex;
let listsIndex: ListsIndex;
let opinionStatementsIndex: OpinionStatementsIndex;
let questionsIndex: QuestionsIndex;
let todosIndex: TodosIndex;
let categoriesIndex: CategoriesIndex;

let metricClient: StaticFakeModelClient;
let reviewClient: StaticFakeModelClient;
let listClient: StaticFakeModelClient;
let opinionClient: StaticFakeModelClient;
let questionClient: QuestionModelClient;
let todoClient: TodoModelClient;

let processor: LivePendingProcessor;

const entry = (id: string, body = 'x', created = '2026-07-20T09:00:00+01:00') => ({ id, created, body });

beforeEach(() => {
  pendingItems = new PendingItemsIndex(':memory:');
  metricsIndex = new MetricsIndex(':memory:');
  metricFieldsIndex = new MetricFieldsIndex(':memory:');
  reviewsIndex = new ReviewsIndex(':memory:');
  listsIndex = new ListsIndex(':memory:');
  opinionStatementsIndex = new OpinionStatementsIndex(':memory:');
  questionsIndex = new QuestionsIndex(':memory:');
  todosIndex = new TodosIndex(':memory:');
  categoriesIndex = new CategoriesIndex(':memory:');
  categoriesIndex.seed('metric', METRIC_SEED_NAMES, '2026-01-01T00:00:00Z');
  categoriesIndex.seed('review_medium', REVIEW_MEDIUM_SEED_NAMES, '2026-01-01T00:00:00Z');
  categoriesIndex.seed('list_type', LIST_TYPE_SEED_NAMES, '2026-01-01T00:00:00Z');
  categoriesIndex.seed('opinion_subject', OPINION_SUBJECT_SEED_NAMES, '2026-01-01T00:00:00Z');

  metricClient = new StaticFakeModelClient();
  metricClient.result = { metrics: [], suggestedCategory: null, suggestedField: null, suggestedFieldValue: null };
  reviewClient = new StaticFakeModelClient();
  reviewClient.result = { reviews: [], suggestedCategory: null };
  listClient = new StaticFakeModelClient();
  listClient.result = { items: [], suggestedCategory: null };
  opinionClient = new StaticFakeModelClient();
  opinionClient.result = { statements: [], resolutions: [], suggestedCategory: null };
  questionClient = new QuestionModelClient();
  todoClient = new TodoModelClient();

  processor = new LivePendingProcessor(
    pendingItems,
    metricsIndex,
    new Extractor(metricsIndex, metricFieldsIndex, categoriesIndex, metricClient),
    reviewsIndex,
    new ReviewsExtractor(reviewsIndex, categoriesIndex, reviewClient),
    listsIndex,
    new ListsExtractor(listsIndex, categoriesIndex, listClient),
    opinionStatementsIndex,
    new OpinionsExtractor(opinionStatementsIndex, categoriesIndex, opinionClient),
    questionsIndex,
    new QuestionsExtractor(questionsIndex, questionClient),
    todosIndex,
    new TodosExtractor(todosIndex, todoClient),
  );
});

describe('processEntry — nothing commits, everything becomes pending', () => {
  it('produces a "new" pending item for a fresh metric, with nothing written to the live index', async () => {
    metricClient.result = {
      metrics: [{ metric: 'exercise', eventTime: '2026-07-20T07:00:00+01:00', eventTimeExplicit: true, detail: 'a run', fields: {}, confidence: 'high', confidenceReason: null }],
      suggestedCategory: null,
      suggestedField: null,
      suggestedFieldValue: null,
    };

    const { pendingItemCount, processRunId } = await processor.processEntry(entry('e1', 'Went for a run.'));

    expect(pendingItemCount).toBe(1);
    expect(metricsIndex.list({ limit: 10 })).toEqual([]);

    const [item] = pendingItems.list({ entryId: 'e1' });
    expect(item).toMatchObject({
      entryId: 'e1',
      processRunId,
      structureType: 'metric',
      kind: 'new',
      targetRecordId: null,
      category: 'exercise',
      confidence: 'high',
      status: 'pending',
    });
    expect(item!.payload).toMatchObject({ metric: 'exercise', detail: 'a run' });
  });

  it('produces "new" pending items across every structure type in one run', async () => {
    metricClient.result = { metrics: [{ metric: 'exercise', eventTime: '2026-07-20T07:00:00+01:00', eventTimeExplicit: true, detail: 'run', fields: {}, confidence: 'high', confidenceReason: null }], suggestedCategory: null, suggestedField: null, suggestedFieldValue: null };
    reviewClient.result = { reviews: [{ title: 'A Film', medium: 'film', rating: 4, progress: 100, opinion: 'good', eventTime: '2026-07-20T07:00:00+01:00', eventTimeExplicit: true, confidence: 'high', confidenceReason: null }], suggestedCategory: null };
    listClient.result = { items: [{ listType: 'quote', text: 'x', context: '', importance: null, eventTime: '2026-07-20T07:00:00+01:00', eventTimeExplicit: true, confidence: 'high', confidenceReason: null }], suggestedCategory: null };
    opinionClient.result = { statements: [{ subject: 'philosophy', statement: 'x', eventTime: '2026-07-20T07:00:00+01:00', eventTimeExplicit: true, kind: 'note', confidence: 'high', confidenceReason: null }], resolutions: [], suggestedCategory: null };
    questionClient.handler = () => ({ newQuestions: [{ question: 'Should I?', eventTime: '2026-07-20T07:00:00+01:00', eventTimeExplicit: true, confidence: 'high', confidenceReason: null }] });
    todoClient.handler = () => ({ newTodos: [{ text: 'Do the thing', eventTime: '2026-07-20T07:00:00+01:00', eventTimeExplicit: true, confidence: 'high', confidenceReason: null }] });

    const { pendingItemCount } = await processor.processEntry(entry('e1'));

    expect(pendingItemCount).toBe(6);
    const byType = new Set(pendingItems.list({ entryId: 'e1' }).map((i) => i.structureType));
    expect(byType).toEqual(new Set(['metric', 'review', 'list_item', 'opinion_statement', 'question', 'todo']));

    // Nothing at all committed to any live index.
    expect(metricsIndex.list({ limit: 10 })).toEqual([]);
    expect(reviewsIndex.list({ limit: 10 })).toEqual([]);
    expect(listsIndex.list({ limit: 10 })).toEqual([]);
    expect(opinionStatementsIndex.list({ limit: 10 })).toEqual([]);
    expect(questionsIndex.list({ limit: 10 })).toEqual([]);
    expect(todosIndex.list({ limit: 10 })).toEqual([]);
  });

  it('produces nothing when every extractor finds nothing', async () => {
    const { pendingItemCount } = await processor.processEntry(entry('e1'));
    expect(pendingItemCount).toBe(0);
  });

  it('drops a "low" confidence candidate before it ever becomes a pending item, but keeps "medium" and "high" ones from the same run', async () => {
    metricClient.result = {
      metrics: [
        { metric: 'exercise', eventTime: '2026-07-20T07:00:00+01:00', eventTimeExplicit: true, detail: 'a run', fields: {}, confidence: 'low', confidenceReason: 'vague mention' },
        { metric: 'sleep', eventTime: '2026-07-20T22:00:00+01:00', eventTimeExplicit: true, detail: 'early night', fields: {}, confidence: 'medium', confidenceReason: null },
      ],
      suggestedCategory: null,
      suggestedField: null,
      suggestedFieldValue: null,
    };

    const { pendingItemCount } = await processor.processEntry(entry('e1'));

    expect(pendingItemCount).toBe(1);
    const items = pendingItems.list({ entryId: 'e1' });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ category: 'sleep', confidence: 'medium' });
  });
});

describe('processEntry — diffing against already-live records (the actual point of M18)', () => {
  it('proposes an "update" against an already-approved, still-untouched live metric rather than duplicating it', async () => {
    // Simulate an earlier approved batch: a live, untouched metric exists.
    metricsIndex.insertApproved({
      id: 'm1',
      entryId: 'e1',
      metric: 'exercise',
      eventTime: '2026-07-20T07:00:00+01:00',
      eventEpochMs: Date.parse('2026-07-20T07:00:00+01:00'),
      eventTimeExplicit: true,
      detail: 'a run',
      fields: {},
      extractedAt: '2026-07-20T07:00:00+01:00',
      touched: false,
    });

    metricClient.result = {
      metrics: [{ metric: 'exercise', eventTime: '2026-07-20T07:00:00+01:00', eventTimeExplicit: true, detail: 'a 10k run', fields: {}, confidence: 'high', confidenceReason: null }],
      suggestedCategory: null,
      suggestedField: null,
      suggestedFieldValue: null,
    };
    await processor.processEntry(entry('e1', 'Revised: it was a 10k.'));

    const items = pendingItems.list({ entryId: 'e1' });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'update', targetRecordId: 'm1' });
    expect(items[0]!.payload).toMatchObject({ detail: 'a 10k run' });
    // Still untouched, still saying the old thing — nothing applied yet.
    expect(metricsIndex.getById('m1')).toMatchObject({ detail: 'a run', touched: false });
  });

  it('proposes no update when the untouched live record already matches', async () => {
    metricsIndex.insertApproved({
      id: 'm1', entryId: 'e1', metric: 'exercise', eventTime: '2026-07-20T07:00:00+01:00',
      eventEpochMs: Date.parse('2026-07-20T07:00:00+01:00'), eventTimeExplicit: true, detail: 'a run', fields: {},
      extractedAt: '2026-07-20T07:00:00+01:00', touched: false,
    });
    metricClient.result = {
      metrics: [{ metric: 'exercise', eventTime: '2026-07-20T07:00:00+01:00', eventTimeExplicit: true, detail: 'a run', fields: {}, confidence: 'high', confidenceReason: null }],
      suggestedCategory: null, suggestedField: null, suggestedFieldValue: null,
    };
    await processor.processEntry(entry('e1'));
    expect(pendingItems.list({ entryId: 'e1' })).toEqual([]);
  });

  it('still proposes an "update" against a touched live record, same as before M18', async () => {
    metricsIndex.insertApproved({
      id: 'm1', entryId: 'e1', metric: 'exercise', eventTime: '2026-07-20T07:00:00+01:00',
      eventEpochMs: Date.parse('2026-07-20T07:00:00+01:00'), eventTimeExplicit: true, detail: 'a run', fields: {},
      extractedAt: '2026-07-20T07:00:00+01:00', touched: true,
    });
    metricClient.result = {
      metrics: [{ metric: 'exercise', eventTime: '2026-07-20T07:00:00+01:00', eventTimeExplicit: true, detail: 'a 10k run', fields: {}, confidence: 'high', confidenceReason: null }],
      suggestedCategory: null, suggestedField: null, suggestedFieldValue: null,
    };
    await processor.processEntry(entry('e1'));
    const items = pendingItems.list({ entryId: 'e1' });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'update', targetRecordId: 'm1' });
  });

  it('does not guess a match when live and candidate counts disagree — leaves the live record alone and produces "new" only for genuinely un-matched candidates', async () => {
    metricsIndex.insertApproved({
      id: 'm1', entryId: 'e1', metric: 'exercise', eventTime: '2026-07-20T07:00:00+01:00',
      eventEpochMs: Date.parse('2026-07-20T07:00:00+01:00'), eventTimeExplicit: true, detail: 'a run', fields: {},
      extractedAt: '2026-07-20T07:00:00+01:00', touched: false,
    });
    metricClient.result = {
      metrics: [
        { metric: 'exercise', eventTime: '2026-07-20T07:00:00+01:00', eventTimeExplicit: true, detail: 'a run', fields: {}, confidence: 'high', confidenceReason: null },
        { metric: 'exercise', eventTime: '2026-07-20T18:00:00+01:00', eventTimeExplicit: true, detail: 'an evening walk', fields: {}, confidence: 'high', confidenceReason: null },
      ],
      suggestedCategory: null, suggestedField: null, suggestedFieldValue: null,
    };
    await processor.processEntry(entry('e1'));

    const items = pendingItems.list({ entryId: 'e1' });
    // Conservative, same posture as pre-M18: counts don't align 1:1, so both
    // candidates become "new" rather than one being guessed as an update.
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.kind === 'new')).toBe(true);
  });
});

describe('processEntry — questions/todos: resolution and completion against a touched target now produce a pending item instead of silently dropping', () => {
  it('produces a "resolution" pending item for a touched, still-open question — the gap QuestionsIndex.resolve() used to leave', async () => {
    questionsIndex.insertApproved({
      id: 'q1', entryId: 'e1', question: 'Should I stay in this job?', eventTime: '2026-07-20T07:00:00+01:00',
      eventEpochMs: Date.parse('2026-07-20T07:00:00+01:00'), eventTimeExplicit: true, extractedAt: '2026-07-20T07:00:00+01:00',
      status: 'open', resolvedEntryId: null, resolution: null, resolvedAt: null, touched: true,
    });

    questionClient.handler = () => ({
      resolutions: [{ questionId: 'q1', resolution: 'Decided to leave.', confidence: 'high', confidenceReason: null }],
    });
    await processor.processEntry(entry('e2', 'Finally decided to leave.'));

    const items = pendingItems.list({ entryId: 'e2' });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ structureType: 'question', kind: 'resolution', targetRecordId: 'q1' });
    // Not silently applied — the old pre-M18 gap resolve() itself still has;
    // resolveApproved (used only by the applier) is what closes it.
    expect(questionsIndex.getById('q1')).toMatchObject({ status: 'open' });
  });

  it('produces a "completion" pending item for a touched, still-open todo', async () => {
    todosIndex.insertApproved({
      id: 't1', entryId: 'e1', text: 'Call the dentist', eventTime: '2026-07-20T07:00:00+01:00',
      eventEpochMs: Date.parse('2026-07-20T07:00:00+01:00'), eventTimeExplicit: true, extractedAt: '2026-07-20T07:00:00+01:00',
      status: 'open', doneEntryId: null, resolution: null, doneAt: null, origin: 'extracted', touched: true,
    });

    todoClient.handler = () => ({
      completions: [{ todoId: 't1', resolution: 'Called them.', confidence: 'high', confidenceReason: null }],
    });
    await processor.processEntry(entry('e2', 'Called the dentist.'));

    const items = pendingItems.list({ entryId: 'e2' });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ structureType: 'todo', kind: 'completion', targetRecordId: 't1' });
    expect(todosIndex.getById('t1')).toMatchObject({ status: 'open' });
  });

  it('drops a resolution/completion citing an id that was never actually offered as open', async () => {
    questionClient.handler = () => ({
      resolutions: [{ questionId: 'not-real', resolution: 'x', confidence: 'high', confidenceReason: null }],
    });
    await processor.processEntry(entry('e1'));
    expect(pendingItems.list({ entryId: 'e1' })).toEqual([]);
  });

  it('produces a "resolution" pending item for an open kind: "question" opinion statement — the per-person conversation-topics conjunction (requirements.md §11, resolved 2026-08-30)', async () => {
    opinionStatementsIndex.insertApproved({
      id: 'oq1', entryId: 'e1', subject: 'philosophy', statement: 'Should I take the job?', kind: 'question',
      eventTime: '2026-07-20T07:00:00+01:00', eventEpochMs: Date.parse('2026-07-20T07:00:00+01:00'), eventTimeExplicit: true,
      extractedAt: '2026-07-20T07:00:00+01:00', status: 'open', resolvedEntryId: null, resolution: null, resolvedAt: null, touched: false,
    });

    opinionClient.result = {
      statements: [],
      resolutions: [{ statementId: 'oq1', resolution: 'Took the job.', confidence: 'high', confidenceReason: null }],
      suggestedCategory: null,
    };
    await processor.processEntry(entry('e2', 'Took the job today.'));

    const items = pendingItems.list({ entryId: 'e2' });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ structureType: 'opinion_statement', kind: 'resolution', targetRecordId: 'oq1', category: null });
    // Not silently applied — same "approval closes it" shape as questions.
    expect(opinionStatementsIndex.getById('oq1')).toMatchObject({ status: 'open' });
  });
});

describe('processEntry — supersede on rerun', () => {
  it('marks a previous run’s still-pending items superseded, leaving already-decided ones alone', async () => {
    metricClient.result = {
      metrics: [{ metric: 'exercise', eventTime: '2026-07-20T07:00:00+01:00', eventTimeExplicit: true, detail: 'a run', fields: {}, confidence: 'high', confidenceReason: null }],
      suggestedCategory: null, suggestedField: null, suggestedFieldValue: null,
    };
    const first = await processor.processEntry(entry('e1'));
    const [firstItem] = pendingItems.list({ entryId: 'e1' });
    expect(firstItem!.processRunId).toBe(first.processRunId);

    const second = await processor.processEntry(entry('e1', 'edited'));

    expect(pendingItems.getById(firstItem!.id)).toMatchObject({ status: 'superseded' });
    const currentlyPending = pendingItems.list({ entryId: 'e1', status: 'pending' });
    expect(currentlyPending.every((i) => i.processRunId === second.processRunId)).toBe(true);
  });
});
