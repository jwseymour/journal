import type { DayCount, DayValue } from '@journal/contract';
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
