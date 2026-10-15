import type {
  LayoutAgingRow,
  LayoutCorrelation,
  LayoutFieldBreakdown,
  LayoutMetricSeries,
  LayoutRegisterRow,
  LayoutReviewRow,
  LayoutScatterPoint,
  ResolvedLayout,
  ResolvedLayoutSection,
  ResolvedPanel,
} from '@journal/contract';
import type { CategoriesReader } from '../index/categories-index.js';
import type { MetricFieldDefinition, MetricFieldsReader } from '../index/metric-fields-index.js';
import type { MetricsReader } from '../index/metrics-index.js';
import type { ReviewsReader } from '../index/reviews-index.js';
import type { ListItemsReader } from '../index/lists-index.js';
import type { OpinionStatementsReader } from '../index/opinion-statements-index.js';
import type { QuestionsReader } from '../index/questions-index.js';
import type { TodosReader } from '../index/todos-index.js';
import { formatEventDate } from './format-date.js';
import type { PlannedPanel, ResolvedPlan } from './resolve.js';
import type { OptionValue } from './spec.js';

/**
 * Runs a resolved layout plan against the same `*Reader` interfaces
 * `http/app.ts` already depends on, and returns every panel with its data
 * assembled — the one place all the shaping that used to live in
 * `apps/web/app/analysis/page.tsx` now runs (`requirements.md` §7.1). Each
 * branch is a faithful port of that page's `panels` object; a panel that the
 * page rendered as `null` when empty is omitted here, and a section left
 * with no panels is omitted too.
 *
 * Pure reads, in process — no model call, no write. `now` is injected so the
 * "days open" arithmetic and the summary windows are testable.
 */

/** The backend's own `MAX_LIMIT` — the pre-M20 page read "at most the 200
 * most recent" raw records for its scatter and strip plots. */
const RAW_RECORD_LIMIT = 200;
const DEFAULT_FEED_LIMIT = 5;
const DEFAULT_REVIEW_ROWS = DEFAULT_FEED_LIMIT * 4;
const DEFAULT_AGING_LIMIT = 12;
const MAX_PRESENCE_METRICS = 5;
const AGING_LABEL_MAX = 40;

export interface LayoutExecutorDeps {
  metrics: MetricsReader;
  metricFields: MetricFieldsReader;
  reviews: ReviewsReader;
  lists: ListItemsReader;
  categories: CategoriesReader;
  opinionStatements: OpinionStatementsReader;
  questions: QuestionsReader;
  todos: TodosReader;
}

export interface LayoutRendering {
  render(
    plan: ResolvedPlan,
    windowDays: number,
    layoutId: string | null,
    syntax: string,
    now?: number,
  ): ResolvedLayout;
}

export class LayoutExecutor implements LayoutRendering {
  readonly #deps: LayoutExecutorDeps;

  constructor(deps: LayoutExecutorDeps) {
    this.#deps = deps;
  }

