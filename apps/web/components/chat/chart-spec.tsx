import type { ChartSpec } from '@journal/contract';
import { BarComparisonChart } from './bar-comparison-chart';
import { DataTable } from './data-table';
import { SparklineChart } from './sparkline-chart';
import { StatTile } from './stat-tile';

/**
 * The one dispatch point for the fixed chart vocabulary the chat feature's
 * model may choose from — never model-generated layout, only a pick from
 * this union filled with real data the backend already computed
 * (`requirements.md` §7.1). The `default` case exists purely so `tsc`
 * catches a future `ChartSpec` variant left unhandled here.
 */
export function ChartSpecView({ spec }: { spec: ChartSpec }) {
  switch (spec.type) {
    case 'sparkline':
      return <SparklineChart spec={spec} />;
    case 'bar_comparison':
      return <BarComparisonChart spec={spec} />;
    case 'stat_tile':
      return <StatTile spec={spec} />;
    case 'table':
      return <DataTable spec={spec} />;
    default:
      spec satisfies never;
      return null;
  }
}
