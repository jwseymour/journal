import Link from 'next/link';
import type { ResolvedLayout, ResolvedPanel } from '@journal/contract';
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
} from '@/components/analysis-charts';
import styles from './resolved-layout.module.css';

/**
 * The analysis surface's one piece of render code (`requirements.md` §7.1,
 * M20). Everything arrives already aggregated and shaped from
 * `POST /analysis/render`; this is a pure `switch` over the closed
 * `ResolvedPanel` vocabulary that dispatches each panel to an unchanged
 * primitive in `analysis-charts.tsx` or to one of the small yearbook-table /
 * feed / breakdown-bar renderers below. No sums, averages, or filters happen
 * here — only the bar/dot geometry the primitives already do for themselves,
 * and date formatting (the same `format.ts` the rest of the frontend uses).
 */
export function ResolvedLayoutView({ layout }: { layout: ResolvedLayout }) {
  return (
    <>
      {layout.sections.map((section) => (
        <section key={section.title} className={styles.section}>
          <h2 className={styles.registerHeading}>{section.title}</h2>
          <div className={styles.panelStack}>
            {section.panels.map((panel, i) => (
              <Panel key={`${panel.view}:${i}`} title={panel.title} seeAllHref={panel.seeAllHref ?? undefined}>
                <PanelBody panel={panel} />
              </Panel>
            ))}
          </div>
        </section>
      ))}
    </>
  );
}

function PanelBody({ panel }: { panel: ResolvedPanel }) {
  switch (panel.view) {
    case 'presence':
      return <CombinedCalendar metrics={panel.metrics} />;
    case 'matrix':
      return <YearMatrix metrics={panel.metrics} />;
    case 'register':
      return <Register rows={panel.rows} />;
    case 'horizon':
      return <Horizon series={panel.series} />;
    case 'breakdown':
      return (
        <div className={styles.wideTiles}>
          {panel.breakdowns.map((b) => (
            <BreakdownBars key={`${b.metric}:${b.numericLabel}:${b.enumLabel}`} breakdown={b} />
          ))}
        </div>
      );
    case 'correlation':
      return (
        <div className={styles.wideTiles}>
          {panel.correlations.map((c) => (
            <ScatterPlot
              key={c.metric}
              title={`${c.metric}: ${c.yLabel} vs ${c.xLabel}`}
              xAxisLabel={c.xLabel}
              yAxisLabel={c.yLabel}
              points={c.points}
            />
          ))}
        </div>
      );
    case 'reviews':
      return panel.tally.length === 0 ? (
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
              {panel.tally.map((s) => (
                <tr key={s.medium}>
                  <td>{s.medium}</td>
                  <td className={styles.numeric}>{s.count}</td>
                  <td className={styles.rating}>{s.averageRating === null ? '—' : formatRating(s.averageRating)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {panel.rows.length > 0 && (
            <div className={styles.registerGap}>
              <ReviewsRegister rows={panel.rows} />
            </div>
          )}
        </>
      );
    case 'rating-distribution':
      return (
        <>
          {!panel.overall.every((b) => b.count === 0) && (
            <RatingHistogram overall={panel.overall} byMedium={panel.byMedium} />
          )}
          {panel.averages.length > 0 && (
            <div className={styles.registerGap}>
              <DotPlot rows={panel.averages} formatValue={(v) => formatRating(v)} />
            </div>
          )}
        </>
      );
    case 'rating-spread':
      return <StripPlot lanes={panel.lanes} />;
    case 'questions':
      return (
        <>
          <StatusBar openLabel="Open" openCount={panel.openCount} closedCount={panel.closedCount} />
          <Feed items={panel.items} />
        </>
      );
    case 'todos':
      return (
        <>
          <StatusBar openLabel="Open" openCount={panel.openCount} closedCount={panel.closedCount} />
          <Feed items={panel.items} />
        </>
      );
    case 'lists':
      return panel.rows.length === 0 ? (
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
            {panel.rows.map((s) => (
              <tr key={s.listType}>
                <td>{s.listType}</td>
                <td className={styles.numeric}>{s.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    case 'concepts':
      return panel.rows.length === 0 ? (
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
            {panel.rows.map((s) => (
              <tr key={s.subject}>
                <td>{s.subject}</td>
                <td className={styles.numeric}>{s.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    case 'aging':
      return (
        <DotPlot
          rows={panel.rows.map((a) => ({
            label: a.label,
            value: a.value,
            ...(a.entryId ? { href: `/entry/${a.entryId}` } : {}),
          }))}
          formatValue={(v) => `${v}d`}
        />
      );
    case 'error':
      return <p className={styles.panelMessage}>{panel.message}</p>;
    default:
      return assertNever(panel);
  }
}

/** A numeric field's total split across a sibling enum field's values — plain
 * horizontal bars. `max` and the sort are bar geometry (the same kind
 * `DotPlot` and `StripPlot` do for themselves); the totals themselves are the
 * backend's. */
function BreakdownBars({
  breakdown,
}: {
  breakdown: Extract<ResolvedPanel, { view: 'breakdown' }>['breakdowns'][number];
}) {
  const max = Math.max(...breakdown.bars.map((bar) => bar.value));
  const sorted = [...breakdown.bars].sort((a, b) => b.value - a.value);
  return (
    <div className={styles.breakdown}>
      <div className={styles.tileHeading}>
        <span className={styles.tileName}>
          {breakdown.numericLabel} by {breakdown.enumLabel}
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
            {breakdown.unit ? ` ${breakdown.unit}` : ''}
          </span>
        </div>
      ))}
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

function assertNever(panel: never): never {
  throw new Error(`Unhandled resolved panel: ${JSON.stringify(panel)}`);
}
