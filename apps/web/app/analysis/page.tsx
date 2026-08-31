'use client';

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import type {
  ListTypeSummary,
  MetricFieldDefinition,
  MetricSummary,
  OpenQuestion,
  OpinionSubjectSummary,
  QuestionsSummaryResponse,
  ReviewMediumHistogram,
  ReviewMediumSummary,
  ReviewRatingBucket,
  Todo,
  TodosSummaryResponse,
} from '@journal/contract';
import {
  analysisLists,
  analysisMetricField,
  analysisMetrics,
  analysisOpinions,
  analysisQuestions,
  analysisReviews,
  analysisReviewsHistogram,
  analysisTodos,
  ApiRequestError,
  listMetricFields,
  listMetricFieldValues,
  listMetrics,
  listQuestions,
  listReviews,
  listTodos,
} from '@/lib/api';
import { formatDate, formatRating } from '@/lib/format';
import {
  CombinedCalendar,
  DotPlot,
  Horizon,
  Panel,
  Register,
  ReviewsRegister,
  ScatterPlot,
  StatusBar,
  StripPlot,
  RatingHistogram,
  YearMatrix,
  type RegisterRow,
  type ScatterPoint,
} from '@/components/analysis-charts';
import styles from './page.module.css';

const RECENT_FEED_LIMIT = 5;
/** The backend's own per-request cap (`apps/api/src/http/app.ts`'s
 * `MAX_LIMIT`) — asking for more just to plot every raw record still hits
 * this ceiling, so the charts below read "at most the 200 most recent". */
const RAW_RECORD_LIMIT = 200;

const WINDOW_PRESETS: { label: string; days: number }[] = [
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: '12mo', days: 366 },
  { label: 'All', days: 3650 },
];
const DEFAULT_WINDOW_DAYS = 30;
const MAX_CALENDAR_METRICS = 5;

// ─────────────────────────────────────────────────────────────────────────
// Persisted layout preferences (`design.md` §5.3's "the option to change
// the layouts and orderings" — UI arrangement, not content, so this is
// exactly the kind of client-only preference the theme/chrome toggles
// already keep in `localStorage`; unlike those, this is read once into
// component state rather than through `useSyncExternalStore`, since
// nothing outside this one page ever needs to read or react to it.
// ─────────────────────────────────────────────────────────────────────────

const PREFS_KEY = 'journal:analysis-prefs';
/** Writing `localStorage` doesn't itself fire a `storage` event in the same
 * tab that wrote it (only other tabs get that) — so `setPrefs` dispatches
 * this too, the same `LOCAL_CHANGE_EVENT` shape `chrome.tsx`/`theme.tsx`
 * already use for exactly this reason. */
const PREFS_CHANGE_EVENT = 'journal:analysis-prefs-change';

type RegisterName = 'rhythms' | 'tallies' | 'threads';

const DEFAULT_ORDER: Record<RegisterName, string[]> = {
  rhythms: ['calendar', 'register', 'horizon', 'matrix'],
  tallies: ['breakdowns', 'reviews', 'distribution', 'spread'],
  threads: ['questions', 'todos', 'lists', 'concepts', 'aging'],
};

interface Prefs {
  windowDays: number;
  order: Record<RegisterName, string[]>;
  hidden: string[];
  calendarMetrics: string[];
}

const DEFAULT_PREFS: Prefs = { windowDays: DEFAULT_WINDOW_DAYS, order: DEFAULT_ORDER, hidden: [], calendarMetrics: [] };

function defaultPrefs(): Prefs {
  return DEFAULT_PREFS;
}

/** `useSyncExternalStore` compares snapshots with `Object.is`, so `readPrefs`
 * must return the *same* object when the underlying `localStorage` value
 * hasn't changed — parsing fresh JSON into a new object on every call (as
 * this used to do) makes every snapshot "different" and loops forever. */
