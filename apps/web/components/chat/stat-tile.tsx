import type { StatTileChartSpec } from '@journal/contract';
import styles from './chat.module.css';

/** One number, plain — no colour-as-judgement (`design.md` §5.3): the
 * accent colour is reserved for what already carries the accent elsewhere
 * (a rating, a filled sparkline day), not applied here just to decorate a
 * number. */
export function StatTile({ spec }: { spec: StatTileChartSpec }) {
  return (
    <div className={styles.statTile}>
      <span className={styles.statValue}>
        {spec.value}
        {spec.unit ? ` ${spec.unit}` : ''}
      </span>
      <span className={styles.statLabel}>{spec.label}</span>
    </div>
  );
}
