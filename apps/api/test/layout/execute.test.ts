import { describe, expect, it } from 'vitest';
import type { ResolvedPanel } from '@journal/contract';
import type { CategoriesReader } from '../../src/index/categories-index.js';
import type { MetricFieldsReader } from '../../src/index/metric-fields-index.js';
import type { MetricsReader } from '../../src/index/metrics-index.js';
import type { ReviewsReader } from '../../src/index/reviews-index.js';
import type { ListItemsReader } from '../../src/index/lists-index.js';
import type { OpinionStatementsReader } from '../../src/index/opinion-statements-index.js';
import type { QuestionsReader } from '../../src/index/questions-index.js';
import type { TodosReader } from '../../src/index/todos-index.js';
import { DEFAULT_ANALYSIS_LAYOUT } from '../../src/layout/defaults.js';
import type { LayoutExecutorDeps } from '../../src/layout/execute.js';
import { renderAnalysisLayout } from '../../src/layout/render.js';

/**
 * `LayoutExecutor` is the one place all the shaping that used to live in
 * `apps/web/app/analysis/page.tsx` runs now (`requirements.md` §7.1). This
 * seeds the same `*Reader` interfaces `http/app.ts` depends on with a known
 * dataset and checks each panel's assembled payload — the parity contract
 * the plan asked for before deleting the client code.
 */

const NOW = Date.parse('2026-08-31T00:00:00Z');
const day = (date: string, n: number) => ({ date, value: n });
const dayCount = (date: string, n: number) => ({ date, count: n });

