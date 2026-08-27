import { beforeEach, describe, expect, it } from 'vitest';
import { CategoriesIndex } from '../../src/index/categories-index.js';
import { ListsIndex } from '../../src/index/lists-index.js';
import { MetricFieldsIndex } from '../../src/index/metric-fields-index.js';
import { MetricsIndex } from '../../src/index/metrics-index.js';
import { OpinionStatementsIndex } from '../../src/index/opinion-statements-index.js';
import { OpinionSummariesIndex } from '../../src/index/opinion-summaries-index.js';
import { QuestionsIndex } from '../../src/index/questions-index.js';
import { ReviewsIndex } from '../../src/index/reviews-index.js';
import { TodosIndex } from '../../src/index/todos-index.js';
import { EntryProcessor } from '../../src/model/entry-processor.js';
import { Extractor } from '../../src/model/extractor.js';
import { ListsExtractor } from '../../src/model/lists-extractor.js';
import { LIST_TYPE_SEED_NAMES } from '../../src/model/lists.js';
import type { ExtractionRequest, ModelClient } from '../../src/model/model-client.js';
import { OpinionSummarizer } from '../../src/model/opinion-summarizer.js';
import { OPINION_SUMMARY_SYSTEM_PROMPT } from '../../src/model/opinion-summaries.js';
import { OpinionsExtractor } from '../../src/model/opinions-extractor.js';
import { OPINION_SUBJECT_SEED_NAMES } from '../../src/model/opinions.js';
import { QuestionsExtractor } from '../../src/model/questions-extractor.js';
import { ReviewsExtractor } from '../../src/model/reviews-extractor.js';
import { REVIEW_MEDIUM_SEED_NAMES } from '../../src/model/reviews.js';
import { METRIC_SEED_NAMES } from '../../src/model/temporal-metrics.js';
import { TodosExtractor } from '../../src/model/todos-extractor.js';

/**
 * Returns a superset canned response for every call, regardless of which
 * extractor's schema asked for it — every extractor only ever reads the
 * handful of fields its own schema defines, so one shared shape is enough
 * to exercise all six plus the summarizer. Real per-extractor judgement
 * (event-time resolution, touched-record protection, citation checking) is
 * each extractor's own test file's job; this file exercises `EntryProcessor`'s
 * orchestration only.
 */
class FakeModelClient implements ModelClient {
  calls: ExtractionRequest<unknown>[] = [];
  metrics: unknown[] = [];
  reviews: unknown[] = [];
  items: unknown[] = [];
  statements: { subject: string; statement: string; eventTime: null; eventTimeExplicit: false }[] = [];
  newQuestions: unknown[] = [];
  resolutions: unknown[] = [];
  newTodos: unknown[] = [];
  completions: unknown[] = [];
  parts: unknown[] = [];

  async extract<T>(request: ExtractionRequest<T>): Promise<T> {
    this.calls.push(request as ExtractionRequest<unknown>);
    return {
      metrics: this.metrics,
      reviews: this.reviews,
      items: this.items,
      statements: this.statements,
      newQuestions: this.newQuestions,
      resolutions: this.resolutions,
      newTodos: this.newTodos,
      completions: this.completions,
      parts: this.parts,
      suggestedCategory: null,
      suggestedField: null,
      suggestedFieldValue: null,
    } as unknown as T;
  }
}

const ENTRY = { id: 'entry-1', created: '2026-08-27T09:00:00+00:00', body: 'Ran 5k. Need to buy milk.' };

