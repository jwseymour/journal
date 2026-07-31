import type { BarComparisonChartSpec } from '@journal/contract';
import styles from './chat.module.css';

/**
 * One hairline-underlined row per bar — a computed layout value (the bar's
 * own width, from real data) is not a "literal value" in the sense
 * `design.md` §6.2 prohibits; only fixed visual constants must come from a
 * token, and this one carries no gradient, no 3D, no drop shadow.
 */
export function BarComparisonChart({ spec }: { spec: BarComparisonChartSpec }) {
  const maxValue = Math.max(1, ...spec.bars.map((bar) => bar.value));

  return (
    <div className={styles.barChart}>
      <p className={styles.chartTitle}>{spec.title}</p>
      {spec.bars.map((bar) => (
        <div key={bar.label} className={styles.barRow}>
          <span className={styles.barLabel}>{bar.label}</span>
          <span className={styles.barTrack}>
            <span className={styles.barFill} style={{ width: `${(bar.value / maxValue) * 100}%` }} />
          </span>
          <span className={styles.barValue}>
            {bar.value}
            {spec.unit ? ` ${spec.unit}` : ''}
          </span>
        </div>
      ))}
    </div>
  );
}