function seededDeps(): LayoutExecutorDeps {
  const categories = {
    approvedNames: (structureType: string): string[] => {
      switch (structureType) {
        case 'metric':
          return ['sleep', 'exercise'];
        case 'review_medium':
          return ['book', 'film'];
        case 'list_type':
          return ['reading'];
        case 'opinion_subject':
          return ['stoicism'];
        case 'metric_field:exercise:sport':
          return ['run', 'row'];
        default:
          return [];
      }
    },
  } as unknown as CategoriesReader;

  const metricFields = {
    listAll: () => [
      { id: 'f1', metric: 'sleep', fieldKey: 'hours', label: 'Hours', fieldType: 'numeric', unit: 'h' },
      { id: 'f2', metric: 'exercise', fieldKey: 'distance_km', label: 'Distance', fieldType: 'numeric', unit: 'km' },
      { id: 'f3', metric: 'exercise', fieldKey: 'duration_min', label: 'Duration', fieldType: 'numeric', unit: 'min' },
      { id: 'f4', metric: 'exercise', fieldKey: 'sport', label: 'Sport', fieldType: 'enum', unit: null },
    ],
  } as unknown as MetricFieldsReader;

  const metrics = {
    summarize: (names: readonly string[]) =>
      names.map((metric) => ({
        metric,
        totalCount: 3,
        days: [dayCount('2026-08-29', 1), dayCount('2026-08-30', metric === 'sleep' ? 1 : 2)],
      })),
    sumByField: (metric: string, fieldKey: string, _w: number, filter?: { field: string; value: string }) => {
      if (filter) {
        // Breakdown: distance/duration split by sport. `row` contributes 0 to
        // duration so the executor should drop that bar.
        const total = filter.value === 'run' ? 10 : fieldKey === 'duration_min' ? 0 : 5;
        return { total, average: total, count: 1, days: [day('2026-08-30', total)] };
      }
      const total = fieldKey === 'hours' ? 21 : fieldKey === 'distance_km' ? 30 : 120;
      return { total, average: total / 3, count: 3, days: [day('2026-08-29', total / 3), day('2026-08-30', (2 * total) / 3)] };
    },
    list: ({ metric }: { metric?: string }) => {
      if (metric !== 'exercise') return [];
      return [
        { id: 'm1', entryId: 'e1', metric: 'exercise', eventTime: '2026-08-29T08:00:00Z', fields: { distance_km: 5, duration_min: 40 } },
        { id: 'm2', entryId: 'e2', metric: 'exercise', eventTime: '2026-08-30T08:00:00Z', fields: { distance_km: 8, duration_min: 55 } },
      ];
    },
  } as unknown as MetricsReader;

  const reviews = {
    summarize: () => [
      { medium: 'book', count: 2, averageRating: 4 },
      { medium: 'film', count: 1, averageRating: 3 },
    ],
    histogram: () => ({
      overall: [
        { rating: 3, count: 1 },
        { rating: 4, count: 2 },
      ],
      byMedium: [{ medium: 'book', buckets: [{ rating: 4, count: 2 }] }],
    }),
    list: () => [
      { id: 'r1', entryId: 'e1', title: 'Meditations', medium: 'book', rating: 5, opinion: 'Steadying. Read it again.', eventTime: '2026-08-20T00:00:00Z' },
      { id: 'r2', entryId: 'e2', title: 'Dune', medium: 'book', rating: 3, opinion: 'Slow middle.', eventTime: '2026-08-22T00:00:00Z' },
      { id: 'r3', entryId: 'e3', title: 'Arrival', medium: 'film', rating: null, opinion: 'Unrated so far.', eventTime: '2026-08-25T00:00:00Z' },
    ],
  } as unknown as ReviewsReader;

  const lists = { summarize: () => [{ listType: 'reading', count: 5 }] } as unknown as ListItemsReader;

  const opinionStatements = { summarize: () => [{ subject: 'stoicism', count: 3 }] } as unknown as OpinionStatementsReader;

  const questions = {
    summarize: () => ({ openCount: 2, resolvedCount: 1 }),
    list: ({ status }: { status?: string }) => {
      const open = [
        { id: 'q1', entryId: 'e1', question: 'Ship the layout engine?', eventTime: '2026-08-10T00:00:00Z' },
        { id: 'q2', entryId: 'e2', question: 'Rename the presence panel?', eventTime: '2026-08-25T00:00:00Z' },
      ];
      const resolved = [{ id: 'q3', entryId: 'e3', question: 'Old one', eventTime: '2026-07-01T00:00:00Z' }];
      return status === 'open' ? open : [...open, ...resolved];
    },
  } as unknown as QuestionsReader;

  const todos = {
    summarize: () => ({ openCount: 1, doneCount: 4 }),
    list: ({ status }: { status?: string }) => {
      const open = [{ id: 't1', entryId: 'e1', text: 'Write the executor test', eventTime: '2026-08-05T00:00:00Z' }];
      const done = [{ id: 't2', entryId: 'e2', text: 'done thing', eventTime: '2026-08-01T00:00:00Z' }];
      return status === 'open' ? open : [...open, ...done];
    },
  } as unknown as TodosReader;

  return { metrics, metricFields, reviews, lists, categories, opinionStatements, questions, todos };
}

const panelsByView = (sections: { panels: ResolvedPanel[] }[]) =>
  new Map(sections.flatMap((s) => s.panels).map((p) => [p.view, p] as const));

