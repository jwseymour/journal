'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { MetricFieldDefinition, MetricUpdateSuggestion, TemporalMetric } from '@journal/contract';
import { formatDate, formatTime } from '@/lib/format';
import {
  ApiRequestError,
  approveMetricUpdateSuggestion,
  deleteMetric,
  listMetricFields,
  listMetrics,
  listMetricUpdateSuggestions,
  publishMetric,
  rejectMetricUpdateSuggestion,
  untouchMetric,
  unpublishMetric,
  updateMetric,
  validateMetric,
} from '@/lib/api';
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
 *
 * Structured field values (`plan.md` M9) render alongside `detail`, using
 * the field definitions' own labels and units — a display lookup, not a
 * computation; the values themselves are exactly what the last reprocess
 * wrote.
 *
 * Editing and validating (`requirements.md` §2, §6.4, `plan.md` M10): a
 * record the user reviews or corrects becomes touched, and is never
 * silently overwritten by a later reprocess. Editing here is scoped to
 * `detail`, the free-text summary — `fields` and `eventTime` corrections
 * are not yet surfaced in this UI.
 */
export default function MetricsPage() {
  const [metrics, setMetrics] = useState<TemporalMetric[] | null>(null);
  const [fields, setFields] = useState<MetricFieldDefinition[] | null>(null);
  const [suggestions, setSuggestions] = useState<MetricUpdateSuggestion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const load = () => {
    Promise.all([listMetrics({ limit: LIMIT }), listMetricFields(), listMetricUpdateSuggestions('pending')])
      .then(([metricsResponse, fieldsResponse, suggestionsResponse]) => {
        setMetrics(metricsResponse.metrics);
        setFields(fieldsResponse.fields);
        setSuggestions(suggestionsResponse.suggestions);
      })
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not load metrics.'));
  };

  useEffect(load, []);

  const discard = (id: string) => {
    setRemovingId(id);
    deleteMetric(id)
      .then(() => setMetrics((current) => current?.filter((m) => m.id !== id) ?? current))
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not discard.'))
      .finally(() => setRemovingId(null));
  };

  const toggleTouched = (metric: TemporalMetric) => {
    setBusyId(metric.id);
    (metric.touched ? untouchMetric(metric.id) : validateMetric(metric.id))
      .then(() =>
        setMetrics(
          (current) => current?.map((m) => (m.id === metric.id ? { ...m, touched: !metric.touched } : m)) ?? current,
        ),
      )
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not update.'))
      .finally(() => setBusyId(null));
  };

  const togglePublished = (metric: TemporalMetric) => {
    setBusyId(metric.id);
    (metric.published ? unpublishMetric(metric.id) : publishMetric(metric.id))
      .then(() =>
        setMetrics(
          (current) =>
            current?.map((m) => (m.id === metric.id ? { ...m, published: !metric.published } : m)) ?? current,
        ),
      )
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not update.'))
      .finally(() => setBusyId(null));
  };

  const startEdit = (metric: TemporalMetric) => {
    setEditingId(metric.id);
    setDraft(metric.detail);
  };

  const saveEdit = (id: string) => {
    setBusyId(id);
    updateMetric(id, { detail: draft })
      .then(() => {
        setMetrics((current) => current?.map((m) => (m.id === id ? { ...m, detail: draft, touched: true } : m)) ?? current);
        setEditingId(null);
      })
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not save.'))
      .finally(() => setBusyId(null));
  };

  const decideSuggestion = (id: string, decision: 'approve' | 'reject') => {
    setBusyId(id);
    (decision === 'approve' ? approveMetricUpdateSuggestion(id) : rejectMetricUpdateSuggestion(id))
      .then(() => {
        setSuggestions((current) => current?.filter((s) => s.id !== id) ?? current);
        if (decision === 'approve') load(); // the record itself changed too
      })
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not decide.'))
      .finally(() => setBusyId(null));
  };

  if (error) return <p className={styles.error}>{error}</p>;
  if (metrics === null || fields === null || suggestions === null) return <p className={styles.hint}>Loading…</p>;

  const fieldValues = (metric: TemporalMetric): string[] => {
    return Object.entries(metric.fields)
      .filter(([, value]) => value !== null)
      .map(([fieldKey, value]) => {
        const definition = fields.find((f) => f.metric === metric.metric && f.fieldKey === fieldKey);
        const label = definition?.label ?? fieldKey;
        const unit = definition?.unit;
        return unit ? `${label}: ${value} ${unit}` : `${label}: ${value}`;
      });
  };

  return (
    <div>
      {suggestions.length > 0 && (
        <section className={styles.suggestions}>
          <p className={styles.heading}>Reprocessing found changes to records you've reviewed</p>
          <ul className={styles.suggestionList}>
            {suggestions.map((suggestion) => (
              <li key={suggestion.id} className={styles.suggestionRow}>
                <div className={styles.suggestionMain}>
                  <span className={styles.suggestionReason}>{suggestion.reason}</span>
                  <span className={styles.suggestionProposed}>Would become: {suggestion.detail}</span>
                </div>
                <div className={styles.actions}>
                  <button
                    type="button"
                    className={styles.approveButton}
                    onClick={() => decideSuggestion(suggestion.id, 'approve')}
                    disabled={busyId === suggestion.id}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className={styles.rejectButton}
                    onClick={() => decideSuggestion(suggestion.id, 'reject')}
                    disabled={busyId === suggestion.id}
                  >
                    Keep mine
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {metrics.length === 0 ? (
        <p className={styles.empty}>
          Nothing extracted yet. Run <code>npm run reprocess</code> with <code>AI_GATEWAY_API_KEY</code>{' '}
          configured.
        </p>
      ) : (
        <ol className={styles.list}>
          {metrics.map((metric) => (
            <li key={metric.id} className={styles.row}>
              <div className={styles.main}>
                <span className={styles.when}>
                  <time dateTime={metric.eventTime}>{formatDate(metric.eventTime)}</time>
                  <span>{formatTime(metric.eventTime)}</span>
                  {!metric.eventTimeExplicit && <span>(from the entry’s own time)</span>}
                  {metric.touched && <span className={styles.touched}>touched</span>}
                  {metric.published && <span className={styles.published}>published</span>}
                </span>
                <span className={styles.metric}>{metric.metric}</span>
                {editingId === metric.id ? (
                  <div className={styles.editForm}>
                    <textarea
                      className={styles.textarea}
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      aria-label="Detail"
                    />
                    <div className={styles.actions}>
                      <button
                        type="button"
                        className={styles.approveButton}
                        onClick={() => saveEdit(metric.id)}
                        disabled={busyId === metric.id}
                      >
                        Save
                      </button>
                      <button type="button" className={styles.rejectButton} onClick={() => setEditingId(null)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    {metric.detail && <span className={styles.detail}>{metric.detail}</span>}
                    {fieldValues(metric).length > 0 && (
                      <span className={styles.fields}>{fieldValues(metric).join(' · ')}</span>
                    )}
                  </>
                )}
                <Link href={`/entry/${metric.entryId}`} className={styles.link}>
                  Source entry
                </Link>
              </div>
              {editingId !== metric.id && (
                <div className={styles.rowActions}>
                  <button type="button" className={styles.editButton} onClick={() => startEdit(metric)}>
                    Edit
                  </button>
                  <button
                    type="button"
                    className={styles.editButton}
                    onClick={() => toggleTouched(metric)}
                    disabled={busyId === metric.id}
                  >
                    {metric.touched ? 'Untouch' : 'Validate'}
                  </button>
                  <button
                    type="button"
                    className={styles.editButton}
                    onClick={() => togglePublished(metric)}
                    disabled={busyId === metric.id}
                  >
                    {metric.published ? 'Unpublish' : 'Publish'}
                  </button>
                  <button
                    type="button"
                    className={styles.discard}
                    onClick={() => discard(metric.id)}
                    disabled={removingId === metric.id}
                  >
                    Discard
                  </button>
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
