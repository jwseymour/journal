import Link from 'next/link';
import type { TableChartSpec } from '@journal/contract';
import styles from './chat.module.css';

/** The same hairline-rule table pattern as `analysis/page.tsx` — no
 * gridlines, no shading. A row with a source entry gets a trailing link
 * back to it, the traceability `requirements.md` §3 asks for. */
export function DataTable({ spec }: { spec: TableChartSpec }) {
  return (
    <div>
      <p className={styles.chartTitle}>{spec.title}</p>
      <table className={styles.table}>
        <thead>
          <tr>
            {spec.columns.map((column) => (
              <th key={column.key}>{column.label}</th>
            ))}
            <th />
          </tr>
        </thead>
        <tbody>
          {spec.rows.map((row, index) => (
            <tr key={index}>
              {spec.columns.map((column) => (
                <td key={column.key}>{row.values[column.key] ?? '—'}</td>
              ))}
              <td className={styles.rowLink}>
                {row.entryId && (
                  <Link href={`/entry/${row.entryId}`} title="View entry">
                    →
                  </Link>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