let cachedRaw: string | null = null;
let cachedPrefs: Prefs = DEFAULT_PREFS;

function readPrefs(): Prefs {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(PREFS_KEY);
  } catch {
    raw = null; // Private browsing, etc.
  }
  if (raw === cachedRaw) return cachedPrefs;
  cachedRaw = raw;
  try {
    cachedPrefs = raw ? { ...DEFAULT_PREFS, ...JSON.parse(raw) } : DEFAULT_PREFS;
  } catch {
    cachedPrefs = DEFAULT_PREFS; // Corrupted value.
  }
  return cachedPrefs;
}

function subscribePrefs(callback: () => void): () => void {
  window.addEventListener('storage', callback);
  window.addEventListener(PREFS_CHANGE_EVENT, callback);
  return () => {
    window.removeEventListener('storage', callback);
    window.removeEventListener(PREFS_CHANGE_EVENT, callback);
  };
}

/**
 * The same `useSyncExternalStore` shape `chrome.tsx`/`theme.tsx` already
 * use for a `localStorage`-backed preference — the correct tool for state
 * that lives outside React, with SSR-safe behaviour built in (a plain
 * `useState` + `useEffect` read would call `setState` synchronously inside
 * an effect, which is exactly the cascading-render anti-pattern those
 * hooks exist to avoid). No `Context`/`Provider` here unlike those two:
 * this preference is read in exactly one place, so nothing else in the
 * tree needs to observe it.
 */
function usePrefs(): [Prefs, (updater: Prefs | ((prev: Prefs) => Prefs)) => void] {
  const prefs = useSyncExternalStore(subscribePrefs, readPrefs, defaultPrefs);

  const setPrefs = useCallback((updater: Prefs | ((prev: Prefs) => Prefs)) => {
    const current = readPrefs();
    const next = typeof updater === 'function' ? (updater as (p: Prefs) => Prefs)(current) : updater;
    try {
      window.localStorage.setItem(PREFS_KEY, JSON.stringify(next));
    } catch {
      // Same tolerance as the read above.
    }
    window.dispatchEvent(new Event(PREFS_CHANGE_EVENT));
  }, []);

  return [prefs, setPrefs];
}

// ─────────────────────────────────────────────────────────────────────────
// Data
// ─────────────────────────────────────────────────────────────────────────

interface FieldSeries {
  metric: string;
  label: string;
  unit: string | null;
  count: number;
  total: number;
  average: number;
  days: RegisterRow['days'];
}

interface FieldBreakdown {
  metric: string;
  numericLabel: string;
  unit: string | null;
  enumLabel: string;
  bars: { label: string; value: number }[];
}

interface Correlation {
  metric: string;
  xLabel: string;
  yLabel: string;
  points: ScatterPoint[];
}

interface AgingItem {
  kind: 'question' | 'todo';
  label: string;
  entryId: string | null;
  daysOpen: number;
}

interface AnalysisData {
  metrics: MetricSummary[];
  windowDays: number;
  fieldSeries: FieldSeries[];
  breakdowns: FieldBreakdown[];
  correlations: Correlation[];
  reviews: ReviewMediumSummary[];
  reviewRows: { title: string; medium: string; eventTime: string; rating: number | null; note: string; entryId: string }[];
  ratingsByMedium: { label: string; value: number }[];
  histOverall: ReviewRatingBucket[];
  histByMedium: ReviewMediumHistogram[];
  stripLanes: { medium: string; ratings: number[] }[];
  lists: ListTypeSummary[];
  opinions: OpinionSubjectSummary[];
  questions: QuestionsSummaryResponse;
  recentOpenQuestions: OpenQuestion[];
  todos: TodosSummaryResponse;
  recentOpenTodos: Todo[];
  aging: AgingItem[];
}