describe('EntryProcessor', () => {
  let modelClient: FakeModelClient;
  let processor: EntryProcessor;
  let opinionStatementsIndex: OpinionStatementsIndex;
  let opinionSummariesIndex: OpinionSummariesIndex;

  beforeEach(() => {
    modelClient = new FakeModelClient();
    const categoriesIndex = new CategoriesIndex(':memory:');
    const seededAt = '2026-01-01T00:00:00Z';
    categoriesIndex.seed('metric', METRIC_SEED_NAMES, seededAt);
    categoriesIndex.seed('review_medium', REVIEW_MEDIUM_SEED_NAMES, seededAt);
    categoriesIndex.seed('list_type', LIST_TYPE_SEED_NAMES, seededAt);
    categoriesIndex.seed('opinion_subject', OPINION_SUBJECT_SEED_NAMES, seededAt);
    const metricsIndex = new MetricsIndex(':memory:');
    const metricFieldsIndex = new MetricFieldsIndex(':memory:');
    const reviewsIndex = new ReviewsIndex(':memory:');
    const listsIndex = new ListsIndex(':memory:');
    opinionStatementsIndex = new OpinionStatementsIndex(':memory:');
    opinionSummariesIndex = new OpinionSummariesIndex(':memory:');
    const questionsIndex = new QuestionsIndex(':memory:');
    const todosIndex = new TodosIndex(':memory:');

    processor = new EntryProcessor(
      new Extractor(metricsIndex, metricFieldsIndex, categoriesIndex, modelClient),
      new ReviewsExtractor(reviewsIndex, categoriesIndex, modelClient),
      new ListsExtractor(listsIndex, categoriesIndex, modelClient),
      new OpinionsExtractor(opinionStatementsIndex, categoriesIndex, modelClient),
      new OpinionSummarizer(opinionSummariesIndex, opinionStatementsIndex, modelClient),
      new QuestionsExtractor(questionsIndex, modelClient),
      new TodosExtractor(todosIndex, modelClient),
    );
  });

  it('calls every extractor once for the entry and aggregates their counts', async () => {
    modelClient.metrics = [{ metric: 'run', detail: '5k', fields: {}, eventTime: null, eventTimeExplicit: false }];
    modelClient.newTodos = [{ text: 'buy milk', eventTime: null, eventTimeExplicit: false }];

    const result = await processor.processEntry(ENTRY);

    expect(result).toEqual({
      metricCount: 1,
      reviewCount: 0,
      itemCount: 0,
      statementCount: 0,
      questionCount: 0,
      todoCount: 1,
    });

    // Six extractors, one call each — the model was asked about this entry
    // from every angle, not looped or skipped.
    expect(modelClient.calls).toHaveLength(6);
    for (const call of modelClient.calls) {
      expect(call.prompt).toContain(ENTRY.body);
    }
  });

  it('resummarizes only the opinion subjects this entry actually touched', async () => {
    // A prior entry already left a statement on a subject this entry never
    // mentions — resummarizing it would be `summarizeAll`'s job, not this
    // one's, and it costs a real model call per subject.
    opinionStatementsIndex.replaceUntouchedForEntry('earlier-entry', [
      {
        id: 'stmt-earlier',
        subject: 'unrelated subject',
        statement: 'Something said before.',
        eventTime: '2026-08-01T09:00:00+00:00',
        eventEpochMs: Date.parse('2026-08-01T09:00:00+00:00'),
        eventTimeExplicit: false,
        extractedAt: '2026-08-01T09:00:00+00:00',
      },
    ]);

    modelClient.statements = [
      { subject: 'new subject', statement: 'Something said now.', eventTime: null, eventTimeExplicit: false },
    ];

    await processor.processEntry(ENTRY);

    const summaryCalls = modelClient.calls.filter((c) => c.system === OPINION_SUMMARY_SYSTEM_PROMPT);
    expect(summaryCalls).toHaveLength(1);
    expect(summaryCalls[0]!.prompt).toContain('new subject');
    expect(summaryCalls[0]!.prompt).not.toContain('unrelated subject');
  });

  it('is idempotent: calling it twice on the same fresh entry does not double-count untouched records', async () => {
    modelClient.metrics = [{ metric: 'run', detail: '5k', fields: {}, eventTime: null, eventTimeExplicit: false }];

    const first = await processor.processEntry(ENTRY);
    const second = await processor.processEntry(ENTRY);

    expect(first.metricCount).toBe(1);
    expect(second.metricCount).toBe(1);
  });
});
