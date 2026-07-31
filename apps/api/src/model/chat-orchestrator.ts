import { z } from 'zod';
import type {
  BarComparisonBar,
  BarComparisonChartSpec,
  ChatMessage,
  ChatResponse,
  ChartSpec,
  SparklineChartSpec,
  SparklinePoint,
  StatTileChartSpec,
  TableChartSpec,
  TableColumn,
  TableRow,
} from '@journal/contract';
import type { CategoriesReader } from '../index/categories-index.js';
import { resolveNumericField, type MetricFieldDefinition, type MetricFieldsReader } from '../index/metric-fields-index.js';
import type { MetricsReader } from '../index/metrics-index.js';
import type { ListItemsReader } from '../index/lists-index.js';
import type { ReviewsReader } from '../index/reviews-index.js';
import type { ChatClient, ChatTool, ChatToolInvocation } from './chat-client.js';

/** Same window `GET /analysis/metrics` uses (`http/app.ts`'s
 * `METRICS_SUMMARY_WINDOW_DAYS`) — a month is enough to show a real pattern
 * without asking for an unbounded query by default. */
const DEFAULT_WINDOW_DAYS = 30;
const MAX_WINDOW_DAYS = 3650;
/** Same ceiling `GET /reviews`/`GET /lists` use — a chat answer summarising
 * "a few recent things" has no reason to ask for more than a page. */
const MAX_LIST_LIMIT = 50;
const DEFAULT_LIST_LIMIT = 20;

const STAT_TILE_FIELDS = ['total', 'average', 'count', 'totalCount', 'averageRating'] as const;
const REVIEW_TABLE_COLUMNS = ['title', 'medium', 'rating', 'progress', 'opinion', 'eventTime'] as const;
const LIST_ITEM_TABLE_COLUMNS = ['listType', 'text', 'context', 'importance', 'eventTime'] as const;

export interface ChatAnswerer {
  answer(messages: ChatMessage[]): Promise<ChatResponse>;
}

/**
 * The `Extractor` of the chat feature ("further features", `requirements.md`
 * §8): builds the system prompt, builds the tool set from the same
 * `*Reader` interfaces `http/app.ts` already depends on, drives
 * `ChatClient.complete`, and turns the tool calls the model actually made
 * into a `ChatResponse`.
 *
 * The model is never trusted to retype a number from an earlier tool result
 * into a chart. Tools split into two kinds, both Zod-validated:
 *
 * - **Data tools** (`summarizeMetrics`, `sumMetricField`, `summarizeReviews`,
 *   `listReviews`, `summarizeLists`, `listItems`) are thin wrappers over the
 *   existing readers. Each result is registered under a `resultRef`
 *   (`#registry` below — server-side truth) and that same ref is handed back
 *   to the model in the JSON.
 * - **Render tools** (`renderSparkline`, `renderBarComparison`,
 *   `renderStatTile`, `renderTable`), one per fixed chart type, take a
 *   `resultRef` plus a narrow selector, look the real data up server-side,
 *   and construct the actual `ChartSpec` — never trusting a number the model
 *   typed itself. An unresolvable `resultRef` or selector degrades to a
 *   typed `{ error }` result rather than throwing, so the tool loop can
 *   recover instead of failing the whole turn.
 *
 * Deliberately out of v1: opinion statements/summaries, and any
 * cross-cutting join between structure types — see the plan this feature was
 * built from for why.
 */
export class ChatOrchestrator implements ChatAnswerer {
  readonly #chatClient: ChatClient;
  readonly #metrics: MetricsReader;
  readonly #metricFields: MetricFieldsReader;
  readonly #reviews: ReviewsReader;
  readonly #lists: ListItemsReader;
  readonly #categories: CategoriesReader;

  constructor(
    chatClient: ChatClient,
    metrics: MetricsReader,
    metricFields: MetricFieldsReader,
    reviews: ReviewsReader,
    lists: ListItemsReader,
    categories: CategoriesReader,
  ) {
    this.#chatClient = chatClient;
    this.#metrics = metrics;
    this.#metricFields = metricFields;
    this.#reviews = reviews;
    this.#lists = lists;
    this.#categories = categories;
  }

