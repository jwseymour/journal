import Link from 'next/link';
import type { ChartSpec } from '@journal/contract';
import { ChartSpecView } from './chart-spec';
import styles from './chat.module.css';

/**
 * One turn of the conversation — plain text, not markdown (a chat answer is
 * a sentence, not a journal body, so `components/markdown.tsx` is not
 * needed here), its charts, and a "Sources" row linking back to whatever
 * entries the answer was grounded in (`requirements.md` §3). No chrome
 * beyond a plain label and a hairline rule — the same restraint
 * `design.md` §4 asks of the rest of the application.
 */
export function MessageTurn({
  role,
  content,
  charts,
  citedEntryIds,
}: {
  role: 'user' | 'assistant';
  content: string;
  charts?: ChartSpec[];
  citedEntryIds?: string[];
}) {
  return (
    <div className={styles.turn}>
      <span className={styles.turnLabel}>{role === 'user' ? 'You' : 'Journal'}</span>
      <p className={styles.turnContent}>{content}</p>

      {charts && charts.length > 0 && (
        <div className={styles.charts}>
          {charts.map((chart, index) => (
            <ChartSpecView key={index} spec={chart} />
          ))}
        </div>
      )}

      {citedEntryIds && citedEntryIds.length > 0 && (
        <p className={styles.sources}>
          Sources:{' '}
          {citedEntryIds.map((entryId, index) => (
            <span key={entryId}>
              {index > 0 && ', '}
              <Link href={`/entry/${entryId}`} className={styles.sourceLink}>
                #{index + 1}
              </Link>
            </span>
          ))}
        </p>
      )}
    </div>
  );
}
