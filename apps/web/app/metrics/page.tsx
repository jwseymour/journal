'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { TemporalMetric } from '@journal/contract';
import { formatDate, formatTime } from '@/lib/format';
import { ApiRequestError, deleteMetric, listMetrics } from '@/lib/api';
import styles from './page.module.css';

const LIMIT = 100;

/**
 * Extracted temporal metrics (`plan.md` M7, `requirements.md` §5.2) — never
 * live, only whatever the last `npm run reprocess` wrote. A plain list, not
 * an analysis surface: charts, small multiples, and the print
 * information-design treatment are `plan.md` M8's job (`design.md` §5.3).
 * This exists so the data extraction M7 built is actually visible, and so
 * a wrong record can be discarded (`requirements.md` §6.2) without a
 * `curl` command.
 */
export default function MetricsPage() {
  const [metrics, setMetrics] = useState<TemporalMetric[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  useEffect(() => {
    listMetrics({ limit: LIMIT })
      .then((response) => setMetrics(response.metrics))
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not load metrics.'));
  }, []);

  const discard = (id: string) => {
    setRemovingId(id);
    deleteMetric(id)
      .then(() => setMetrics((current) => current?.filter((m) => m.id !== id) ?? current))
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not discard.'))
      .finally(() => setRemovingId(null));
  };

  if (error) return <p className={styles.error}>{error}</p>;
  if (metrics === null) return <p className={styles.hint}>Loading…</p>;
  if (metrics.length === 0) {
    return (
      <p className={styles.empty}>
        Nothing extracted yet. Run <code>npm run reprocess</code> with <code>AI_GATEWAY_API_KEY</code>{' '}
        configured.
      </p>
    );
  }

  return (
    <ol className={styles.list}>
      {metrics.map((metric) => (
        <li key={metric.id} className={styles.row}>
          <div className={styles.main}>
            <span className={styles.when}>
              <time dateTime={metric.eventTime}>{formatDate(metric.eventTime)}</time>
              <span>{formatTime(metric.eventTime)}</span>
              {!metric.eventTimeExplicit && <span>(from the entry’s own time)</span>}
            </span>
            <span className={styles.metric}>{metric.metric}</span>
            {metric.detail && <span className={styles.detail}>{metric.detail}</span>}
            <Link href={`/entry/${metric.entryId}`} className={styles.link}>
              Source entry
            </Link>
          </div>
          <button
            type="button"
            className={styles.discard}
            onClick={() => discard(metric.id)}
            disabled={removingId === metric.id}
          >
            Discard
          </button>
        </li>
      ))}
    </ol>
  );
}