  render(
    plan: ResolvedPlan,
    windowDays: number,
    layoutId: string | null,
    syntax: string,
    now: number = Date.now(),
  ): ResolvedLayout {
    const source = new AnalysisSource(this.#deps, windowDays, now);

    const sections: ResolvedLayoutSection[] = [];
    for (const planned of plan.sections) {
      const panels: ResolvedPanel[] = [];
      for (const panel of planned.panels) {
        const resolved = renderPanel(panel, source);
        if (resolved) panels.push(resolved);
      }
      if (panels.length > 0) sections.push({ title: planned.title, panels });
    }

    return { layoutId, name: plan.name, syntax, window: { days: windowDays }, sections };
  }
}

function renderPanel(panel: PlannedPanel, source: AnalysisSource): ResolvedPanel | null {
  if (!panel.ok) {
    return { view: 'error', title: panel.title, seeAllHref: null, message: panel.message };
  }
  const { view, title, options } = panel;
  const seeAllHref = view.seeAllHref;

  switch (view.kind) {
    case 'presence': {
      const metrics = source.metricSeries(listOption(options, 'metrics'), MAX_PRESENCE_METRICS);
      if (source.metricSummaries.length === 0) return null;
      return { view: 'presence', title, seeAllHref, metrics };
    }
    case 'matrix': {
      if (source.metricSummaries.length === 0) return null;
      return { view: 'matrix', title, seeAllHref, metrics: source.metricSeries(listOption(options, 'metrics'), Infinity) };
    }
    case 'register': {
      const rows = source.registerRows(listOption(options, 'fields'));
      if (rows.length === 0) return null;
      return { view: 'register', title, seeAllHref, rows };
    }
    case 'horizon': {
      const rows = source.registerRows(listOption(options, 'fields'));
      if (rows.length === 0) return null;
      return {
        view: 'horizon',
        title,
        seeAllHref,
        series: rows.map((row) => ({ label: row.field, unit: row.unit, days: row.days })),
      };
    }
    case 'breakdown': {
      const breakdowns = source.breakdowns(refOption(options, 'metric'));
      if (breakdowns.length === 0) return null;
      return { view: 'breakdown', title, seeAllHref, breakdowns };
    }
    case 'correlation': {
      const correlations = source.correlations(refOption(options, 'metric'));
      if (correlations.length === 0) return null;
      return { view: 'correlation', title, seeAllHref, correlations };
    }
    case 'reviews': {
      const tally = source.reviewsSummary;
      const limit = intOption(options, 'limit') ?? DEFAULT_REVIEW_ROWS;
      const rows = source.reviewRows(refOption(options, 'medium'), limit);
      return { view: 'reviews', title, seeAllHref, tally, rows };
    }
    case 'rating-distribution': {
      const { overall, byMedium } = source.histogram;
      const averages = source.reviewsSummary
        .filter((summary) => summary.averageRating !== null)
        .map((summary) => ({ label: summary.medium, value: summary.averageRating as number }));
      if (overall.every((bucket) => bucket.count === 0) && averages.length === 0) return null;
      return { view: 'rating-distribution', title, seeAllHref, overall, byMedium, averages };
    }
    case 'rating-spread': {
      const lanes = source.stripLanes();
      if (lanes.every((lane) => lane.ratings.length === 0)) return null;
      return { view: 'rating-spread', title, seeAllHref, lanes };
    }
    case 'questions': {
      const summary = source.questionsSummary;
      const items = source
        .threadFeed('question', enumOption(options, 'show') === 'all')
        .slice(0, intOption(options, 'limit') ?? DEFAULT_FEED_LIMIT);
      return {
        view: 'questions',
        title,
        seeAllHref,
        openCount: summary.openCount,
        closedCount: summary.resolvedCount,
        items,
      };
    }
    case 'todos': {
      const summary = source.todosSummary;
      const items = source
        .threadFeed('todo', enumOption(options, 'show') === 'all')
        .slice(0, intOption(options, 'limit') ?? DEFAULT_FEED_LIMIT);
      return {
        view: 'todos',
        title,
        seeAllHref,
        openCount: summary.openCount,
        closedCount: summary.doneCount,
        items,
      };
    }
    case 'lists': {
      const type = refOption(options, 'type');
      const rows = source.listsSummary.filter((row) => type === undefined || row.listType === type);
      return { view: 'lists', title, seeAllHref, rows };
    }
    case 'concepts': {
      const subject = refOption(options, 'subject');
      const rows = source.conceptsSummary.filter((row) => subject === undefined || row.subject === subject);
      return { view: 'concepts', title, seeAllHref, rows };
    }
    case 'aging': {
      const rows = source.aging(intOption(options, 'limit') ?? DEFAULT_AGING_LIMIT);
      if (rows.length === 0) return null;
      return { view: 'aging', title, seeAllHref, rows };
    }
    default:
      return { view: 'error', title, seeAllHref: null, message: `Unknown panel '${view.kind}'.` };
  }
}

// ── option readers ─────────────────────────────────────────────────────────

function refOption(options: Record<string, OptionValue>, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' ? value : undefined;
}

function intOption(options: Record<string, OptionValue>, key: string): number | undefined {
  const value = options[key];
  return typeof value === 'number' ? value : undefined;
}

function enumOption(options: Record<string, OptionValue>, key: string): string | undefined {
  return refOption(options, key);
}

function listOption(options: Record<string, OptionValue>, key: string): readonly string[] | undefined {
  const value = options[key];
  return Array.isArray(value) ? value : undefined;
}

// ── the shared data source ─────────────────────────────────────────────────

interface FieldSeries {
  key: string;
  metric: string;
  label: string;
  unit: string | null;
  count: number;
  total: number;
  average: number;
  days: { date: string; value: number }[];
}

/**
 * Fetches each aggregate at most once and hands slices of it to whichever
 * panels asked — the executor's version of the pre-M20 page's single
 * `Promise.all` plus the `AnalysisData` object it built from the results.
 */
class AnalysisSource {
  readonly #deps: LayoutExecutorDeps;
  readonly #windowDays: number;
  readonly #now: number;

  constructor(deps: LayoutExecutorDeps, windowDays: number, now: number) {
    this.#deps = deps;
    this.#windowDays = windowDays;
    this.#now = now;
  }

  #memo = new Map<string, unknown>();
  #once<T>(key: string, make: () => T): T {
    if (!this.#memo.has(key)) this.#memo.set(key, make());
    return this.#memo.get(key) as T;
  }

