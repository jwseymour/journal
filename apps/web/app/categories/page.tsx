'use client';

import { useEffect, useState } from 'react';
import type { CategoriesResponse, CategorySuggestion, StructureType } from '@journal/contract';
import {
  ApiRequestError,
  approveCategory,
  approveSuggestion,
  listCategories,
  listSuggestions,
  rejectSuggestion,
} from '@/lib/api';
import styles from './page.module.css';

const STRUCTURE_TYPES: { value: StructureType; label: string }[] = [
  { value: 'metric', label: 'Metric' },
  { value: 'review_medium', label: 'Review medium' },
  { value: 'list_type', label: 'List type' },
  { value: 'opinion_subject', label: 'Opinion subject' },
];

const STRUCTURE_LABEL: Record<StructureType, string> = {
  metric: 'Metric',
  review_medium: 'Review medium',
  list_type: 'List type',
  opinion_subject: 'Opinion subject',
};

/**
 * The approved category set the AI is allowed to extract against, and its
 * one growth mechanism: the AI suggesting a new one for approval, or a
 * direct request (`plan.md` M8, `requirements.md` §5.3 — "the AI does not
 * autonomously create new metrics"). Every suggestion names the entry that
 * prompted it, so the reasoning can be checked against the actual prose
 * before deciding.
 */
export default function CategoriesPage() {
  const [categories, setCategories] = useState<CategoriesResponse | null>(null);
  const [suggestions, setSuggestions] = useState<CategorySuggestion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [requestType, setRequestType] = useState<StructureType>('metric');
  const [requestName, setRequestName] = useState('');
  const [requesting, setRequesting] = useState(false);

  const load = () => {
    Promise.all([listCategories(), listSuggestions({ status: 'pending' })])
      .then(([categoriesResponse, suggestionsResponse]) => {
        setCategories(categoriesResponse);
        setSuggestions(suggestionsResponse.suggestions);
      })
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not load categories.'));
  };

  useEffect(load, []);

  const decide = (id: string, decision: 'approve' | 'reject') => {
    setDecidingId(id);
    (decision === 'approve' ? approveSuggestion(id) : rejectSuggestion(id))
      .then(() => {
        setSuggestions((current) => current?.filter((s) => s.id !== id) ?? current);
        if (decision === 'approve') load(); // the newly-approved name now belongs in the approved list too
      })
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not decide.'))
      .finally(() => setDecidingId(null));
  };

  const requestCategory = () => {
    const name = requestName.trim();
    if (!name) return;
    setRequesting(true);
    approveCategory(requestType, name)
      .then(() => {
        setRequestName('');
        load();
      })
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not add category.'))
      .finally(() => setRequesting(false));
  };

  if (error) return <p className={styles.error}>{error}</p>;
  if (categories === null || suggestions === null) return <p className={styles.hint}>Loading…</p>;

  return (
    <div>
      <section className={styles.section}>
        <h2 className={styles.heading}>Approved</h2>
        {STRUCTURE_TYPES.map(({ value, label }) => (
          <div key={value} className={styles.approvedGroup}>
            <p className={styles.heading}>{label}</p>
            {categories[value].length === 0 ? (
              <p className={styles.empty}>None yet.</p>
            ) : (
              <ul className={styles.approvedList}>
                {categories[value].map((name) => (
                  <li key={name} className={styles.pill}>
                    {name}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}

        <div className={styles.requestForm}>
          <select
            className={styles.select}
            value={requestType}
            onChange={(event) => setRequestType(event.target.value as StructureType)}
            aria-label="Category kind"
          >
            {STRUCTURE_TYPES.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <input
            className={styles.input}
            type="text"
            placeholder="Add a category directly"
            value={requestName}
            onChange={(event) => setRequestName(event.target.value)}
            aria-label="New category name"
          />
          <button type="button" className={styles.addButton} onClick={requestCategory} disabled={requesting || !requestName.trim()}>
            Add
          </button>
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.heading}>Suggested by the AI</h2>
        {suggestions.length === 0 ? (
          <p className={styles.empty}>Nothing pending.</p>
        ) : (
          <ul className={styles.suggestionList}>
            {suggestions.map((suggestion) => (
              <li key={suggestion.id} className={styles.suggestionRow}>
                <div className={styles.suggestionMain}>
                  <span className={styles.suggestionMeta}>{STRUCTURE_LABEL[suggestion.structureType]}</span>
                  <span className={styles.suggestionName}>{suggestion.name}</span>
                  <span className={styles.suggestionReason}>{suggestion.reason}</span>
                </div>
                <div className={styles.actions}>
                  <button
                    type="button"
                    className={styles.approveButton}
                    onClick={() => decide(suggestion.id, 'approve')}
                    disabled={decidingId === suggestion.id}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className={styles.rejectButton}
                    onClick={() => decide(suggestion.id, 'reject')}
                    disabled={decidingId === suggestion.id}
                  >
                    Reject
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
