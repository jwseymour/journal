'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { ListTypeSummary, MetricSummary, ReviewMediumSummary } from '@journal/contract';
import { analysisLists, analysisMetrics, analysisReviews, ApiRequestError } from '@/lib/api';
import { formatRating } from '@/lib/format';
import styles from './page.module.css';

interface AnalysisData {
  metrics: MetricSummary[];
  windowDays: number;
  reviews: ReviewMediumSummary[];
  lists: ListTypeSummary[];
}

/**
 * The analysis surface (`plan.md` M8, `design.md` §5.3): the print
 * information-design tradition — statistical yearbooks, almanacs, field
 * guides — rendered in the same cream, ink, and green as everywhere else.
 * No chart junk, no gradients, no drop shadows; small multiples and a
 * sparkline in preference to one large chart.
 *
 * Every number here is already aggregated by the backend
 * (`requirements.md` §7.1) — this page renders `MetricSummary[]` etc.
 * exactly as given, and computes nothing beyond deciding which CSS class a
 * given day falls into.
 */
export default function AnalysisPage() {
  const [data, setData] = useState<AnalysisData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([analysisMetrics(), analysisReviews(), analysisLists()])
      .then(([metricsResponse, reviewsResponse, listsResponse]) => {
        setData({
          metrics: metricsResponse.summaries,
          windowDays: metricsResponse.windowDays,
          reviews: reviewsResponse.summaries,
          lists: listsResponse.summaries,
        });
      })
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not load analysis.'));
  }, []);

  if (error) return <p className={styles.error}>{error}</p>;
  if (data === null) return <p className={styles.hint}>Loading…</p>;

  return (
    <div>
      <section className={styles.section}>
        <div className={styles.headingRow}>
          <h2 className={styles.heading}>Metrics — last {data.windowDays} days</h2>
          <Link href="/metrics" className={styles.seeAll}>
            All metrics →
          </Link>
        </div>
        {data.metrics.length === 0 ? (
          <p className={styles.empty}>No approved metrics yet.</p>
        ) : (
          <div className={styles.tiles}>
            {data.metrics.map((summary) => (
              <div key={summary.metric} className={styles.tile}>
                <div className={styles.tileHeading}>
                  <span className={styles.tileName}>{summary.metric}</span>
                  <span className={styles.tileCount}>{summary.totalCount} total</span>
                </div>
                <div className={styles.sparkline} role="img" aria-label={`${summary.metric}: ${summary.days.filter((d) => d.count > 0).length} of the last ${data.windowDays} days`}>
                  {summary.days.map((day) => (
                    <span
                      key={day.date}
                      className={day.count > 0 ? `${styles.day} ${styles.dayFilled}` : styles.day}
                      title={`${day.date}: ${day.count}`}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className={styles.section}>
        <div className={styles.headingRow}>
          <h2 className={styles.heading}>Reviews</h2>
          <Link href="/reviews" className={styles.seeAll}>
            All reviews →
          </Link>
        </div>
        {data.reviews.length === 0 ? (
          <p className={styles.empty}>No approved review media yet.</p>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Medium</th>
                <th className={styles.numeric}>Count</th>
                <th className={styles.numeric}>Average rating</th>
              </tr>
            </thead>
            <tbody>
              {data.reviews.map((summary) => (
                <tr key={summary.medium}>
                  <td>{summary.medium}</td>
                  <td className={styles.numeric}>{summary.count}</td>
                  <td className={styles.rating}>
                    {summary.averageRating === null ? '—' : formatRating(summary.averageRating)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className={styles.section}>
        <div className={styles.headingRow}>
          <h2 className={styles.heading}>Lists</h2>
          <Link href="/lists" className={styles.seeAll}>
            All list items →
          </Link>
        </div>
        {data.lists.length === 0 ? (
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
              {data.lists.map((summary) => (
                <tr key={summary.listType}>
                  <td>{summary.listType}</td>
                  <td className={styles.numeric}>{summary.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className={styles.section}>
        <div className={styles.headingRow}>
          <h2 className={styles.heading}>Opinions</h2>
          <Link href="/opinions" className={styles.seeAll}>
            All opinions →
          </Link>
        </div>
        <p className={styles.empty}>Views tracked over time, organised by subject.</p>
      </section>

      <section className={styles.section}>
        <Link href="/categories" className={styles.seeAll}>
          Manage categories →
        </Link>
      </section>
    </div>
  );
}
