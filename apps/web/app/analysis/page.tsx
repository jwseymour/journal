'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type {
  ListTypeSummary,
  MetricFieldDefinition,
  MetricFieldSummaryResponse,
  MetricSummary,
  OpenQuestion,
  QuestionsSummaryResponse,
  ReviewMediumSummary,
  Todo,
  TodosSummaryResponse,
} from '@journal/contract';
import {
  analysisLists,
  analysisMetricField,
  analysisMetrics,
  analysisQuestions,
  analysisReviews,
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
import { CalendarHeatmap, LineSparkline, ScatterPlot, type ScatterPoint } from '@/components/analysis-charts';
import styles from './page.module.css';

const RECENT_OPEN_QUESTIONS = 5;
const RECENT_OPEN_TODOS = 5;
/** The backend's own per-request cap (`apps/api/src/http/app.ts`'s
 * `MAX_LIMIT`) — asking for more just to plot every raw record still hits
 * this ceiling, so the charts below read "at most the 200 most recent". */
const RAW_RECORD_LIMIT = 200;

interface FieldTotal {
  metric: string;
  label: string;
  unit: string | null;
  summary: MetricFieldSummaryResponse;
}

/** One numeric/score field broken down by a sibling enum field on the same
 * metric — e.g. `exercise.distance_km` by `exercise.sport`. Every bar is a
 * real `analysisMetricField` call with that value as its filter
 * (`requirements.md` §7.1); this only groups the results it gets back for
 * rendering, the same "display lookup, not a computation" the field labels
 * on `/metrics` already do. */
interface FieldBreakdown {
  metric: string;
  numericLabel: string;
  unit: string | null;
  enumLabel: string;
  bars: { label: string; value: number }[];
}

/** Two numeric/score fields on the same metric, plotted against each other
 * — what a metric with structured fields (`plan.md` M9) makes possible that
 * a bare metric never could: does more sleep correlate with better sleep
 * quality, does a longer run mean more distance. Points are raw records
 * (`listMetrics`), not a new aggregate — the correlation is left for the
 * reader's eye, nothing here computes one. */
interface Correlation {
  metric: string;
  xLabel: string;
  yLabel: string;
  points: ScatterPoint[];
}

interface AnalysisData {
  metrics: MetricSummary[];
  windowDays: number;
  reviews: ReviewMediumSummary[];
  lists: ListTypeSummary[];
  fieldTotals: FieldTotal[];
  breakdowns: FieldBreakdown[];
  correlations: Correlation[];
  ratingPoints: ScatterPoint[];
  questions: QuestionsSummaryResponse;
  recentOpenQuestions: OpenQuestion[];
  todos: TodosSummaryResponse;
  recentOpenTodos: Todo[];
}

/**
 * The analysis surface (`plan.md` M8, `design.md` §5.3): the print
 * information-design tradition — statistical yearbooks, almanacs, field
 * guides — rendered in the same cream, ink, and green as everywhere else.
 * No chart junk, no gradients, no drop shadows; small multiples in
 * preference to one large chart, and a genuine variety of chart *shapes*
 * (calendar, line, range-frame scatter, ranked bar) rather than one kind
 * dressed up several ways.
 *
 * Every number here is already aggregated by the backend
 * (`requirements.md` §7.1), or is a raw field value off a real record this
 * page fetched exactly as given (`listMetrics`, `listReviews` — the same
 * category of "display lookup" the `/metrics` list page already does).
 * What this page computes on its own is purely presentational: a min/max to
 * scale an axis or a bar against, a date's weekday for calendar placement,
 * a sort for readability — never a new sum, average, or correlation.
 */
export default function AnalysisPage() {
  const [data, setData] = useState<AnalysisData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      analysisMetrics(),
      analysisReviews(),
      analysisLists(),
      analysisQuestions(),
      analysisTodos(),
      listMetricFields(),
      listQuestions({ status: 'open', limit: RECENT_OPEN_QUESTIONS }),
      listTodos({ status: 'open', limit: RECENT_OPEN_TODOS }),
      listReviews({ limit: RAW_RECORD_LIMIT }),
    ])
      .then(async ([metricsResponse, reviewsResponse, listsResponse, questionsResponse, todosResponse, fieldsResponse, openQuestionsResponse, openTodosResponse, reviewsRaw]) => {
        const windowDays = metricsResponse.windowDays;
        const numericFields = fieldsResponse.fields.filter((f) => f.fieldType === 'numeric' || f.fieldType === 'score');
        const enumFields = fieldsResponse.fields.filter((f) => f.fieldType === 'enum');

        const fieldTotals = await Promise.all(
          numericFields.map(async (field): Promise<FieldTotal> => ({
            metric: field.metric,
            label: field.label,
            unit: field.unit,
            summary: await analysisMetricField(field.metric, field.fieldKey, { windowDays }),
          })),
        );

        // Each enum field's approved values (`plan.md` M9) — what a
        // breakdown groups the matching numeric field by.
        const enumFieldValues = await Promise.all(
          enumFields.map(async (field) => ({ field, values: (await listMetricFieldValues(field.id)).values })),
        );

        const breakdownRequests = numericFields.flatMap((numericField) =>
          enumFieldValues
            .filter(({ field: enumField, values }) => enumField.metric === numericField.metric && values.length > 0)
            .flatMap(({ field: enumField, values }) =>
              values.map((value) => ({ numericField, enumField, value })),
            ),
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
          .map((breakdown) => ({ ...breakdown, bars: breakdown.bars.filter((bar) => bar.value > 0) }))
          .filter((breakdown) => breakdown.bars.length > 0);

        // Correlations: every metric with exactly two numeric/score fields
        // gets one scatter, the two fields plotted against each other. More
        // than two is left alone rather than guessing which pair matters.
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
        ).filter((correlation) => correlation.points.length >= 2);

        // Ratings over time, across every medium — a single scatter rather
        // than one per medium, so a handful of reviews still reads as a
        // trend instead of scattering into lone points.
        const ratingPoints: ScatterPoint[] = reviewsRaw.reviews
          .filter((review) => review.rating !== null)
          .map((review) => ({
            x: Date.parse(review.eventTime),
            y: review.rating as number,
            entryId: review.entryId,
            label: `${formatDate(review.eventTime)} — ${review.title} (${review.medium}), ${formatRating(review.rating as number)}`,
          }));

        setData({
          metrics: metricsResponse.summaries,
          windowDays,
          reviews: reviewsResponse.summaries,
          lists: listsResponse.summaries,
          fieldTotals,
          breakdowns,
          correlations,
          ratingPoints,
          questions: questionsResponse,
          recentOpenQuestions: openQuestionsResponse.questions,
          todos: todosResponse,
          recentOpenTodos: openTodosResponse.todos,
        });
      })
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not load analysis.'));
  }, []);

  if (error) return <p className={styles.error}>{error}</p>;
  if (data === null) return <p className={styles.hint}>Loading…</p>;

  return (
    <div className={styles.breakout}>
      <div className={styles.frame}>
        <section className={styles.section}>
          <div className={styles.headingRow}>
            <h2 className={styles.heading}>Metrics — last {data.windowDays} days</h2>
            <Link href="/metrics" className={styles.seeAll}>
              All metrics →
            </Link>
          </div>
          {data.metrics.length === 0 ? (
            <p className={styles.empty}>No approved metrics yet.</p>
          ) : (
            <div className={styles.wideTiles}>
              {data.metrics.map((summary) => (
                <CalendarHeatmap
                  key={summary.metric}
                  title={summary.metric}
                  totalLabel={`${summary.totalCount} total`}
                  days={summary.days}
                />
              ))}
            </div>
          )}
          {data.fieldTotals.length > 0 && (
            <div className={styles.wideTiles}>
              {data.fieldTotals.map((fieldTotal) => (
                <LineSparkline
                  key={`${fieldTotal.metric}:${fieldTotal.summary.fieldKey}`}
                  title={`${fieldTotal.metric} — ${fieldTotal.label}`}
                  totalLabel={`${fieldTotal.summary.total}${fieldTotal.unit ? ` ${fieldTotal.unit}` : ''} total (avg ${
                    fieldTotal.summary.count === 0 ? '—' : fieldTotal.summary.average.toFixed(1)
                  }${fieldTotal.unit && fieldTotal.summary.count > 0 ? ` ${fieldTotal.unit}` : ''})`}
                  unit={fieldTotal.unit}
                  days={fieldTotal.summary.days}
                />
              ))}
            </div>
          )}
          {(data.breakdowns.length > 0 || data.correlations.length > 0) && (
            <div className={styles.wideTiles}>
              {data.breakdowns.map((breakdown) => {
                const max = Math.max(...breakdown.bars.map((bar) => bar.value));
                const sorted = [...breakdown.bars].sort((a, b) => b.value - a.value);
                return (
                  <div key={`${breakdown.metric}:${breakdown.numericLabel}:${breakdown.enumLabel}`} className={styles.breakdown}>
                    <div className={styles.tileHeading}>
                      <span className={styles.tileName}>
                        {breakdown.numericLabel} by {breakdown.enumLabel}
                      </span>
                    </div>
                    {sorted.map((bar) => (
                      <div key={bar.label} className={styles.breakdownRow}>
                        <span className={styles.breakdownLabel}>{bar.label}</span>
                        <span className={styles.breakdownBarTrack}>
                          <span
                            className={styles.breakdownBarFill}
                            style={{ width: `${Math.round((bar.value / max) * 100)}%` }}
                          />
                        </span>
                        <span className={styles.breakdownValue}>
                          {bar.value}
                          {breakdown.unit ? ` ${breakdown.unit}` : ''}
                        </span>
                      </div>
                    ))}
                  </div>
                );
              })}
              {data.correlations.map((correlation) => (
                <ScatterPlot
                  key={correlation.metric}
                  title={`${correlation.metric}: ${correlation.yLabel} vs ${correlation.xLabel}`}
                  xAxisLabel={correlation.xLabel}
                  yAxisLabel={correlation.yLabel}
                  points={correlation.points}
                />
              ))}
            </div>
          )}
        </section>

        <div className={styles.almanac}>
          <section className={styles.section}>
            <div className={styles.headingRow}>
              <h2 className={styles.heading}>Reviews</h2>
              <Link href="/reviews" className={styles.seeAll}>
                All reviews →
              </Link>
            </div>
            {data.reviews.length === 0 ? (
              <p className={styles.empty}>No approved review media yet.</p>
            ) : (
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Medium</th>
                    <th className={styles.numeric}>Count</th>
                    <th className={styles.numeric}>Average rating</th>
                  </tr>
                </thead>
                <tbody>
                  {data.reviews.map((summary) => (
                    <tr key={summary.medium}>
                      <td>{summary.medium}</td>
                      <td className={styles.numeric}>{summary.count}</td>
                      <td className={styles.rating}>
                        {summary.averageRating === null ? '—' : formatRating(summary.averageRating)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {data.ratingPoints.length >= 2 && (
              <ScatterPlot
                title="Ratings over time"
                xAxisLabel="date"
                yAxisLabel="rating"
                points={data.ratingPoints}
                formatXBound={(value) => formatDate(new Date(value).toISOString())}
              />
            )}
          </section>

          <section className={styles.section}>
            <div className={styles.headingRow}>
              <h2 className={styles.heading}>Lists</h2>
              <Link href="/lists" className={styles.seeAll}>
                All list items →
              </Link>
            </div>
            {data.lists.length === 0 ? (
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
                  {data.lists.map((summary) => (
                    <tr key={summary.listType}>
                      <td>{summary.listType}</td>
                      <td className={styles.numeric}>{summary.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className={styles.section}>
            <div className={styles.headingRow}>
              <h2 className={styles.heading}>Opinions</h2>
              <Link href="/opinions" className={styles.seeAll}>
                All opinions →
              </Link>
            </div>
            <p className={styles.empty}>Views tracked over time, organised by subject.</p>
          </section>

          <section className={styles.section}>
            <div className={styles.headingRow}>
              <h2 className={styles.heading}>Questions</h2>
              <Link href="/questions" className={styles.seeAll}>
                All questions →
              </Link>
            </div>
            <p className={styles.empty}>
              {data.questions.openCount} open, {data.questions.resolvedCount} resolved.
            </p>
            {data.recentOpenQuestions.length > 0 && (
              <ol className={styles.feed}>
                {data.recentOpenQuestions.map((question) => (
                  <li key={question.id} className={styles.feedRow}>
                    <time dateTime={question.eventTime} className={styles.feedWhen}>
                      {formatDate(question.eventTime)}
                    </time>
                    <span className={styles.feedText}>{question.question}</span>
                    <Link href={`/entry/${question.entryId}`} className={styles.link}>
                      Source entry
                    </Link>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section className={styles.section}>
            <div className={styles.headingRow}>
              <h2 className={styles.heading}>Todos</h2>
              <Link href="/todos" className={styles.seeAll}>
                All todos →
              </Link>
            </div>
            <p className={styles.empty}>
              {data.todos.openCount} open, {data.todos.doneCount} done.
            </p>
            {data.recentOpenTodos.length > 0 && (
              <ol className={styles.feed}>
                {data.recentOpenTodos.map((todo) => (
                  <li key={todo.id} className={styles.feedRow}>
                    <time dateTime={todo.eventTime} className={styles.feedWhen}>
                      {formatDate(todo.eventTime)}
                    </time>
                    <span className={styles.feedText}>{todo.text}</span>
                    {todo.entryId && (
                      <Link href={`/entry/${todo.entryId}`} className={styles.link}>
                        Source entry
                      </Link>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>

        <section className={styles.section}>
          <Link href="/categories" className={styles.seeAll}>
            Manage categories →
          </Link>
        </section>
      </div>
    </div>
  );
}
