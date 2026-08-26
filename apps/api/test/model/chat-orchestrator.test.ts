import { beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage } from '@journal/contract';
import { CategoriesIndex } from '../../src/index/categories-index.js';
import { ListsIndex, type ListItemRecord } from '../../src/index/lists-index.js';
import { MetricFieldsIndex } from '../../src/index/metric-fields-index.js';
import { MetricsIndex, type TemporalMetricRecord } from '../../src/index/metrics-index.js';
import { ReviewsIndex, type ReviewRecord } from '../../src/index/reviews-index.js';
import type {
  ChatClient,
  ChatCompletionRequest,
  ChatCompletionResult,
  ChatToolInvocation,
} from '../../src/model/chat-client.js';
import { ChatOrchestrator } from '../../src/model/chat-orchestrator.js';

/**
 * Plays a scripted plan of tool calls, in order — the fake plays the
 * model's part deterministically, the same way `FakeModelClient`
 * (`extractor.test.ts`) returns a queued result regardless of the prompt.
 * These tests exercise `ChatOrchestrator`'s own tool-wiring, `resultRef`
 * grounding, and validation logic — not a real model's judgement, which is
 * a live drill's job (mirroring `GatewayModelClient`'s own "confirmed by
 * hand" standard).
 *
 * Crucially, it actually calls the real `execute()` functions
 * `ChatOrchestrator` builds — that is where the logic worth testing lives —
 * rather than only recording that a tool *would* have been called.
 */
class FakeChatClient implements ChatClient {
  requests: ChatCompletionRequest[] = [];
  plan: Array<{ toolName: string; args: unknown }> = [];
  finalText = 'Here is what I found.';

  async complete(request: ChatCompletionRequest): Promise<ChatCompletionResult> {
    this.requests.push(request);
    const toolInvocations: ChatToolInvocation[] = [];
    for (const step of this.plan) {
      const tool = request.tools[step.toolName];
      if (!tool) throw new Error(`test plan references unknown tool '${step.toolName}'`);
      const result = await tool.execute(step.args);
      toolInvocations.push({ toolName: step.toolName, args: step.args, result });
    }
    return { text: this.finalText, toolInvocations };
  }
}

const record = (overrides: Partial<Omit<TemporalMetricRecord, 'entryId'>> = {}): Omit<TemporalMetricRecord, 'entryId'> => ({
  id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  metric: 'exercise',
  eventTime: new Date().toISOString(),
  eventEpochMs: Date.now(),
  eventTimeExplicit: true,
  detail: 'a run',
  fields: {},
  extractedAt: new Date().toISOString(),
  touched: false,
  ...overrides,
});

const reviewRecord = (overrides: Partial<Omit<ReviewRecord, 'entryId'>> = {}): Omit<ReviewRecord, 'entryId'> => ({
  id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  title: 'Some film',
  medium: 'film',
  rating: 4,
  progress: 100,
  opinion: 'Enjoyed it.',
  eventTime: new Date().toISOString(),
  eventEpochMs: Date.now(),
  eventTimeExplicit: true,
  extractedAt: new Date().toISOString(),
  touched: false,
  ...overrides,
});

const listItemRecord = (overrides: Partial<Omit<ListItemRecord, 'entryId'>> = {}): Omit<ListItemRecord, 'entryId'> => ({
  id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  listType: 'quote',
  text: 'Something worth keeping.',
  context: 'said in passing',
  importance: 3,
  eventTime: new Date().toISOString(),
  eventEpochMs: Date.now(),
  eventTimeExplicit: true,
  extractedAt: new Date().toISOString(),
  touched: false,
  ...overrides,
});

const userMessage = (content: string): ChatMessage[] => [{ role: 'user', content }];

let metricsIndex: MetricsIndex;
let metricFieldsIndex: MetricFieldsIndex;
let reviewsIndex: ReviewsIndex;
let listsIndex: ListsIndex;
let categoriesIndex: CategoriesIndex;
let chatClient: FakeChatClient;
let orchestrator: ChatOrchestrator;