  async answer(messages: ChatMessage[]): Promise<ChatResponse> {
    const registry = new Map<string, unknown>();
    let nextRef = 1;
    const registerResult = <T extends object>(result: T): T & { resultRef: string } => {
      const resultRef = `r${nextRef}`;
      nextRef += 1;
      const withRef = { ...result, resultRef };
      registry.set(resultRef, withRef);
      return withRef;
    };

    const approvedMetrics = this.#categories.approvedNames('metric');
    const approvedMedia = this.#categories.approvedNames('review_medium');
    const approvedListTypes = this.#categories.approvedNames('list_type');
    const fieldsByMetric = new Map<string, MetricFieldDefinition[]>(
      approvedMetrics.map((metric) => [metric, this.#metricFields.listForMetric(metric)]),
    );

    const tools: Record<string, ChatTool> = {
      summarizeMetrics: {
        description:
          'Day-bucketed occurrence counts for every currently tracked metric over a recent window — how many times each one happened per day. Use this for "how much/how often" questions about logged activity.',
        argsSchema: z.object({
          windowDays: z
            .number()
            .int()
            .min(1)
            .max(MAX_WINDOW_DAYS)
            .optional()
            .describe(`How many days back to summarise. Defaults to ${DEFAULT_WINDOW_DAYS} if omitted.`),
        }),
        execute: (args) => {
          const { windowDays } = args as { windowDays?: number };
          const summaries = this.#metrics.summarize(approvedMetrics, windowDays ?? DEFAULT_WINDOW_DAYS);
          return registerResult({ windowDays: windowDays ?? DEFAULT_WINDOW_DAYS, summaries });
        },
      },
      sumMetricField: {
        description:
          "Day-bucketed sum of one of a metric's structured numeric fields over a recent window (e.g. total distance for 'exercise'), optionally filtered to records where another field on the same metric equals a value (e.g. sport:rowing). Use this for magnitude questions, not just counts.",
        argsSchema: z.object({
          metric: z.string(),
          fieldKey: z.string(),
          windowDays: z.number().int().min(1).max(MAX_WINDOW_DAYS).optional(),
          filter: z.object({ field: z.string(), value: z.string() }).optional(),
        }),
        execute: (args) => {
          const { metric, fieldKey, windowDays, filter } = args as {
            metric: string;
            fieldKey: string;
            windowDays?: number;
            filter?: { field: string; value: string };
          };
          const field = resolveNumericField(this.#metricFields, metric, fieldKey);
          if (!field) return { error: 'unknown_field' as const };
          const summary = this.#metrics.sumByField(metric, fieldKey, windowDays ?? DEFAULT_WINDOW_DAYS, filter);
          return registerResult({
            metric,
            fieldKey,
            unit: field.unit,
            windowDays: windowDays ?? DEFAULT_WINDOW_DAYS,
            total: summary.total,
            average: summary.average,
            count: summary.count,
            days: summary.days,
          });
        },
      },
      summarizeReviews: {
        description: 'Count and average rating per currently tracked review medium (e.g. film, book).',
        argsSchema: z.object({}),
        execute: () => registerResult({ summaries: this.#reviews.summarize(approvedMedia) }),
      },
      listReviews: {
        description: "Individual reviews (title, rating, opinion, when), most recent first. Use this for 'top/best/recent X' questions.",
        argsSchema: z.object({
          medium: z.string().optional(),
          limit: z.number().int().min(1).max(MAX_LIST_LIMIT).optional(),
        }),
        execute: (args) => {
          const { medium, limit } = args as { medium?: string; limit?: number };
          const records = this.#reviews.list({ ...(medium ? { medium } : {}), limit: limit ?? DEFAULT_LIST_LIMIT });
          return registerResult({
            reviews: records.map((record) => ({
              entryId: record.entryId,
              title: record.title,
              medium: record.medium,
              rating: record.rating,
              progress: record.progress,
              opinion: record.opinion,
              eventTime: record.eventTime,
            })),
          });
        },
      },
      summarizeLists: {
        description: 'Count of items per currently tracked list type (e.g. quote).',
        argsSchema: z.object({}),
        execute: () => registerResult({ summaries: this.#lists.summarize(approvedListTypes) }),
      },
      listItems: {
        description: 'Individual list items (e.g. quotes) verbatim, with their context and when they were recorded.',
        argsSchema: z.object({
          listType: z.string().optional(),
          limit: z.number().int().min(1).max(MAX_LIST_LIMIT).optional(),
          orderBy: z.enum(['recent', 'importance']).optional(),
        }),
        execute: (args) => {
          const { listType, limit, orderBy } = args as {
            listType?: string;
            limit?: number;
            orderBy?: 'recent' | 'importance';
          };
          const records = this.#lists.list({
            ...(listType ? { listType } : {}),
            limit: limit ?? DEFAULT_LIST_LIMIT,
            ...(orderBy ? { orderBy } : {}),
          });
          return registerResult({
            items: records.map((record) => ({
              entryId: record.entryId,
              listType: record.listType,
              text: record.text,
              context: record.context,
              importance: record.importance,
              eventTime: record.eventTime,
            })),
          });
        },
      },
      renderSparkline: {
        description:
          "Render a day-bucketed series (from summarizeMetrics or sumMetricField) as a sparkline chart — a trend over time. Never invent numbers here: resultRef must be a ref an earlier tool call actually returned.",
        argsSchema: z.object({
          resultRef: z.string().describe('The resultRef from the summarizeMetrics or sumMetricField call this series came from.'),
          title: z.string().describe('A short human-readable chart title.'),
          metric: z
            .string()
            .optional()
            .describe('Required when resultRef came from summarizeMetrics: which metric, from that result, to plot.'),
          unit: z.string().optional().describe('A short unit label, if relevant.'),
        }),
        execute: (args) => {
          const { resultRef, title, metric, unit } = args as { resultRef: string; title: string; metric?: string; unit?: string };
          const stored = registry.get(resultRef) as Record<string, unknown> | undefined;
          if (stored === undefined) return { error: 'unknown_result_ref' as const };

          let points: SparklinePoint[] | undefined;
          let totalLabel: string | null = null;

          if (Array.isArray(stored['summaries'])) {
            const summaries = stored['summaries'] as { metric: string; totalCount: number; days: { date: string; count: number }[] }[];
            const match = metric ? summaries.find((summary) => summary.metric === metric) : undefined;
            if (!match) return { error: 'no_such_series' as const };
            points = match.days.map((day) => ({ date: day.date, value: day.count }));
            totalLabel = `${match.totalCount} total`;
          } else if (Array.isArray(stored['days'])) {
            points = (stored['days'] as SparklinePoint[]).map((day) => ({ date: day.date, value: day.value }));
            if (typeof stored['total'] === 'number') totalLabel = `${stored['total']} total`;
          }

          if (!points) return { error: 'no_such_series' as const };

          const spec: SparklineChartSpec = { type: 'sparkline', title, unit: unit ?? null, totalLabel, points };
          return spec;
        },
      },
      renderBarComparison: {
        description:
          'Render a comparison across the entries of a summarize* result (summarizeMetrics, summarizeReviews, or summarizeLists) as a bar chart — one bar per metric/medium/list type.',
        argsSchema: z.object({
          resultRef: z.string(),
          title: z.string(),
          valueField: z.enum(['count', 'averageRating', 'total', 'average', 'totalCount']),
          unit: z.string().optional(),
        }),
        execute: (args) => {
          const { resultRef, title, valueField, unit } = args as {
            resultRef: string;
            title: string;
            valueField: 'count' | 'averageRating' | 'total' | 'average' | 'totalCount';
            unit?: string;
          };
          const stored = registry.get(resultRef) as Record<string, unknown> | undefined;
          if (stored === undefined) return { error: 'unknown_result_ref' as const };
          const summaries = stored['summaries'];
          if (!Array.isArray(summaries)) return { error: 'no_such_series' as const };

          const bars: BarComparisonBar[] = [];
          for (const entry of summaries as Record<string, unknown>[]) {
            const label = entry['metric'] ?? entry['medium'] ?? entry['listType'];
            const value = entry[valueField];
            if (typeof label !== 'string' || typeof value !== 'number') continue;
            bars.push({ label, value });
          }
          if (bars.length === 0) return { error: 'no_such_series' as const };

          const spec: BarComparisonChartSpec = { type: 'bar_comparison', title, unit: unit ?? null, bars };
          return spec;
        },
      },
      renderStatTile: {
        description:
          'Render one number from an earlier tool result as a single stat tile. field must be one of: total, average, count, totalCount, averageRating. entryName selects one row out of a summarize* result (by metric/medium/listType); omit it for a result that already carries the number at its top level (e.g. sumMetricField).',
        argsSchema: z.object({
          resultRef: z.string(),
          label: z.string(),
          field: z.enum(STAT_TILE_FIELDS),
          entryName: z.string().optional(),
          unit: z.string().optional(),
        }),
        execute: (args) => {
          const { resultRef, label, field, entryName, unit } = args as {
            resultRef: string;
            label: string;
            field: (typeof STAT_TILE_FIELDS)[number];
            entryName?: string;
            unit?: string;
          };
          const stored = registry.get(resultRef) as Record<string, unknown> | undefined;
          if (stored === undefined) return { error: 'unknown_result_ref' as const };

          let source: Record<string, unknown> | undefined = stored;
          if (Array.isArray(stored['summaries'])) {
            source = (stored['summaries'] as Record<string, unknown>[]).find(
              (entry) => entry['metric'] === entryName || entry['medium'] === entryName || entry['listType'] === entryName,
            );
          }
          const value = source?.[field];
          if (typeof value !== 'number') return { error: 'no_such_series' as const };

          const spec: StatTileChartSpec = { type: 'stat_tile', label, value, unit: unit ?? null };
          return spec;
        },
      },
      renderTable: {
        description:
          'Render a listReviews or listItems result as a table. columns must be drawn from that result\'s own fields (unrecognised columns are dropped, not an error).',
        argsSchema: z.object({
          resultRef: z.string(),
          title: z.string(),
          columns: z.array(z.string()),
        }),
        execute: (args) => {
          const { resultRef, title, columns } = args as { resultRef: string; title: string; columns: string[] };
          const stored = registry.get(resultRef) as Record<string, unknown> | undefined;
          if (stored === undefined) return { error: 'unknown_result_ref' as const };

          let records: Record<string, unknown>[] | undefined;
          let allowedColumns: readonly string[] = [];
          if (Array.isArray(stored['reviews'])) {
            records = stored['reviews'] as Record<string, unknown>[];
            allowedColumns = REVIEW_TABLE_COLUMNS;
          } else if (Array.isArray(stored['items'])) {
            records = stored['items'] as Record<string, unknown>[];
            allowedColumns = LIST_ITEM_TABLE_COLUMNS;
          }
          if (!records) return { error: 'no_such_series' as const };

          const selectedKeys = columns.filter((key) => allowedColumns.includes(key));
          if (selectedKeys.length === 0) return { error: 'no_such_series' as const };

          const tableColumns: TableColumn[] = selectedKeys.map((key) => ({ key, label: humanizeColumn(key) }));
          const rows: TableRow[] = records.map((record) => ({
            values: Object.fromEntries(
              selectedKeys.map((key) => [key, (record[key] as string | number | null | undefined) ?? null]),
            ),
            entryId: typeof record['entryId'] === 'string' ? (record['entryId'] as string) : null,
          }));

          const spec: TableChartSpec = { type: 'table', title, columns: tableColumns, rows };
          return spec;
        },
      },
    };

    const result = await this.#chatClient.complete({
      system: buildSystemPrompt({ approvedMetrics, fieldsByMetric, approvedMedia, approvedListTypes }),
      messages,
      tools,
    });

    return {
      answer: result.text,
      charts: collectCharts(result.toolInvocations),
      citedEntryIds: collectEntryIds(result.toolInvocations),
    };
  }
}

function buildSystemPrompt(context: {
  approvedMetrics: readonly string[];
  fieldsByMetric: ReadonlyMap<string, MetricFieldDefinition[]>;
  approvedMedia: readonly string[];
  approvedListTypes: readonly string[];
}): string {
  const fieldLines = [...context.fieldsByMetric.entries()]
    .filter(([, fields]) => fields.length > 0)
    .map(
      ([metric, fields]) =>
        `  ${metric}: ${fields
          .map((field) => `${field.fieldKey} (${field.fieldType}${field.unit ? `, ${field.unit}` : ''}) — ${field.description}`)
          .join('; ')}`,
    );

  return [
    "You answer questions about the user's personal journal, using only the tools provided — never from what you already know or assume.",
    'Answer only from tool results. Never state a number, date, or quote that did not come from a tool call. If nothing in the journal answers the question, say so plainly rather than guessing.',
    'Do not frame answers around the act of journaling itself — no "you have written N days in a row" or similar. Factual questions about logged content, like how often something happened, are fine to answer directly.',
    'Produce a chart only by calling a render tool — never describe one in prose instead.',
    'Write the answer as plain prose — no markdown syntax (no **bold**, no `code`, no bullet lists with - or *). It is rendered as plain text verbatim, so any markdown you write shows up as literal punctuation.',
    '',
    context.approvedMetrics.length > 0
      ? `Currently tracked metrics: ${context.approvedMetrics.join(', ')}.`
      : 'No metrics are currently tracked yet.',
    ...(fieldLines.length > 0 ? ['Structured fields per metric:', ...fieldLines] : []),
    context.approvedMedia.length > 0
      ? `Review media tracked: ${context.approvedMedia.join(', ')}.`
      : 'No review media are currently tracked yet.',
    context.approvedListTypes.length > 0
      ? `List types tracked: ${context.approvedListTypes.join(', ')}.`
      : 'No list types are currently tracked yet.',
  ].join('\n');
}

/** A chart spec is any render-tool result shaped like one of the four fixed
 * types — an `{ error }` result from a render tool that couldn't resolve its
 * `resultRef`/selector never matches this, so it is simply not rendered
 * rather than surfaced as a broken chart. */
function isChartSpec(value: unknown): value is ChartSpec {
  if (typeof value !== 'object' || value === null || !('type' in value)) return false;
  const type = (value as { type: unknown }).type;
  return type === 'sparkline' || type === 'bar_comparison' || type === 'stat_tile' || type === 'table';
}

function collectCharts(invocations: readonly ChatToolInvocation[]): ChartSpec[] {
  return invocations.map((invocation) => invocation.result).filter(isChartSpec);
}

/** Every entry behind this turn's tool calls, deduplicated, first-seen order
 * — coarse, per-turn traceability (`requirements.md` §3), not per-sentence
 * citation. Works uniformly across any data tool whose result carries an
 * array of records with an `entryId` field (`listReviews`, `listItems`),
 * without this function needing to know about that tool specifically; a
 * `summarize*`-shaped result simply contributes nothing. */
function collectEntryIds(invocations: readonly ChatToolInvocation[]): string[] {
  const seen = new Set<string>();
  for (const invocation of invocations) {
    const result = invocation.result;
    if (typeof result !== 'object' || result === null) continue;
    for (const value of Object.values(result)) {
      if (!Array.isArray(value)) continue;
      for (const item of value) {
        if (item && typeof item === 'object' && typeof (item as { entryId?: unknown }).entryId === 'string') {
          seen.add((item as { entryId: string }).entryId);
        }
      }
    }
  }
  return [...seen];
}

function humanizeColumn(key: string): string {
  const spaced = key.replace(/([A-Z])/g, ' $1');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
