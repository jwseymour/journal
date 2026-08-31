import type { DayCount, DayValue, ReviewMediumHistogram, ReviewRatingBucket } from '@journal/contract';
import Link from 'next/link';
import type { ReactNode } from 'react';
import styles from './analysis-charts.module.css';

/**
 * A handful of denser chart primitives for `/analysis` (`design.md` §5.3),
 * alongside the plain sparkline and bar list already in `page.module.css`.
 * Same rules as everywhere else in the app: hairlines, one accent colour, no
 * gradients, no 3D, no drop shadows — the variety comes from the *shape* of
 * the chart, not from decoration. Every number a chart draws was already
 * computed by the backend or is a raw field value off a real record
 * (`requirements.md` §7.1); what these components do on their own is purely
 * geometric — finding a min/max to scale against, bucketing a count into an
 * intensity step, laying days out into calendar weeks — never a new sum,
 * average, or filter.
 */

const WEEKDAY_LABELS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

/** Monday-first weekday index for a `YYYY-MM-DD` date, read as UTC (the
 * same convention the backend's `DayCount`/`DayValue` dates already use). */
function mondayIndex(date: string): number {
  const utcDay = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0=Sun..6=Sat
  return (utcDay + 6) % 7;
}

/** Lays a flat, oldest-first run of days out into calendar weeks (Monday to
 * Sunday), padding the first and last week with `null` so every row has
 * exactly seven cells. A layout transform only — it invents no data. */
function calendarWeeks<T extends { date: string }>(days: readonly T[]): (T | null)[][] {
  if (days.length === 0) return [];
  const weeks: (T | null)[][] = [];
  let week: (T | null)[] = new Array(mondayIndex(days[0]!.date)).fill(null);
  for (const day of days) {
    week.push(day);
    if (week.length === 7) {
      weeks.push(week);
      week = [];
    }
  }
  if (week.length > 0) {
    while (week.length < 7) week.push(null);
    weeks.push(week);
  }
  return weeks;
}

function heatClass(count: number, max: number): string {
  if (count <= 0 || max <= 0) return styles.heat0!;
  const ratio = count / max;
  if (ratio > 0.66) return styles.heat3!;
  if (ratio > 0.33) return styles.heat2!;
  return styles.heat1!;
}

/**
 * A metric's presence laid out as a proper calendar page — weeks as
 * columns, weekdays as rows — rather than one flat wrapped row of dots.
 * Reads as a small field-guide almanac page rather than a progress bar, and
 * a count of 3 occurrences in a day now looks different from a count of 1
 * (`design.md` §5.3: colour used only where it carries information).
 */
export function CalendarHeatmap({ title, totalLabel, days }: { title: string; totalLabel: string; days: readonly DayCount[] }) {
  const weeks = calendarWeeks(days);
  const max = Math.max(0, ...days.map((d) => d.count));

  return (
    <div className={styles.tile}>
      <div className={styles.tileHeading}>
        <span className={styles.tileName}>{title}</span>
        <span className={styles.tileCount}>{totalLabel}</span>
      </div>
      <div className={styles.calendar}>
        <div className={styles.calendarLabels}>
          {WEEKDAY_LABELS.map((label, i) => (
            <span key={i} className={styles.calendarLabel}>
              {label}
            </span>
          ))}
        </div>
        <div
          className={styles.calendarGrid}
          style={{ gridTemplateColumns: `repeat(${weeks.length}, 1fr)` }}
          role="img"
          aria-label={`${title} by day, ${weeks.length} weeks`}
        >
          {weeks.map((week, weekIndex) =>
            week.map((day, dayIndex) =>
              day ? (
                <span
                  key={`${weekIndex}-${dayIndex}`}
                  className={`${styles.calendarCell} ${heatClass(day.count, max)}`}
                  title={`${day.date}: ${day.count}`}
                />
              ) : (
                <span key={`${weekIndex}-${dayIndex}`} className={styles.calendarCellEmpty} />
              ),
            ),
          )}
        </div>
      </div>
    </div>
  );
}

const SPARK_WIDTH = 100;
const SPARK_HEIGHT = 30;