/**
 * The analysis surface (`plan.md` M8, `design.md` §5.3): the print
 * information-design tradition — statistical yearbooks, almanacs, field
 * guides — rendered in the same cream, ink, and green as everywhere else.
 * Three named registers (Rhythms, Tallies, Threads), one shared time
 * window, and one reusable `Panel` per section — a category gets added by
 * dropping in a panel, not inventing a layout (`design.md` §5.3's own
 * "Analysis Plates" study, worked through here in full).
 *
 * Every number is already aggregated by the backend (`requirements.md`
 * §7.1), or is a raw record this page fetched exactly as given. What this
 * page computes on its own stays purely presentational: a min/max/last
 * picked off values already returned, a median sorted from ratings already
 * fetched, a day's age from a timestamp already on the record — never a
 * new sum, average, or correlation invented client-side.
 */
export default function AnalysisPage() {
  const [prefs, setPrefs] = usePrefs();
  const [data, setData] = useState<AnalysisData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [customizing, setCustomizing] = useState(false);

  useEffect(() => {
    const windowDays = prefs.windowDays;
    Promise.all([
      analysisMetrics({ windowDays }),
      analysisReviews(),
      analysisReviewsHistogram(),
      analysisLists(),
      analysisOpinions(),
      analysisQuestions(),
      analysisTodos(),
      listMetricFields(),
      listQuestions({ status: 'open', limit: RAW_RECORD_LIMIT }),
      listTodos({ status: 'open', limit: RAW_RECORD_LIMIT }),
      listReviews({ limit: RAW_RECORD_LIMIT }),
    ])
      .then(
        async ([
          metricsResponse,
          reviewsResponse,
          histogramResponse,
          listsResponse,
          opinionsResponse,
          questionsResponse,
          todosResponse,
          fieldsResponse,
          openQuestionsResponse,
          openTodosResponse,
          reviewsRaw,
        ]) => {
          const numericFields = fieldsResponse.fields.filter((f) => f.fieldType === 'numeric' || f.fieldType === 'score');
          const enumFields = fieldsResponse.fields.filter((f) => f.fieldType === 'enum');

          const fieldSeries: FieldSeries[] = await Promise.all(
            numericFields.map(async (field): Promise<FieldSeries> => {
              const summary = await analysisMetricField(field.metric, field.fieldKey, { windowDays });
              return {
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

          const enumFieldValues = await Promise.all(
            enumFields.map(async (field) => ({ field, values: (await listMetricFieldValues(field.id)).values })),
          );
          const breakdownRequests = numericFields.flatMap((numericField) =>
            enumFieldValues
              .filter(({ field: enumField, values }) => enumField.metric === numericField.metric && values.length > 0)
              .flatMap(({ field: enumField, values }) => values.map((value) => ({ numericField, enumField, value }))),
          );
          const breakdownResults = await Promise.all(
            breakdownRequests.map(async ({ numericField, enumField, value }) => ({
              numericField,
              enumField,
              value,
              summary: await analysisMetricField(numericField.metric, numericField.fieldKey, {
                windowDays,
                filter: { field: enumField.fieldKey, value },
              }),
            })),
          );
          const breakdownByPair = new Map<string, FieldBreakdown>();
          for (const result of breakdownResults) {
            const key = `${result.numericField.id}:${result.enumField.id}`;
            let breakdown = breakdownByPair.get(key);
            if (!breakdown) {
              breakdown = {
                metric: result.numericField.metric,
                numericLabel: result.numericField.label,
                unit: result.numericField.unit,
                enumLabel: result.enumField.label,
                bars: [],
              };
              breakdownByPair.set(key, breakdown);
            }
            breakdown.bars.push({ label: result.value, value: result.summary.total });
          }
          const breakdowns = Array.from(breakdownByPair.values())
            .map((b) => ({ ...b, bars: b.bars.filter((bar) => bar.value > 0) }))
            .filter((b) => b.bars.length > 0);

          const fieldsByMetric = new Map<string, MetricFieldDefinition[]>();
          for (const field of numericFields) {
            const list = fieldsByMetric.get(field.metric) ?? [];
            list.push(field);
            fieldsByMetric.set(field.metric, list);
          }
          const pairedMetrics = Array.from(fieldsByMetric.entries()).filter(([, fields]) => fields.length === 2);
          const correlations = (
            await Promise.all(
              pairedMetrics.map(async ([metric, [fieldX, fieldY]]) => {
                const raw = await listMetrics({ metric, limit: RAW_RECORD_LIMIT });
                const points: ScatterPoint[] = [];
                for (const record of raw.metrics) {
                  const x = record.fields[fieldX!.fieldKey];
                  const y = record.fields[fieldY!.fieldKey];
                  if (typeof x !== 'number' || typeof y !== 'number') continue;
                  points.push({
                    x,
                    y,
                    entryId: record.entryId,
                    label: `${formatDate(record.eventTime)} — ${fieldX!.label} ${x}${fieldX!.unit ? ` ${fieldX!.unit}` : ''}, ${fieldY!.label} ${y}${fieldY!.unit ? ` ${fieldY!.unit}` : ''}`,
                  });
                }
                return { metric, xLabel: fieldX!.label, yLabel: fieldY!.label, points };
              }),
            )
          ).filter((c) => c.points.length >= 2);

          const reviewRows = reviewsRaw.reviews
            .slice(0, RECENT_FEED_LIMIT * 4)
            .map((r) => ({
              title: r.title,
              medium: r.medium,
              eventTime: formatDate(r.eventTime),
              rating: r.rating,
              note: r.opinion.split(/(?<=[.!?])\s/)[0] ?? r.opinion,
              entryId: r.entryId,
            }));

          const ratingsByMedium = reviewsResponse.summaries
            .filter((s) => s.averageRating !== null)
            .map((s) => ({ label: s.medium, value: s.averageRating as number }));

          const stripLanes = reviewsResponse.summaries.map((s) => ({
            medium: s.medium,
            ratings: reviewsRaw.reviews.filter((r) => r.medium === s.medium && r.rating !== null).map((r) => r.rating as number),
          }));

          const now = Date.now();
          const daysOpen = (eventTime: string) => Math.max(0, Math.floor((now - Date.parse(eventTime)) / 86_400_000));
          const aging: AgingItem[] = [
            ...openQuestionsResponse.questions.map((q): AgingItem => ({ kind: 'question', label: q.question, entryId: q.entryId, daysOpen: daysOpen(q.eventTime) })),
            ...openTodosResponse.todos.map((t): AgingItem => ({ kind: 'todo', label: t.text, entryId: t.entryId, daysOpen: daysOpen(t.eventTime) })),
          ]
            .sort((a, b) => b.daysOpen - a.daysOpen)
            .slice(0, 12);

          setData({
            metrics: metricsResponse.summaries,
            windowDays: metricsResponse.windowDays,
            fieldSeries,
            breakdowns,
            correlations,
            reviews: reviewsResponse.summaries,
            reviewRows,
            ratingsByMedium,
            histOverall: histogramResponse.overall,
            histByMedium: histogramResponse.byMedium,
            stripLanes,
            lists: listsResponse.summaries,
            opinions: opinionsResponse.summaries,
            questions: questionsResponse,
            recentOpenQuestions: openQuestionsResponse.questions.slice(0, RECENT_FEED_LIMIT),
            todos: todosResponse,
            recentOpenTodos: openTodosResponse.todos.slice(0, RECENT_FEED_LIMIT),
            aging,
          });
        },
      )
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not load analysis.'));
  }, [prefs.windowDays]);

  if (error) return <p className={styles.error}>{error}</p>;
  if (data === null) return <p className={styles.hint}>Loading…</p>;

  const isHidden = (id: string) => prefs.hidden.includes(id);
  const toggleHidden = (id: string) =>
    setPrefs((p) => ({ ...p, hidden: isHidden(id) ? p.hidden.filter((h) => h !== id) : [...p.hidden, id] }));
  const move = (register: RegisterName, id: string, dir: -1 | 1) =>
    setPrefs((p) => {
      const order = [...p.order[register]];
      const i = order.indexOf(id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= order.length) return p;
      [order[i], order[j]] = [order[j]!, order[i]!];
      return { ...p, order: { ...p.order, [register]: order } };
    });

  const calendarMetricNames = (prefs.calendarMetrics.length > 0 ? prefs.calendarMetrics : data.metrics.map((m) => m.metric)).slice(
    0,
    MAX_CALENDAR_METRICS,
  );
  const calendarMetrics = calendarMetricNames
    .map((name) => data.metrics.find((m) => m.metric === name))
    .filter((m): m is MetricSummary => m !== undefined)
    .map((m) => ({ name: m.metric, days: m.days }));

  const panels: Record<string, { title: string; seeAllHref?: string; body: React.ReactNode } | null> = {
    calendar: data.metrics.length === 0 ? null : {
      title: 'Presence',
      seeAllHref: '/metrics',
      body: <CombinedCalendar metrics={calendarMetrics} />,
    },
    register: data.fieldSeries.length === 0 ? null : {
      title: 'Register',
      body: <Register rows={data.fieldSeries.map((f) => ({ field: `${f.metric} — ${f.label}`, unit: f.unit, count: f.count, total: f.total, average: f.average, days: f.days }))} />,
    },
    horizon: data.fieldSeries.length === 0 ? null : {
      title: 'Horizon',
      body: <Horizon series={data.fieldSeries.map((f) => ({ label: `${f.metric} — ${f.label}`, unit: f.unit, days: f.days }))} />,
    },
    matrix: data.metrics.length === 0 ? null : {
      title: 'Aligned matrix',
      body: <YearMatrix metrics={data.metrics.map((m) => ({ name: m.metric, days: m.days }))} />,
      seeAllHref: undefined,
    },
    breakdowns: data.breakdowns.length === 0 && data.correlations.length === 0 ? null : {
      title: 'Breakdowns',
      body: (
        <div className={styles.wideTiles}>
          {data.breakdowns.map((b) => {
            const max = Math.max(...b.bars.map((bar) => bar.value));
            const sorted = [...b.bars].sort((a, c) => c.value - a.value);
            return (
              <div key={`${b.metric}:${b.numericLabel}:${b.enumLabel}`} className={styles.breakdown}>
                <div className={styles.tileHeading}>
                  <span className={styles.tileName}>
                    {b.numericLabel} by {b.enumLabel}
                  </span>
                </div>
                {sorted.map((bar) => (
                  <div key={bar.label} className={styles.breakdownRow}>
                    <span className={styles.breakdownLabel}>{bar.label}</span>
                    <span className={styles.breakdownBarTrack}>
                      <span className={styles.breakdownBarFill} style={{ width: `${Math.round((bar.value / max) * 100)}%` }} />
                    </span>
                    <span className={styles.breakdownValue}>
                      {bar.value}
                      {b.unit ? ` ${b.unit}` : ''}
                    </span>
                  </div>
                ))}
              </div>
            );
          })}
          {data.correlations.map((c) => (
            <ScatterPlot key={c.metric} title={`${c.metric}: ${c.yLabel} vs ${c.xLabel}`} xAxisLabel={c.xLabel} yAxisLabel={c.yLabel} points={c.points} />
          ))}
        </div>
      ),
    },
    reviews: {
      title: 'Reviews',
      seeAllHref: '/reviews',
      body: data.reviews.length === 0 ? (
        <p className={styles.empty}>No approved review media yet.</p>
      ) : (
        <>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Medium</th>
                <th className={styles.numeric}>Count</th>
                <th className={styles.numeric}>Average rating</th>
              </tr>
            </thead>
            <tbody>
              {data.reviews.map((s) => (
                <tr key={s.medium}>
                  <td>{s.medium}</td>
                  <td className={styles.numeric}>{s.count}</td>
                  <td className={styles.rating}>{s.averageRating === null ? '—' : formatRating(s.averageRating)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.reviewRows.length > 0 && (
            <div className={styles.registerGap}>
              <ReviewsRegister rows={data.reviewRows} />
            </div>
          )}
        </>
      ),
    },
    distribution: (data.histOverall.every((b) => b.count === 0) && data.ratingsByMedium.length === 0) ? null : {
      title: 'Rating distribution',
      body: (
        <>
          {!data.histOverall.every((b) => b.count === 0) && <RatingHistogram overall={data.histOverall} byMedium={data.histByMedium} />}
          {data.ratingsByMedium.length > 0 && (
            <div className={styles.registerGap}>
              <DotPlot rows={data.ratingsByMedium} formatValue={(v) => formatRating(v)} />
            </div>
          )}
        </>
      ),
    },
    spread: data.stripLanes.every((l) => l.ratings.length === 0) ? null : {
      title: 'Ratings spread',
      body: <StripPlot lanes={data.stripLanes} />,
    },
    questions: {
      title: 'Questions',
      seeAllHref: '/questions',
      body: (
        <>
          <StatusBar openLabel="Open" openCount={data.questions.openCount} closedCount={data.questions.resolvedCount} />
          <Feed items={data.recentOpenQuestions.map((q) => ({ id: q.id, when: q.eventTime, text: q.question, entryId: q.entryId }))} />
        </>
      ),
    },
    todos: {
      title: 'Todos',
      seeAllHref: '/todos',
      body: (
        <>
          <StatusBar openLabel="Open" openCount={data.todos.openCount} closedCount={data.todos.doneCount} />
          <Feed items={data.recentOpenTodos.map((t) => ({ id: t.id, when: t.eventTime, text: t.text, entryId: t.entryId }))} />
        </>
      ),
    },
    lists: {
      title: 'Lists',
      seeAllHref: '/lists',
      body: data.lists.length === 0 ? (
        <p className={styles.empty}>No approved list types yet.</p>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Type</th>
              <th className={styles.numeric}>Count</th>
            </tr>
          </thead>
          <tbody>
            {data.lists.map((s) => (
              <tr key={s.listType}>
                <td>{s.listType}</td>
                <td className={styles.numeric}>{s.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ),
    },
    concepts: {
      title: 'Concepts',
      seeAllHref: '/opinions',
      body: data.opinions.length === 0 ? (
        <p className={styles.empty}>No approved subjects yet.</p>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Subject</th>
              <th className={styles.numeric}>Statements</th>
            </tr>
          </thead>
          <tbody>
            {data.opinions.map((s) => (
              <tr key={s.subject}>
                <td>{s.subject}</td>
                <td className={styles.numeric}>{s.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ),
    },
    aging: data.aging.length === 0 ? null : {
      title: 'How long things stay open',
      body: (
        <DotPlot
          rows={data.aging.map((a) => ({
            label: a.label.length > 40 ? `${a.label.slice(0, 40)}…` : a.label,
            value: a.daysOpen,
            ...(a.entryId ? { href: `/entry/${a.entryId}` } : {}),
          }))}
          formatValue={(v) => `${v}d`}
        />
      ),
    },
  };

  const registerTitle: Record<RegisterName, string> = { rhythms: 'Rhythms', tallies: 'Tallies', threads: 'Threads' };

  return (
    <div className={styles.breakout}>
      <div className={styles.frame}>
        <div className={styles.controls}>
          <div className={styles.windowControl} role="group" aria-label="Time window">
            {WINDOW_PRESETS.map((preset) => (
              <button
                key={preset.label}
                type="button"
                className={prefs.windowDays === preset.days ? styles.windowButtonActive : styles.windowButton}
                onClick={() => setPrefs((p) => ({ ...p, windowDays: preset.days }))}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <button type="button" className={styles.customizeButton} onClick={() => setCustomizing((c) => !c)}>
            {customizing ? 'Done' : 'Customize'}
          </button>
        </div>

        {customizing && (
          <div className={styles.customizePanel}>
            <div className={styles.customizeField}>
              <p className={styles.customizeLabel}>Metrics shown on the presence calendar (up to {MAX_CALENDAR_METRICS})</p>
              <div className={styles.customizeChips}>
                {data.metrics.map((m) => {
                  const on = calendarMetricNames.includes(m.metric);
                  return (
                    <button
                      key={m.metric}
                      type="button"
                      className={on ? styles.chipOn : styles.chip}
                      onClick={() =>
                        setPrefs((p) => {
                          const current = p.calendarMetrics.length > 0 ? p.calendarMetrics : data.metrics.map((x) => x.metric);
                          const next = current.includes(m.metric)
                            ? current.filter((n) => n !== m.metric)
                            : current.length >= MAX_CALENDAR_METRICS
                              ? current
                              : [...current, m.metric];
                          return { ...p, calendarMetrics: next };
                        })
                      }
                    >
                      {m.metric}
                    </button>
                  );
                })}
              </div>
            </div>

            {(Object.keys(DEFAULT_ORDER) as RegisterName[]).map((register) => (
              <div key={register} className={styles.customizeField}>
                <p className={styles.customizeLabel}>{registerTitle[register]}</p>
                <ul className={styles.customizeList}>
                  {prefs.order[register].map((id, i) => {
                    const panel = panels[id];
                    if (!panel) return null;
                    return (
                      <li key={id} className={styles.customizeRow}>
                        <label>
                          <input type="checkbox" checked={!isHidden(id)} onChange={() => toggleHidden(id)} /> {panel.title}
                        </label>
                        <span className={styles.customizeMoveGroup}>
                          <button type="button" onClick={() => move(register, id, -1)} disabled={i === 0} aria-label={`Move ${panel.title} up`}>
                            ↑
                          </button>
                          <button
                            type="button"
                            onClick={() => move(register, id, 1)}
                            disabled={i === prefs.order[register].length - 1}
                            aria-label={`Move ${panel.title} down`}
                          >
                            ↓
                          </button>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
            <button type="button" className={styles.resetButton} onClick={() => setPrefs(defaultPrefs())}>
              Reset to defaults
            </button>
          </div>
        )}

        {(Object.keys(DEFAULT_ORDER) as RegisterName[]).map((register) => {
          const ids = prefs.order[register].filter((id) => panels[id] && !isHidden(id));
          if (ids.length === 0) return null;
          return (
            <section key={register} className={styles.section}>
              <h2 className={styles.registerHeading}>{registerTitle[register]}</h2>
              <div className={styles.panelStack}>
                {ids.map((id) => {
                  const panel = panels[id]!;
                  return (
                    <Panel key={id} title={panel.title} seeAllHref={panel.seeAllHref}>
                      {panel.body}
                    </Panel>
                  );
                })}
              </div>
            </section>
          );
        })}

        <section className={styles.section}>
          <Link href="/categories" className={styles.seeAll}>
            Manage categories →
          </Link>
        </section>
      </div>
    </div>
  );
}

function Feed({ items }: { items: { id: string; when: string; text: string; entryId: string | null }[] }) {
  if (items.length === 0) return null;
  return (
    <ol className={styles.feed}>
      {items.map((item) => (
        <li key={item.id} className={styles.feedRow}>
          <time dateTime={item.when} className={styles.feedWhen}>
            {formatDate(item.when)}
          </time>
          <span className={styles.feedText}>{item.text}</span>
          {item.entryId && (
            <Link href={`/entry/${item.entryId}`} className={styles.link}>
              Source entry
            </Link>
          )}
        </li>
      ))}
    </ol>
  );
}