describe('renderAnalysisLayout — the built-in default over a seeded dataset', () => {
  const { layout } = renderAnalysisLayout(seededDeps(), {}, NOW);
  const byView = panelsByView(layout.sections);

  it('renders the pre-M20 three sections, in order', () => {
    expect(layout.sections.map((s) => s.title)).toEqual(['Rhythms', 'Tallies', 'Threads']);
  });

  it('echoes the canonical syntax and the 30-day default window', () => {
    expect(layout.syntax).toBe(DEFAULT_ANALYSIS_LAYOUT);
    expect(layout.window).toEqual({ days: 30 });
    expect(layout.layoutId).toBeNull();
  });

  it('presence: one series per approved metric', () => {
    const panel = byView.get('presence');
    expect(panel).toMatchObject({ view: 'presence', seeAllHref: '/metrics' });
    if (panel?.view === 'presence') expect(panel.metrics.map((m) => m.name)).toEqual(['sleep', 'exercise']);
  });

  it('register: one row per numeric field, labelled "metric — Field"', () => {
    const panel = byView.get('register');
    if (panel?.view !== 'register') throw new Error('missing');
    expect(panel.rows.map((r) => r.field)).toEqual(['sleep — Hours', 'exercise — Distance', 'exercise — Duration']);
    expect(panel.rows[0]).toMatchObject({ unit: 'h', total: 21, count: 3 });
  });

  it('horizon: same fields, carrying unit and day values', () => {
    const panel = byView.get('horizon');
    if (panel?.view !== 'horizon') throw new Error('missing');
    expect(panel.series.map((s) => s.label)).toEqual(['sleep — Hours', 'exercise — Distance', 'exercise — Duration']);
    expect(panel.series[1]).toMatchObject({ unit: 'km' });
  });

  it('breakdown: numeric-by-enum pairs on the same metric, zero bars dropped', () => {
    const panel = byView.get('breakdown');
    if (panel?.view !== 'breakdown') throw new Error('missing');
    // distance_km by sport → run 10, row 5 ; duration_min by sport → run 10 (row is 0, dropped)
    const distance = panel.breakdowns.find((b) => b.numericLabel === 'Distance');
    expect(distance?.bars).toEqual([
      { label: 'run', value: 10 },
      { label: 'row', value: 5 },
    ]);
    const duration = panel.breakdowns.find((b) => b.numericLabel === 'Duration');
    expect(duration?.bars).toEqual([{ label: 'run', value: 10 }]);
  });

  it('correlation: only a metric with exactly two numeric fields, ≥2 real points', () => {
    const panel = byView.get('correlation');
    if (panel?.view !== 'correlation') throw new Error('missing');
    expect(panel.correlations).toHaveLength(1);
    expect(panel.correlations[0]).toMatchObject({ metric: 'exercise', xLabel: 'Distance', yLabel: 'Duration' });
    expect(panel.correlations[0]?.points).toHaveLength(2);
    expect(panel.correlations[0]?.points[0]?.label).toContain('29 August 2026');
  });

  it('reviews: the medium tally plus a capped diary of recent rows', () => {
    const panel = byView.get('reviews');
    if (panel?.view !== 'reviews') throw new Error('missing');
    expect(panel.tally.map((t) => t.medium)).toEqual(['book', 'film']);
    expect(panel.rows.map((r) => r.title)).toEqual(['Meditations', 'Dune', 'Arrival']);
    expect(panel.rows[0]).toMatchObject({ eventTime: '20 August 2026', note: 'Steadying.' });
  });

  it('rating-distribution: histogram plus per-medium averages', () => {
    const panel = byView.get('rating-distribution');
    if (panel?.view !== 'rating-distribution') throw new Error('missing');
    expect(panel.averages).toEqual([
      { label: 'book', value: 4 },
      { label: 'film', value: 3 },
    ]);
  });

  it('rating-spread: one lane per medium with its raw ratings', () => {
    const panel = byView.get('rating-spread');
    if (panel?.view !== 'rating-spread') throw new Error('missing');
    expect(panel.lanes).toEqual([
      { medium: 'book', ratings: [5, 3] },
      { medium: 'film', ratings: [] },
    ]);
  });

  it('questions: summary counts plus the recent open feed (limit 5)', () => {
    const panel = byView.get('questions');
    if (panel?.view !== 'questions') throw new Error('missing');
    expect(panel).toMatchObject({ openCount: 2, closedCount: 1 });
    expect(panel.items.map((i) => i.id)).toEqual(['q1', 'q2']);
  });

  it('todos: summary counts plus the recent open feed', () => {
    const panel = byView.get('todos');
    if (panel?.view !== 'todos') throw new Error('missing');
    expect(panel).toMatchObject({ openCount: 1, closedCount: 4 });
    expect(panel.items.map((i) => i.id)).toEqual(['t1']);
  });

  it('lists and concepts: the approved-category tallies', () => {
    expect(byView.get('lists')).toMatchObject({ rows: [{ listType: 'reading', count: 5 }] });
    expect(byView.get('concepts')).toMatchObject({ rows: [{ subject: 'stoicism', count: 3 }] });
  });

  it('aging: open questions and todos merged, oldest first, truncated labels', () => {
    const panel = byView.get('aging');
    if (panel?.view !== 'aging') throw new Error('missing');
    // t1 (Aug 5) oldest, then q1 (Aug 10), then q2 (Aug 25).
    expect(panel.rows.map((r) => r.value)).toEqual([26, 21, 6]);
    expect(panel.rows[0]).toMatchObject({ label: 'Write the executor test', entryId: 'e1' });
  });
});