/**
 * A real Tufte word-sized line, not a bar per day — a thin polyline with a
 * flat translucent area banked to zero, and the most recent value marked
 * with a single dot. The viewBox is an abstract 100×30 coordinate space, not
 * CSS pixels, so the numbers in it are graphics geometry rather than the
 * literal sizes `design.md` §6.2 bans from components — the same distinction
 * that already lets a bar's data-driven width or height pass that rule.
 */
export function LineSparkline({
  title,
  totalLabel,
  unit,
  days,
}: {
  title: string;
  totalLabel: string;
  unit: string | null;
  days: readonly DayValue[];
}) {
  const max = Math.max(0, ...days.map((d) => d.value));
  const n = days.length;
  const x = (i: number) => (n <= 1 ? SPARK_WIDTH / 2 : (i / (n - 1)) * SPARK_WIDTH);
  const y = (value: number) => (max <= 0 ? SPARK_HEIGHT : SPARK_HEIGHT - (value / max) * SPARK_HEIGHT);

  const linePoints = days.map((day, i) => `${x(i)},${y(day.value)}`).join(' ');
  const areaPath =
    n > 0
      ? `M ${x(0)},${SPARK_HEIGHT} L ${days.map((day, i) => `${x(i)},${y(day.value)}`).join(' L ')} L ${x(n - 1)},${SPARK_HEIGHT} Z`
      : '';
  const last = days[n - 1];

  return (
    <div className={styles.tile}>
      <div className={styles.tileHeading}>
        <span className={styles.tileName}>{title}</span>
        <span className={styles.tileCount}>{totalLabel}</span>
      </div>
      <svg
        className={styles.lineChart}
        viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${title} trend over the period shown`}
      >
        {areaPath && <path d={areaPath} className={styles.lineArea} />}
        {n > 1 && <polyline points={linePoints} className={styles.lineStroke} />}
        {last && (
          <circle cx={x(n - 1)} cy={y(last.value)} r={1.6} className={styles.linePoint}>
            <title>
              {last.date}: {last.value}
              {unit ? ` ${unit}` : ''}
            </title>
          </circle>
        )}
      </svg>
    </div>
  );
}

export interface ScatterPoint {
  x: number;
  y: number;
  entryId: string;
  /** Full tooltip text, already formatted by the caller — this component
   * stays generic over what the axes mean. */
  label: string;
}

const SCATTER_WIDTH = 120;
const SCATTER_HEIGHT = 80;
const SCATTER_PAD = 8;

/**
 * A range-frame scatter (Tufte's term): the axis lines span only the actual
 * range of the data, not a full bounding box, and carry just their two end
 * values rather than a tick per gridline. Every point is a real record,
 * linked back to the entry it came from (`requirements.md` §3) — the
 * correlation itself is left for the reader's eye, nothing here computes one.
 */
export function ScatterPlot({
  title,
  xAxisLabel,
  yAxisLabel,
  points,
  formatXBound = formatBound,
  formatYBound = formatBound,
}: {
  title: string;
  xAxisLabel: string;
  yAxisLabel: string;
  points: readonly ScatterPoint[];
  /** How to print an axis's min/max below the plot — a plain number by
   * default, but a caller plotting epoch milliseconds (the only numeric
   * form a date can take as an `x`/`y`) needs to say so itself. Formatting,
   * not a computation: it changes how a value already on the point is
   * printed, never which value is used to place it. */
  formatXBound?: (value: number) => string;
  formatYBound?: (value: number) => string;
}) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  const xSpan = xMax - xMin || 1;
  const ySpan = yMax - yMin || 1;

  const plotX = (value: number) => SCATTER_PAD + ((value - xMin) / xSpan) * (SCATTER_WIDTH - 2 * SCATTER_PAD);
  const plotY = (value: number) => SCATTER_HEIGHT - SCATTER_PAD - ((value - yMin) / ySpan) * (SCATTER_HEIGHT - 2 * SCATTER_PAD);

  return (
    <div className={styles.tile}>
      <div className={styles.tileHeading}>
        <span className={styles.tileName}>{title}</span>
      </div>
      <svg
        className={styles.scatter}
        viewBox={`0 0 ${SCATTER_WIDTH} ${SCATTER_HEIGHT}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={`${title}: ${yAxisLabel} against ${xAxisLabel}, ${points.length} points`}
      >
        {/* Range frame: axis hairlines spanning only the data's own range. */}
        <line
          x1={plotX(xMin)}
          y1={SCATTER_HEIGHT - SCATTER_PAD}
          x2={plotX(xMax)}
          y2={SCATTER_HEIGHT - SCATTER_PAD}
          className={styles.scatterAxis}
        />
        <line x1={plotX(xMin)} y1={plotY(yMin)} x2={plotX(xMin)} y2={plotY(yMax)} className={styles.scatterAxis} />
        {points.map((point, i) => (
          // A plain SVG anchor, not `next/link` — simpler and better-supported
          // as a child of `<svg>` than a component built around HTML routing.
          <a key={i} href={`/entry/${point.entryId}`} className={styles.scatterLink}>
            <circle cx={plotX(point.x)} cy={plotY(point.y)} r={1.4} className={styles.scatterPoint}>
              <title>{point.label}</title>
            </circle>
          </a>
        ))}
      </svg>
      <div className={styles.scatterAxisLabels}>
        <span>
          {xAxisLabel}: {formatXBound(xMin)}–{formatXBound(xMax)}
        </span>
        <span>
          {yAxisLabel}: {formatYBound(yMin)}–{formatYBound(yMax)}
        </span>
      </div>
    </div>
  );
}