beforeEach(() => {
  metricsIndex = new MetricsIndex(':memory:');
  metricFieldsIndex = new MetricFieldsIndex(':memory:');
  reviewsIndex = new ReviewsIndex(':memory:');
  listsIndex = new ListsIndex(':memory:');
  categoriesIndex = new CategoriesIndex(':memory:');
  categoriesIndex.seed('metric', ['exercise', 'sleep'], '2026-01-01T00:00:00Z');
  categoriesIndex.seed('review_medium', ['film', 'book'], '2026-01-01T00:00:00Z');
  categoriesIndex.seed('list_type', ['quote'], '2026-01-01T00:00:00Z');
  chatClient = new FakeChatClient();
  orchestrator = new ChatOrchestrator(chatClient, metricsIndex, metricFieldsIndex, reviewsIndex, listsIndex, categoriesIndex);
});

describe('answer', () => {
  it('sends the conversation and the currently approved categories to the model', async () => {
    await orchestrator.answer(userMessage('How much have I exercised?'));
    expect(chatClient.requests).toHaveLength(1);
    expect(chatClient.requests[0]!.messages).toEqual(userMessage('How much have I exercised?'));
    expect(chatClient.requests[0]!.system).toContain('exercise');
    expect(chatClient.requests[0]!.system).toContain('sleep');
    expect(chatClient.requests[0]!.system).toContain('film');
    expect(chatClient.requests[0]!.system).toContain('quote');
  });

  it('sends a defined metric field, described, in the system prompt', async () => {
    metricFieldsIndex.define({
      id: 'f1',
      metric: 'exercise',
      fieldKey: 'distance_km',
      label: 'Distance',
      fieldType: 'numeric',
      unit: 'km',
      scoreMin: null,
      scoreMax: null,
      description: 'How far, in km.',
      now: '2026-07-20T09:00:00Z',
    });
    await orchestrator.answer(userMessage('hi'));
    expect(chatClient.requests[0]!.system).toContain('distance_km');
    expect(chatClient.requests[0]!.system).toContain('How far, in km.');
  });

  it('flows a summarizeMetrics result into renderSparkline by resultRef — the real seeded numbers, not the model\'s text', async () => {
    metricsIndex.replaceEntry('e1', [record({ id: 'm1' }), record({ id: 'm2' })]);
    chatClient.plan = [
      { toolName: 'summarizeMetrics', args: {} },
      { toolName: 'renderSparkline', args: { resultRef: 'r1', title: 'Exercise trend', metric: 'exercise' } },
    ];
    chatClient.finalText = "You've been keeping active.";

    const response = await orchestrator.answer(userMessage('How much have I exercised?'));

    expect(response.answer).toBe("You've been keeping active.");
    expect(response.charts).toHaveLength(1);
    const [chart] = response.charts;
    if (!chart) throw new Error('expected a chart');
    expect(chart).toMatchObject({ type: 'sparkline', title: 'Exercise trend', unit: null, totalLabel: '2 total' });
    if (chart.type === 'sparkline') {
      expect(chart.points.reduce((sum, point) => sum + point.value, 0)).toBe(2);
    }
  });

  it('degrades an unknown resultRef to no chart, without throwing', async () => {
    chatClient.plan = [
      { toolName: 'renderSparkline', args: { resultRef: 'nonexistent', title: 'X', metric: 'exercise' } },
    ];

    const response = await orchestrator.answer(userMessage('chart it'));
    expect(response.charts).toEqual([]);
  });

  it('degrades a metric not present in the referenced result to no chart, without throwing', async () => {
    metricsIndex.replaceEntry('e1', [record({ metric: 'exercise' })]);
    chatClient.plan = [
      { toolName: 'summarizeMetrics', args: {} },
      { toolName: 'renderSparkline', args: { resultRef: 'r1', title: 'X', metric: 'meditation' } },
    ];

    const response = await orchestrator.answer(userMessage('chart meditation'));
    expect(response.charts).toEqual([]);
  });

  it('has no citedEntryIds when only summarize-shaped tools were called', async () => {
    metricsIndex.replaceEntry('e1', [record()]);
    chatClient.plan = [
      { toolName: 'summarizeMetrics', args: {} },
      { toolName: 'renderSparkline', args: { resultRef: 'r1', title: 'X', metric: 'exercise' } },
    ];

    const response = await orchestrator.answer(userMessage('how much exercise'));
    expect(response.citedEntryIds).toEqual([]);
  });

  it('produces no charts and no citations when the model calls no tools at all', async () => {
    chatClient.finalText = 'Nothing in your journal answers that.';
    const response = await orchestrator.answer(userMessage('what is the meaning of life'));
    expect(response).toEqual({ answer: 'Nothing in your journal answers that.', charts: [], citedEntryIds: [] });
  });

  describe('sumMetricField', () => {
    beforeEach(() => {
      metricFieldsIndex.define({
        id: 'f1',
        metric: 'exercise',
        fieldKey: 'distance_km',
        label: 'Distance',
        fieldType: 'numeric',
        unit: 'km',
        scoreMin: null,
        scoreMax: null,
        description: 'How far, in km.',
        now: '2026-07-20T09:00:00Z',
      });
    });

    it('flows the real seeded sum into renderStatTile by resultRef', async () => {
      metricsIndex.replaceEntry('e1', [record({ id: 'm1', fields: { distance_km: 5 } })]);
      metricsIndex.replaceEntry('e2', [record({ id: 'm2', fields: { distance_km: 3 } })]);
      chatClient.plan = [
        { toolName: 'sumMetricField', args: { metric: 'exercise', fieldKey: 'distance_km' } },
        { toolName: 'renderStatTile', args: { resultRef: 'r1', label: 'Total distance', field: 'total' } },
      ];

      const response = await orchestrator.answer(userMessage('how far have I run'));
      expect(response.charts).toEqual([{ type: 'stat_tile', label: 'Total distance', value: 8, unit: null }]);
    });

    it('degrades a non-numeric field to unknown_field, without throwing or charting', async () => {
      metricFieldsIndex.define({
        id: 'f2',
        metric: 'exercise',
        fieldKey: 'sport',
        label: 'Sport',
        fieldType: 'enum',
        unit: null,
        scoreMin: null,
        scoreMax: null,
        description: 'Which sport.',
        now: '2026-07-20T09:00:00Z',
      });
      chatClient.plan = [{ toolName: 'sumMetricField', args: { metric: 'exercise', fieldKey: 'sport' } }];
      const response = await orchestrator.answer(userMessage('sum sport'));
      expect(response.charts).toEqual([]);
    });

    it('degrades a field that does not exist the same way — sharing resolveNumericField with the HTTP route', async () => {
      chatClient.plan = [{ toolName: 'sumMetricField', args: { metric: 'exercise', fieldKey: 'nonexistent' } }];
      const response = await orchestrator.answer(userMessage('sum nonexistent'));
      expect(response.charts).toEqual([]);
    });
  });

  it('renders a sparkline from a sumMetricField result directly, without a metric arg', async () => {
    metricFieldsIndex.define({
      id: 'f1',
      metric: 'exercise',
      fieldKey: 'distance_km',
      label: 'Distance',
      fieldType: 'numeric',
      unit: 'km',
      scoreMin: null,
      scoreMax: null,
      description: 'How far.',
      now: '2026-07-20T09:00:00Z',
    });
    metricsIndex.replaceEntry('e1', [record({ id: 'm1', fields: { distance_km: 5 } })]);
    chatClient.plan = [
      { toolName: 'sumMetricField', args: { metric: 'exercise', fieldKey: 'distance_km' } },
      { toolName: 'renderSparkline', args: { resultRef: 'r1', title: 'Distance trend' } },
    ];

    const response = await orchestrator.answer(userMessage('chart my distance'));
    expect(response.charts).toHaveLength(1);
    const [chart] = response.charts;
    if (!chart || chart.type !== 'sparkline') throw new Error('expected a sparkline');
    expect(chart.points.reduce((sum, point) => sum + point.value, 0)).toBe(5);
  });

  it('flows summarizeReviews into renderBarComparison, one bar per medium', async () => {
    reviewsIndex.replaceEntry('e1', [reviewRecord({ id: 'r1', medium: 'film', rating: 4 })]);
    reviewsIndex.replaceEntry('e2', [reviewRecord({ id: 'r2', medium: 'book', rating: 5 })]);
    chatClient.plan = [
      { toolName: 'summarizeReviews', args: {} },
      { toolName: 'renderBarComparison', args: { resultRef: 'r1', title: 'Reviews by medium', valueField: 'count' } },
    ];

    const response = await orchestrator.answer(userMessage('compare my media'));
    expect(response.charts).toEqual([
      {
        type: 'bar_comparison',
        title: 'Reviews by medium',
        unit: null,
        // `approvedNames` sorts alphabetically (`categories-index.ts`), so
        // 'book' precedes 'film' regardless of seed order.
        bars: [
          { label: 'book', value: 1 },
          { label: 'film', value: 1 },
        ],
      },
    ]);
  });

  it('flows listReviews into renderTable, dropping unrecognised columns and carrying entryId for citation', async () => {
    reviewsIndex.replaceEntry('e1', [reviewRecord({ id: 'r1', title: 'A great film', medium: 'film', rating: 5 })]);
    chatClient.plan = [
      { toolName: 'listReviews', args: { medium: 'film' } },
      {
        toolName: 'renderTable',
        args: { resultRef: 'r1', title: 'My films', columns: ['title', 'rating', 'nonsenseColumn'] },
      },
    ];

    const response = await orchestrator.answer(userMessage('what films have I reviewed'));
    expect(response.charts).toEqual([
      {
        type: 'table',
        title: 'My films',
        columns: [
          { key: 'title', label: 'Title' },
          { key: 'rating', label: 'Rating' },
        ],
        rows: [{ values: { title: 'A great film', rating: 5 }, entryId: 'e1' }],
      },
    ]);
  });

  it('collects citedEntryIds from listReviews and listItems, deduplicated, but not from summarize* tools', async () => {
    reviewsIndex.replaceEntry('e1', [reviewRecord({ id: 'r1' })]);
    listsIndex.replaceEntry('e1', [listItemRecord({ id: 'q1' })]);
    listsIndex.replaceEntry('e2', [listItemRecord({ id: 'q2' })]);
    chatClient.plan = [
      { toolName: 'summarizeReviews', args: {} },
      { toolName: 'listReviews', args: {} },
      { toolName: 'listItems', args: {} },
    ];

    const response = await orchestrator.answer(userMessage('what have I been reviewing and quoting'));
    expect(response.citedEntryIds).toEqual(['e1', 'e2']);
  });

  it('flows summarizeLists into renderStatTile via entryName', async () => {
    listsIndex.replaceEntry('e1', [listItemRecord({ id: 'q1' })]);
    listsIndex.replaceEntry('e2', [listItemRecord({ id: 'q2' })]);
    chatClient.plan = [
      { toolName: 'summarizeLists', args: {} },
      { toolName: 'renderStatTile', args: { resultRef: 'r1', label: 'Quotes', field: 'count', entryName: 'quote' } },
    ];

    const response = await orchestrator.answer(userMessage('how many quotes'));
    expect(response.charts).toEqual([{ type: 'stat_tile', label: 'Quotes', value: 2, unit: null }]);
  });
});
