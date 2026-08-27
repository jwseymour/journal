'use client';

import { useEffect, useState } from 'react';
import type { CategoriesResponse, PublishQueueItem, VisibilityDefault, VisibilityStructureType } from '@journal/contract';
import {
  ApiRequestError,
  listCategories,
  listPublishQueue,
  listVisibilityDefaults,
  publishListItem,
  publishMetric,
  publishOpinionStatement,
  publishReview,
  setVisibilityDefault,
} from '@/lib/api';
import styles from './page.module.css';

const STRUCTURE_TYPES: { value: VisibilityStructureType; label: string }[] = [
  { value: 'metric', label: 'Metric' },
  { value: 'review_medium', label: 'Review medium' },
  { value: 'list_type', label: 'List type' },
  { value: 'opinion_subject', label: 'Opinion subject' },
];

const PUBLISH_BY_TYPE: Record<VisibilityStructureType, (id: string) => Promise<void>> = {
  metric: publishMetric,
  review_medium: publishReview,
  list_type: publishListItem,
  opinion_subject: publishOpinionStatement,
};

/**
 * Visibility beyond documents (`requirements.md` §11, `plan.md` M16) — one
 * default per category ("these are public by default"), and the resulting
 * queue of records that default covers but that have not actually been
 * published yet. Setting a default never publishes anything by itself: it
 * only changes what shows up below, and every item here still needs its own
 * explicit click. Questions never appear here — they have no category, and
 * are published one at a time from their own page.
 */
export default function PublishQueuePage() {
  const [categories, setCategories] = useState<CategoriesResponse | null>(null);
  const [defaults, setDefaults] = useState<VisibilityDefault[] | null>(null);
  const [queue, setQueue] = useState<PublishQueueItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const load = () => {
    Promise.all([listCategories(), listVisibilityDefaults(), listPublishQueue()])
      .then(([categoriesResponse, defaultsResponse, queueResponse]) => {
        setCategories(categoriesResponse);
        setDefaults(defaultsResponse.defaults);
        setQueue(queueResponse.items);
      })
      .catch((cause: unknown) =>
        setError(cause instanceof ApiRequestError ? cause.message : 'Could not load visibility settings.'),
      );
  };

  useEffect(load, []);

  const isDefaultPublic = (structureType: VisibilityStructureType, category: string): boolean =>
    defaults?.some((d) => d.structureType === structureType && d.category === category && d.defaultPublic) ?? false;

  const toggleDefault = (structureType: VisibilityStructureType, category: string) => {
    const key = `${structureType}:${category}`;
    const next = !isDefaultPublic(structureType, category);
    setBusyKey(key);
    setVisibilityDefault(structureType, category, next)
      .then(() => {
        setDefaults((current) => {
          const rest = (current ?? []).filter((d) => !(d.structureType === structureType && d.category === category));
          return [...rest, { structureType, category, defaultPublic: next }];
        });
        listPublishQueue()
          .then((response) => setQueue(response.items))
          .catch(() => {
            /* the toggle itself already succeeded; a stale queue self-corrects on next load */
          });
      })
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not update.'))
      .finally(() => setBusyKey(null));
  };

  const publishItem = (item: PublishQueueItem) => {
    setBusyKey(item.id);
    PUBLISH_BY_TYPE[item.structureType](item.id)
      .then(() => setQueue((current) => current?.filter((i) => i.id !== item.id) ?? current))
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not publish.'))
      .finally(() => setBusyKey(null));
  };

  if (error) return <p className={styles.error}>{error}</p>;
  if (categories === null || defaults === null || queue === null) return <p className={styles.hint}>Loading…</p>;

  return (
    <div>
      <section className={styles.section}>
        <h2 className={styles.heading}>Public by default</h2>
        <p className={styles.hint}>
          Marking a category public by default never publishes anything on its own — it only adds its records below,
          ready for a one-click confirmation each.
        </p>
        {STRUCTURE_TYPES.map(({ value, label }) => (
          <div key={value} className={styles.group}>
            <p className={styles.heading}>{label}</p>
            {categories[value].length === 0 ? (
              <p className={styles.empty}>No approved categories yet.</p>
            ) : (
              <ul className={styles.toggleList}>
                {categories[value].map((category) => (
                  <li key={category} className={styles.toggleRow}>
                    <span>{category}</span>
                    <button
                      type="button"
                      className={styles.toggleButton}
                      onClick={() => toggleDefault(value, category)}
                      disabled={busyKey === `${value}:${category}`}
                    >
                      {isDefaultPublic(value, category) ? 'Public by default' : 'Private by default'}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </section>

      <section className={styles.section}>
        <h2 className={styles.heading}>Ready to publish</h2>
        {queue.length === 0 ? (
          <p className={styles.empty}>Nothing waiting.</p>
        ) : (
          <ul className={styles.queueList}>
            {queue.map((item) => (
              <li key={`${item.structureType}:${item.id}`} className={styles.queueRow}>
                <div className={styles.queueMain}>
                  <span className={styles.queueMeta}>
                    {STRUCTURE_TYPES.find((t) => t.value === item.structureType)?.label ?? item.structureType} ·{' '}
                    {item.category}
                  </span>
                  <span className={styles.queuePreview}>{item.preview}</span>
                </div>
                <button
                  type="button"
                  className={styles.approveButton}
                  onClick={() => publishItem(item)}
                  disabled={busyKey === item.id}
                >
                  Publish
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