describe('renderAnalysisLayout — request options', () => {
  it('a windowDays override replaces the layout window', () => {
    const { layout } = renderAnalysisLayout(seededDeps(), { windowDays: 90 }, NOW);
    expect(layout.window).toEqual({ days: 90 });
  });

  it('an inline syntax reorders and drops sections; syntax echoes back canonicalised', () => {
    const { layout, diagnostics } = renderAnalysisLayout(
      seededDeps(),
      { syntax: 'layout "Mine"\n\nsection "Only questions"\n  panel questions\n    limit: 1\n' },
      NOW,
    );
    expect(diagnostics).toEqual([]);
    expect(layout.name).toBe('Mine');
    expect(layout.sections.map((s) => s.title)).toEqual(['Only questions']);
    const panel = layout.sections[0]?.panels[0];
    if (panel?.view !== 'questions') throw new Error('missing');
    expect(panel.items).toHaveLength(1);
    expect(layout.syntax).toBe('layout "Mine"\n\nsection "Only questions"\n  panel questions\n    limit: 1\n');
  });

  it('a panel naming an unknown metric degrades to an error panel, never throws', () => {
    const { layout } = renderAnalysisLayout(
      seededDeps(),
      { syntax: 'layout "A"\n\nsection "S"\n  panel correlation\n    metric: cycling\n' },
      NOW,
    );
    expect(layout.sections[0]?.panels[0]).toMatchObject({
      view: 'error',
      message: expect.stringContaining("No metric 'cycling'"),
    });
  });

  it('an empty dataset omits the panels the pre-M20 page rendered as null', () => {
    const empty = {
      approvedNames: () => [],
    } as unknown as CategoriesReader;
    const deps: LayoutExecutorDeps = {
      ...seededDeps(),
      categories: empty,
      metricFields: { listAll: () => [] } as unknown as MetricFieldsReader,
      reviews: { summarize: () => [], histogram: () => ({ overall: [], byMedium: [] }), list: () => [] } as unknown as ReviewsReader,
      lists: { summarize: () => [] } as unknown as ListItemsReader,
      opinionStatements: { summarize: () => [] } as unknown as OpinionStatementsReader,
      questions: { summarize: () => ({ openCount: 0, resolvedCount: 0 }), list: () => [] } as unknown as QuestionsReader,
      todos: { summarize: () => ({ openCount: 0, doneCount: 0 }), list: () => [] } as unknown as TodosReader,
    };
    const { layout } = renderAnalysisLayout(deps, {}, NOW);
    // Rhythms is entirely empty → omitted. Tallies keeps only `reviews`
    // (always rendered). Threads keeps questions/todos/lists/concepts.
    expect(layout.sections.map((s) => s.title)).toEqual(['Tallies', 'Threads']);
    expect(layout.sections[0]?.panels.map((p) => p.view)).toEqual(['reviews']);
    expect(layout.sections[1]?.panels.map((p) => p.view)).toEqual(['questions', 'todos', 'lists', 'concepts']);
  });
});
