import type { SparklineChartSpec } from '@journal/contract';
import styles from './chat.module.css';

/**
 * The same hand-rolled technique `analysis/page.tsx` uses — one
 * hairline-bordered cell per day, filled with the accent colour only on a
 * day something happened (`design.md` §5.3: no chart junk, no gradients).
 * Parameterized over the backend's `SparklineChartSpec` instead of a
 * `MetricSummary`, since the chat feature can source a series from more than
 * one tool.
 */
export function SparklineChart({ spec }: { spec: SparklineChartSpec }) {
  const filledCount = spec.points.filter((point) => point.value > 0).length;

  return (
    <div className={styles.tile}>
      <div className={styles.tileHeading}>
        <span className={styles.tileName}>{spec.title}</span>
        {spec.totalLabel && <span className={styles.tileCount}>{spec.totalLabel}</span>}
      </div>
      <div
        className={styles.sparkline}
        role="img"
        aria-label={`${spec.title}: ${filledCount} of the last ${spec.points.length} days`}
      >
        {spec.points.map((point) => (
          <span
            key={point.date}
            className={point.value > 0 ? `${styles.day} ${styles.dayFilled}` : styles.day}
            title={`${point.date}: ${point.value}${spec.unit ? ` ${spec.unit}` : ''}`}
          />
        ))}
      </div>
    </div>
  );
}