  get approvedMetrics(): string[] {
    return this.#once('approvedMetrics', () => this.#deps.categories.approvedNames('metric'));
  }
  get approvedMedia(): string[] {
    return this.#once('approvedMedia', () => this.#deps.categories.approvedNames('review_medium'));
  }
  get approvedListTypes(): string[] {
    return this.#once('approvedListTypes', () => this.#deps.categories.approvedNames('list_type'));
  }
  get approvedSubjects(): string[] {
    return this.#once('approvedSubjects', () => this.#deps.categories.approvedNames('opinion_subject'));
  }

  get metricSummaries() {
    return this.#once('metricSummaries', () =>
      this.#deps.metrics.summarize(this.approvedMetrics, this.#windowDays, this.#now),
    );
  }

  get allFields(): MetricFieldDefinition[] {
    return this.#once('allFields', () => this.#deps.metricFields.listAll());
  }
  get numericFields(): MetricFieldDefinition[] {
    return this.#once('numericFields', () =>
      this.allFields.filter((field) => field.fieldType === 'numeric' || field.fieldType === 'score'),
    );
  }
  get enumFields(): MetricFieldDefinition[] {
    return this.#once('enumFields', () => this.allFields.filter((field) => field.fieldType === 'enum'));
  }

  get fieldSeries(): FieldSeries[] {
    return this.#once('fieldSeries', () =>
      this.numericFields.map((field): FieldSeries => {
        const summary = this.#deps.metrics.sumByField(field.metric, field.fieldKey, this.#windowDays, undefined, this.#now);
        return {
          key: `${field.metric}.${field.fieldKey}`,
          metric: field.metric,
          label: field.label,
          unit: field.unit,
          count: summary.count,
          total: summary.total,
          average: summary.average,
          days: summary.days,
        };
      }),
    );
  }

  get reviewsSummary() {
    return this.#once('reviewsSummary', () => this.#deps.reviews.summarize(this.approvedMedia));
  }
  get histogram() {
    return this.#once('histogram', () => this.#deps.reviews.histogram(this.approvedMedia));
  }
  get reviewsRaw() {
    return this.#once('reviewsRaw', () => this.#deps.reviews.list({ limit: RAW_RECORD_LIMIT }));
  }

  get listsSummary() {
    return this.#once('listsSummary', () => this.#deps.lists.summarize(this.approvedListTypes));
  }
  get conceptsSummary() {
    return this.#once('conceptsSummary', () => this.#deps.opinionStatements.summarize(this.approvedSubjects));
  }
  get questionsSummary() {
    return this.#once('questionsSummary', () => this.#deps.questions.summarize());
  }
  get todosSummary() {
    return this.#once('todosSummary', () => this.#deps.todos.summarize());
  }
  get openQuestions() {
    return this.#once('openQuestions', () => this.#deps.questions.list({ status: 'open', limit: RAW_RECORD_LIMIT }));
  }
  get openTodos() {
    return this.#once('openTodos', () => this.#deps.todos.list({ status: 'open', limit: RAW_RECORD_LIMIT }));
  }

  metricSeries(names: readonly string[] | undefined, cap: number): LayoutMetricSeries[] {
    const chosen = names && names.length > 0 ? names : this.metricSummaries.map((summary) => summary.metric);
    const limited = Number.isFinite(cap) ? chosen.slice(0, cap) : chosen;
    return limited
      .map((name) => this.metricSummaries.find((summary) => summary.metric === name))
      .filter((summary): summary is (typeof this.metricSummaries)[number] => summary !== undefined)
      .map((summary) => ({ name: summary.metric, days: summary.days }));
  }

  registerRows(fieldKeys: readonly string[] | undefined): LayoutRegisterRow[] {
    const wanted = fieldKeys && fieldKeys.length > 0 ? new Set(fieldKeys) : null;
    return this.fieldSeries
      .filter((series) => wanted === null || wanted.has(series.key))
      .map((series) => ({
        field: `${series.metric} — ${series.label}`,
        unit: series.unit,
        count: series.count,
        total: series.total,
        average: series.average,
        days: series.days,
      }));
  }

  breakdowns(metric: string | undefined): LayoutFieldBreakdown[] {
    const numericFields = this.numericFields.filter((field) => metric === undefined || field.metric === metric);
    const enumValues = this.enumFields.map((field) => ({
      field,
      values: this.#deps.categories.approvedNames(`metric_field:${field.metric}:${field.fieldKey}`),
    }));

    const byPair = new Map<string, LayoutFieldBreakdown>();
    for (const numericField of numericFields) {
      for (const { field: enumField, values } of enumValues) {
        if (enumField.metric !== numericField.metric || values.length === 0) continue;
        const key = `${numericField.id}:${enumField.id}`;
        let breakdown = byPair.get(key);
        if (!breakdown) {
          breakdown = {
            metric: numericField.metric,
            numericLabel: numericField.label,
            unit: numericField.unit,
            enumLabel: enumField.label,
            bars: [],
          };
          byPair.set(key, breakdown);
        }
        for (const value of values) {
          const summary = this.#deps.metrics.sumByField(
            numericField.metric,
            numericField.fieldKey,
            this.#windowDays,
            { field: enumField.fieldKey, value },
            this.#now,
          );
          breakdown.bars.push({ label: value, value: summary.total });
        }
      }
    }

    return [...byPair.values()]
      .map((breakdown) => ({ ...breakdown, bars: breakdown.bars.filter((bar) => bar.value > 0) }))
      .filter((breakdown) => breakdown.bars.length > 0);
  }

  correlations(metric: string | undefined): LayoutCorrelation[] {
    const byMetric = new Map<string, MetricFieldDefinition[]>();
    for (const field of this.numericFields) {
      const list = byMetric.get(field.metric) ?? [];
      list.push(field);
      byMetric.set(field.metric, list);
    }

    const results: LayoutCorrelation[] = [];
    for (const [metricName, fields] of byMetric) {
      if (fields.length !== 2) continue;
      if (metric !== undefined && metricName !== metric) continue;
      const [fieldX, fieldY] = fields as [MetricFieldDefinition, MetricFieldDefinition];
      const points: LayoutScatterPoint[] = [];
      for (const record of this.#deps.metrics.list({ metric: metricName, limit: RAW_RECORD_LIMIT })) {
        const x = record.fields[fieldX.fieldKey];
        const y = record.fields[fieldY.fieldKey];
        if (typeof x !== 'number' || typeof y !== 'number') continue;
        const xUnit = fieldX.unit ? ` ${fieldX.unit}` : '';
        const yUnit = fieldY.unit ? ` ${fieldY.unit}` : '';
        points.push({
          x,
          y,
          entryId: record.entryId,
          label: `${formatEventDate(record.eventTime)} — ${fieldX.label} ${x}${xUnit}, ${fieldY.label} ${y}${yUnit}`,
        });
      }
      if (points.length >= 2) {
        results.push({ metric: metricName, xLabel: fieldX.label, yLabel: fieldY.label, points });
      }
    }
    return results;
  }

  reviewRows(medium: string | undefined, limit: number): LayoutReviewRow[] {
    return this.reviewsRaw
      .filter((review) => medium === undefined || review.medium === medium)
      .slice(0, limit)
      .map((review) => ({
        title: review.title,
        medium: review.medium,
        eventTime: formatEventDate(review.eventTime),
        rating: review.rating,
        note: review.opinion.split(/(?<=[.!?])\s/)[0] ?? review.opinion,
        entryId: review.entryId,
      }));
  }

  stripLanes(): { medium: string; ratings: number[] }[] {
    return this.reviewsSummary.map((summary) => ({
      medium: summary.medium,
      ratings: this.reviewsRaw
        .filter((review) => review.medium === summary.medium && review.rating !== null)
        .map((review) => review.rating as number),
    }));
  }

  threadFeed(kind: 'question' | 'todo', all: boolean): { id: string; when: string; text: string; entryId: string | null }[] {
    if (kind === 'question') {
      const records = all ? this.#deps.questions.list({ limit: RAW_RECORD_LIMIT }) : this.openQuestions;
      return records.map((record) => ({
        id: record.id,
        when: record.eventTime,
        text: record.question,
        entryId: record.entryId,
      }));
    }
    const records = all ? this.#deps.todos.list({ limit: RAW_RECORD_LIMIT }) : this.openTodos;
    return records.map((record) => ({
      id: record.id,
      when: record.eventTime,
      text: record.text,
      entryId: record.entryId,
    }));
  }

  aging(limit: number): LayoutAgingRow[] {
    const daysOpen = (eventTime: string): number =>
      Math.max(0, Math.floor((this.#now - Date.parse(eventTime)) / 86_400_000));
    const items = [
      ...this.openQuestions.map((question) => ({
        label: question.question,
        entryId: question.entryId as string | null,
        value: daysOpen(question.eventTime),
      })),
      ...this.openTodos.map((todo) => ({
        label: todo.text,
        entryId: todo.entryId,
        value: daysOpen(todo.eventTime),
      })),
    ];
    return items
      .sort((a, b) => b.value - a.value)
      .slice(0, limit)
      .map((item) => ({
        label: item.label.length > AGING_LABEL_MAX ? `${item.label.slice(0, AGING_LABEL_MAX)}…` : item.label,
        value: item.value,
        entryId: item.entryId,
      }));
  }
}