function formatBound(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/**
 * The one reusable panel every named section of the analysis page is
 * built from — eyebrow, an optional "all →" link, a body, and an optional
 * footnote (`design.md` §5.3's almanac idiom, "a kit of presentation
 * components good enough to drop real categories into"). Adding a
 * category becomes adding a panel, not inventing a new layout.
 */
export function Panel({
  title,
  seeAllHref,
  seeAllLabel = 'All →',
  footnote,
  children,
}: {
  title: string;
  seeAllHref?: string;
  seeAllLabel?: string;
  footnote?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={styles.panel}>
      <div className={styles.panelHead}>
        <span className={styles.panelTitle}>{title}</span>
        {seeAllHref && (
          <Link href={seeAllHref} className={styles.panelSeeAll}>
            {seeAllLabel}
          </Link>
        )}
      </div>
      <div className={styles.panelBody}>{children}</div>
      {footnote && <div className={styles.panelFoot}>{footnote}</div>}
    </div>
  );
}

/** A two-segment open/resolved (or open/done) bar, the one number every
 * `Panel` around a thread structure (questions, todos) needs before its
 * feed — a shape, not just a count. */
export function StatusBar({ openLabel, openCount, closedCount }: { openLabel: string; openCount: number; closedCount: number }) {
  const total = openCount + closedCount;
  const openPct = total === 0 ? 0 : (openCount / total) * 100;
  return (
    <div className={styles.statusBar}>
      <span className={styles.statusBarLabel}>
        {openLabel} {openCount}
      </span>
      <span className={styles.statusBarTrack} role="img" aria-label={`${openCount} open, ${closedCount} resolved`}>
        <span className={styles.statusBarOpen} style={{ width: `${openPct}%` }} />
      </span>
    </div>
  );
}

/**
 * The register (`design.md` §5.3's statistical-yearbook table) — every
 * numeric/score field on one line: n, total, mean, min, max, last, and a
 * trend sparkline in place of the loose pile of `LineSparkline` tiles this
 * replaces. `min`/`max`/`last` are picked off `days`, the same as
 * `LineSparkline`'s own `max` already is here — a selection, not a new sum
 * or average (`requirements.md` §7.1); `total`/`mean`/`count` are exactly
 * what the backend's field-summary already returned.
 */
export interface RegisterRow {
  field: string;
  unit: string | null;
  count: number;
  total: number;
  average: number;
  days: readonly DayValue[];
}

export function Register({ rows }: { rows: readonly RegisterRow[] }) {
  return (
    <div className={styles.tableWrap}>
      <table className={styles.register}>
        <thead>
          <tr>
            <th>Field</th>
            <th className={styles.num}>n</th>
            <th className={styles.num}>Total</th>
            <th className={styles.num}>Mean</th>
            <th className={styles.num}>Min</th>
            <th className={styles.num}>Max</th>
            <th className={styles.num}>Last</th>
            <th className={styles.trendCol}>Trend</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const values = row.days.map((d) => d.value);
            const min = values.length > 0 ? Math.min(...values) : null;
            const max = values.length > 0 ? Math.max(...values) : null;
            const last = row.days[row.days.length - 1]?.value ?? null;
            const unit = row.unit ? ` ${row.unit}` : '';
            return (
              <tr key={row.field}>
                <td>{row.field}</td>
                <td className={styles.num}>{row.count}</td>
                <td className={styles.num}>
                  {row.total.toFixed(row.total % 1 === 0 ? 0 : 1)}
                  {unit}
                </td>
                <td className={styles.num}>
                  {row.count === 0 ? '—' : `${row.average.toFixed(1)}${unit}`}
                </td>
                <td className={styles.num}>{min === null ? '—' : `${formatBound(min)}${unit}`}</td>
                <td className={styles.num}>{max === null ? '—' : `${formatBound(max)}${unit}`}</td>
                <td className={styles.num}>{last === null ? '—' : `${formatBound(last)}${unit}`}</td>
                <td className={styles.trendCell}>
                  <MiniTrend days={row.days} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** The trend column's own tiny sparkline — same geometry `LineSparkline`
 * already uses, just sized to sit inline in a table cell. */
function MiniTrend({ days }: { days: readonly DayValue[] }) {
  const max = Math.max(0, ...days.map((d) => d.value));
  const n = days.length;
  const x = (i: number) => (n <= 1 ? SPARK_WIDTH / 2 : (i / (n - 1)) * SPARK_WIDTH);
  const y = (value: number) => (max <= 0 ? SPARK_HEIGHT : SPARK_HEIGHT - (value / max) * SPARK_HEIGHT);
  const points = days.map((d, i) => `${x(i)},${y(d.value)}`).join(' ');
  return (
    <svg className={styles.trendSvg} viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`} preserveAspectRatio="none" aria-hidden="true">
      {n > 1 && <polyline points={points} className={styles.lineStroke} />}
    </svg>
  );
}

/**
 * The horizon stack (`design.md` §5.3) — several numeric fields on one
 * shared time axis, each a band shaded by relative intensity (darker =
 * higher) rather than four separate charts. Series are compared by
 * *shape*, not colour — the system's single accent is the only hue used,
 * varied by opacity (`design.md` §2.1's "no fourth colour").
 */
export function Horizon({ series }: { series: readonly { label: string; unit: string | null; days: readonly DayValue[] }[] }) {
  return (
    <div className={styles.horizon}>
      {series.map((s) => {
        const max = Math.max(0, ...s.days.map((d) => d.value));
        return (
          <div key={s.label} className={styles.horizonRow}>
            <span className={styles.horizonLabel}>{s.label}</span>
            <span className={styles.horizonBand} role="img" aria-label={`${s.label} over the period shown`}>
              {s.days.map((d) => (
                <span
                  key={d.date}
                  className={styles.horizonCell}
                  style={{ opacity: max <= 0 ? 0 : Math.max(0.06, d.value / max) }}
                  title={`${d.date}: ${d.value}${s.unit ? ` ${s.unit}` : ''}`}
                />
              ))}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * A labelled dot on a shared numeric scale (Tufte's alternative to a bar
 * from zero) — better than `RankedBars` when the *value* matters more than
 * the magnitude a bar exaggerates, e.g. an average rating where a bar
 * makes a 3.8 vs 4.2 look enormous. Reused for both "value by category"
 * (rating by medium) and "age by item" (days an item has been open) —
 * the same shape, different axis meaning.
 */
export function DotPlot({
  rows,
  formatValue = formatBound,
}: {
  rows: readonly { label: string; value: number; href?: string }[];
  formatValue?: (value: number) => string;
}) {
  const values = rows.map((r) => r.value);
  const min = Math.min(0, ...values);
  const max = Math.max(...values, 0.0001);
  const span = max - min || 1;
  const pct = (value: number) => ((value - min) / span) * 100;

  return (
    <div className={styles.dotplot}>
      {rows.map((row) => {
        const dot = (
          <span className={styles.dotplotDot} style={{ left: `${pct(row.value)}%` }}>
            <span className={styles.dotplotValue}>{formatValue(row.value)}</span>
          </span>
        );
        return (
          <div key={row.label} className={styles.dotplotRow}>
            <span className={styles.dotplotLabel}>{row.label}</span>
            <span className={styles.dotplotTrack}>
              <span className={styles.dotplotAxis} />
              {row.href ? (
                <Link href={row.href} className={styles.dotplotLink}>
                  {dot}
                </Link>
              ) : (
                dot
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * A strip plot — every individual rating is one tick in its medium's lane,
 * plus the median marked heavier. Replaces a "ratings over time" scatter
 * that plots a handful of points against dates and asks the eye to find a
 * trend that usually isn't there: a dozen scattered points are a
 * distribution, not a time series. Median is a sort-and-pick over ratings
 * already fetched, not a new aggregate (`requirements.md` §7.1).
 */
export function StripPlot({ lanes }: { lanes: readonly { medium: string; ratings: readonly number[] }[] }) {
  return (
    <div className={styles.strip}>
      {lanes.map((lane) => {
        if (lane.ratings.length === 0) return null;
        const sorted = [...lane.ratings].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        const median = sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : (sorted[mid] ?? 0);
        return (
          <div key={lane.medium} className={styles.stripLane}>
            <span className={styles.stripLabel}>{lane.medium}</span>
            <span className={styles.stripTrack} role="img" aria-label={`${lane.medium} ratings, median ${median}`}>
              {lane.ratings.map((r, i) => (
                <span key={i} className={styles.stripTick} style={{ left: `${(r / 5) * 100}%` }} />
              ))}
              <span className={styles.stripMedian} style={{ left: `${(median / 5) * 100}%` }} />
            </span>
          </div>
        );
      })}
      <div className={styles.stripAxis}>
        <span>1</span>
        <span>2</span>
        <span>3</span>
        <span>4</span>
        <span>5</span>
      </div>
    </div>
  );
}

/**
 * The reading-diary table (`design.md` §5.3) — what reviews actually are:
 * a title, when, how much it was liked, one line of why. The primary
 * reviews surface; the tally/distribution plates around it are secondary.
 */
export function ReviewsRegister({
  rows,
}: {
  rows: readonly { title: string; medium: string; eventTime: string; rating: number | null; note: string; entryId: string }[];
}) {
  return (
    <div className={styles.tableWrap}>
      <table className={styles.reviewsTable}>
        <thead>
          <tr>
            <th>Title</th>
            <th>Medium</th>
            <th>Seen</th>
            <th>Rating</th>
            <th>In a line</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              <td>
                <Link href={`/entry/${row.entryId}`} className={styles.reviewTitleLink}>
                  {row.title}
                </Link>
              </td>
              <td className={styles.reviewMedium}>{row.medium}</td>
              <td className={styles.reviewWhen}>{row.eventTime}</td>
              <td>{row.rating === null ? '—' : <RatingPips rating={row.rating} />}</td>
              <td className={styles.reviewNote}>{row.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RatingPips({ rating }: { rating: number }) {
  const pips = [1, 2, 3, 4, 5].map((n) => {
    if (rating >= n) return 'full';
    if (rating >= n - 0.5) return 'half';
    return 'empty';
  });
  return (
    <span className={styles.pips} role="img" aria-label={`${rating} out of 5`}>
      {pips.map((state, i) => (
        <span key={i} className={state === 'full' ? styles.pipFull : state === 'half' ? styles.pipHalf : styles.pipEmpty} />
      ))}
    </span>
  );
}

/**
 * The rating histogram (`design.md` §5.3) — "am I a generous rater, do I
 * rate books harder than films" is a question about *shape*, which a mean
 * hides; the per-medium small multiples make each medium's own shape
 * legible against the whole.
 */
export function RatingHistogram({ overall, byMedium }: { overall: readonly ReviewRatingBucket[]; byMedium: readonly ReviewMediumHistogram[] }) {
  const overallMax = Math.max(1, ...overall.map((b) => b.count));
  return (
    <div>
      <div className={styles.hist}>
        {overall.map((b) => (
          <div key={b.rating} className={styles.histCol}>
            <span className={styles.histN}>{b.count || ''}</span>
            <span className={styles.histBar} style={{ height: `${(b.count / overallMax) * 100}%` }} />
            <span className={styles.histX}>{b.rating}</span>
          </div>
        ))}
      </div>
      {byMedium.length > 1 && (
        <div className={styles.histMini}>
          {byMedium.map((medium) => {
            const max = Math.max(1, ...medium.buckets.map((b) => b.count));
            const n = medium.buckets.reduce((sum, b) => sum + b.count, 0);
            if (n === 0) return null;
            return (
              <figure key={medium.medium} className={styles.histMiniFigure}>
                <figcaption>
                  {medium.medium} · n {n}
                </figcaption>
                <div className={`${styles.hist} ${styles.histSmall}`}>
                  {medium.buckets.map((b) => (
                    <div key={b.rating} className={styles.histCol}>
                      <span className={styles.histBar} style={{ height: `${(b.count / max) * 100}%` }} />
                    </div>
                  ))}
                </div>
              </figure>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * The combined presence calendar (`design.md` §5.3's "month page," minus
 * arbitrary month navigation — every metric shares the one window the
 * page's own time-window control already governs, so this lays that same
 * window out as calendar weeks instead of adding a second, independent
 * month browser). Each day carries a fixed-position mark per metric — the
 * same slot is the same metric on every day, so a vertical scan down a
 * weekday shows a habit. Capped by the caller at a handful of metrics
 * (`design.md` §5.3's own plate note: "five metrics per day is the
 * ceiling before the mark row gets fiddly").
 */
export function CombinedCalendar({ metrics }: { metrics: readonly { name: string; days: readonly DayCount[] }[] }) {
  const canonicalDays = metrics[0]?.days ?? [];
  const weeks = calendarWeeks(canonicalDays);
  const maxByMetric = metrics.map((m) => Math.max(0, ...m.days.map((d) => d.count)));

  return (
    <div>
      <div className={styles.slotkey}>
        {metrics.map((m, i) => (
          <span key={m.name} className={styles.slotkeyItem}>
            <span className={styles.slotSwatch} data-slot={i % 5} />
            {m.name}
          </span>
        ))}
      </div>
      <div className={styles.calendar}>
        <div className={styles.calendarLabels}>
          {WEEKDAY_LABELS.map((label, i) => (
            <span key={i} className={styles.calendarLabel}>
              {label}
            </span>
          ))}
        </div>
        <div
          className={styles.calendarGrid}
          style={{ gridTemplateColumns: `repeat(${weeks.length}, 1fr)` }}
          role="img"
          aria-label={`${metrics.map((m) => m.name).join(', ')} by day, ${weeks.length} weeks`}
        >
          {weeks.map((week, weekIndex) =>
            week.map((day, dayIndex) => {
              if (!day) return <span key={`${weekIndex}-${dayIndex}`} className={styles.calendarCellEmpty} />;
              return (
                <span key={`${weekIndex}-${dayIndex}`} className={styles.combinedCell} title={day.date}>
                  <span className={styles.combinedDate}>{Number(day.date.slice(-2))}</span>
                  <span className={styles.combinedMarks}>
                    {metrics.map((m, i) => {
                      const count = m.days.find((d) => d.date === day.date)?.count ?? 0;
                      const max = maxByMetric[i] || 1;
                      return (
                        <span
                          key={m.name}
                          className={count > 0 ? styles.combinedMarkOn : styles.combinedMark}
                          data-slot={i % 5}
                          style={count > 0 ? { opacity: Math.max(0.35, count / max) } : undefined}
                        />
                      );
                    })}
                  </span>
                </span>
              );
            }),
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The aligned matrix (`design.md` §5.3) — every metric is one row, all
 * rows share the same day columns, so a single date lines up vertically
 * across every metric: co-occurrence and long gaps at a glance, a whole
 * window on one surface. Best read with a wide window (90 days or more);
 * the caller decides when that's worth offering.
 */
export function YearMatrix({ metrics }: { metrics: readonly { name: string; days: readonly DayCount[] }[] }) {
  return (
    <div className={styles.matrixWrap}>
      <div className={styles.matrix}>
        {metrics.map((m) => {
          const max = Math.max(0, ...m.days.map((d) => d.count));
          return (
            <div key={m.name} className={styles.matrixRow}>
              <span className={styles.matrixLabel}>{m.name}</span>
              <span className={styles.matrixCells} role="img" aria-label={`${m.name}, ${m.days.length} days`}>
                {m.days.map((d) => (
                  <span
                    key={d.date}
                    className={styles.matrixCell}
                    style={d.count > 0 ? { opacity: Math.max(0.28, d.count / (max || 1)) } : undefined}
                    data-on={d.count > 0 ? 'true' : undefined}
                    title={`${d.date}: ${d.count}`}
                  />
                ))}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
