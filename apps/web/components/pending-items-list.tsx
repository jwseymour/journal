'use client';

import type { ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CategorySuggestion,
  MetricFieldSuggestion,
  PendingExtractionItem,
  PendingItemKind,
  PendingItemStructureType,
  VisibilityDefault,
} from '@journal/contract';
import {
  ApiRequestError,
  approveMetricFieldSuggestion,
  approvePendingItem,
  approvePendingItemsBatch,
  approveSuggestion,
  listMetricFieldSuggestions,
  listPendingItems,
  listSuggestions,
  listVisibilityDefaults,
  parkMetricFieldSuggestion,
  parkSuggestion,
  rejectMetricFieldSuggestion,
  rejectPendingItem,
  rejectSuggestion,
} from '@/lib/api';
import { formatDate, formatTime } from '@/lib/format';
import { useGlobalKey } from '@/lib/keyboard';
import { CONFIDENCE_ORDER, PENDING_STRUCTURE_LABEL, pendingStructureTypeToVisibilityType } from '@/lib/structure-types';
import styles from './pending-items-list.module.css';

const STRUCTURE_ORDER: PendingItemStructureType[] = [
  'metric',
  'review',
  'list_item',
  'opinion_statement',
  'question',
  'todo',
];

const KIND_LABEL: Record<PendingItemKind, string | null> = {
  new: null, // the common case — no badge needed for what's simply new
  update: 'Update',
  resolution: 'Resolves',
  completion: 'Completes',
};

/** A short, type-appropriate summary of what an item would commit, read
 * straight out of its `payload` — see `pending-item-applier.ts` for the
 * exact shape each `(structureType, kind)` pair carries. */
function summarize(item: PendingExtractionItem): { headline: string; meta: string[] } {
  const payload = item.payload;
  switch (item.structureType) {
    case 'metric': {
      const fields = (payload.fields ?? {}) as Record<string, string | number | null>;
      const fieldMeta = Object.entries(fields)
        .filter(([, value]) => value !== null && value !== undefined)
        .map(([key, value]) => `${key}: ${value}`);
      return { headline: String(payload.detail ?? item.category ?? ''), meta: fieldMeta };
    }
    case 'review': {
      const meta: string[] = [];
      if (payload.rating !== null && payload.rating !== undefined) meta.push(`Rating ${String(payload.rating)}`);
      if (payload.progress !== null && payload.progress !== undefined) meta.push(`Progress ${String(payload.progress)}`);
      if (payload.opinion) meta.push(String(payload.opinion));
      return { headline: String(payload.title ?? ''), meta };
    }
    case 'list_item': {
      const meta: string[] = [];
      if (payload.context) meta.push(String(payload.context));
      if (payload.importance !== null && payload.importance !== undefined) meta.push(`Importance ${String(payload.importance)}`);
      return { headline: String(payload.text ?? ''), meta };
    }
    case 'opinion_statement':
      return { headline: String(payload.statement ?? ''), meta: [] };
    case 'question':
      return item.kind === 'resolution'
        ? { headline: String(payload.resolution ?? ''), meta: [] }
        : { headline: String(payload.question ?? ''), meta: [] };
    case 'todo':
      return item.kind === 'completion'
        ? { headline: String(payload.resolution ?? ''), meta: [] }
        : { headline: String(payload.text ?? ''), meta: [] };
  }
}

/** `payload.eventTime` when this candidate carries one — a resolution or
 * completion payload has no `eventTime` of its own (it dates from the
 * question/todo it resolves), so this is `null` for those two kinds. */
function extractEventTime(item: PendingExtractionItem): string | null {
  const value = item.payload.eventTime;
  return typeof value === 'string' ? value : null;
}

function visibilityLabel(
  structureType: PendingItemStructureType,
  category: string | null,
  defaults: VisibilityDefault[],
): string | null {
  const visibilityType = pendingStructureTypeToVisibilityType(structureType);
  if (!visibilityType || !category) return null;
  const setting = defaults.find((d) => d.structureType === visibilityType && d.category === category);
  // No setting on file defaults to private (`plan.md` M16's own default), same
  // as every existing per-type page already assumes.
  return setting?.defaultPublic ? 'Public by default' : 'Private by default';
}

/**
 * One row of the review list, collapsed to a single truncated line by
 * default — a click anywhere on the row's text (or `↩` on the keyboard-
 * focused row) toggles `details` open below it. The chevron is the
 * affordance: every row carries one, because every row now always has
 * something to show underneath — at minimum its own untruncated text, so
 * expanding is never a dead end. `focused` marks the row the keyboard
 * scheme (`j`/`k`) is currently on, reusing the same inset-accent treatment
 * `home-browser.tsx` uses for its own list selection.
 */
function DisclosureRow({
  rowRef,
  focused,
  expanded,
  onToggle,
  meta,
  headline,
  details,
  actions,
}: {
  rowRef: (el: HTMLLIElement | null) => void;
  focused: boolean;
  expanded: boolean;
  onToggle: () => void;
  meta: ReactNode;
  headline: string;
  details: ReactNode;
  actions: ReactNode;
}) {
  return (
    <li ref={rowRef} className={focused ? `${styles.row} ${styles.focused}` : styles.row}>
      <div className={styles.rowTop}>
        <button type="button" className={styles.rowToggle} onClick={onToggle} aria-expanded={expanded}>
          <span className={styles.rowMeta}>{meta}</span>
          <span className={styles.headline}>{headline}</span>
          <span className={styles.chevron} aria-hidden="true">
            {expanded ? '▾' : '▸'}
          </span>
        </button>
        <div className={styles.actions}>{actions}</div>
      </div>
      {expanded && <div className={styles.expanded}>{details}</div>}
    </li>
  );
}

export interface PendingItemsListProps {
  /** Scope to one entry (the post-Process popup); omit for the unscoped
   * fallback queue (`/pending`), which shows every still-pending item. */
  entryId?: string;
  /** Called after any decision actually changes what's pending, so a caller
   * showing a count elsewhere (the entry's own status indicator) can refresh. */
  onDecided?: () => void;
}

interface FlatRow {
  id: string;
  approve: () => void;
  reject: () => void;
  park?: () => void;
}

/**
 * The shared review surface behind both the post-Process popup and the
 * unscoped `/pending` fallback queue (`plan.md` M18) — one component so the
 * two can never render a pending item two different ways. Dense and
 * batchable by design: everything of one structure type is grouped under a
 * single "Approve all" action, confidence only decides ordering within a
 * group, and new-type suggestions (a new category, metric field, or enum
 * value) sit in their own section with a third action, park, alongside
 * approve/reject.
 *
 * Also readable and decidable without a mouse: every row in render order —
 * across every group and the suggestions section — is one sequence `j`/`k`
 * moves through, `↩` opens for the full text and detail, and `a`/`r`/`p`
 * decide (`design.md` §5.2's existing "outside a text field" scheme,
 * extended rather than replaced). Deciding a row removes it, and the
 * keyboard focus lands on whatever slid into its place, so working the
 * queue is a straight line: `↩` to look, a decision key, repeat.
 */
export function PendingItemsList({ entryId, onDecided }: PendingItemsListProps) {
  const [items, setItems] = useState<PendingExtractionItem[] | null>(null);
  const [categorySuggestions, setCategorySuggestions] = useState<CategorySuggestion[] | null>(null);
  const [fieldSuggestions, setFieldSuggestions] = useState<MetricFieldSuggestion[] | null>(null);
  const [visibilityDefaults, setVisibilityDefaults] = useState<VisibilityDefault[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [busyGroup, setBusyGroup] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [focusedIndex, setFocusedIndex] = useState(0);

  const rowRefs = useRef(new Map<string, HTMLLIElement>());

  const toggleExpanded = (id: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const load = useCallback(() => {
    Promise.all([
      listPendingItems({ status: 'pending', ...(entryId ? { entryId } : {}) }),
      listSuggestions({ status: 'pending' }),
      listMetricFieldSuggestions({ status: 'pending' }),
      listVisibilityDefaults(),
    ])
      .then(([pendingResponse, suggestionsResponse, fieldSuggestionsResponse, visibilityResponse]) => {
        setItems(pendingResponse.items);
        // These two suggestion streams have no server-side entry filter (they
        // predate M18's per-entry popup) — filtered here, client-side, the
        // same way the popup scopes everything else to one entry.
        setCategorySuggestions(
          entryId ? suggestionsResponse.suggestions.filter((s) => s.entryId === entryId) : suggestionsResponse.suggestions,
        );
        setFieldSuggestions(
          entryId
            ? fieldSuggestionsResponse.suggestions.filter((s) => s.entryId === entryId)
            : fieldSuggestionsResponse.suggestions,
        );
        setVisibilityDefaults(visibilityResponse.defaults);
      })
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not load pending items.'));
  }, [entryId]);

  useEffect(load, [load]);

  const decideItem = (id: string, decision: 'approve' | 'reject') => {
    if (busyId === id) return;
    setBusyId(id);
    (decision === 'approve' ? approvePendingItem(id) : rejectPendingItem(id))
      .then(() => {
        setItems((current) => current?.filter((item) => item.id !== id) ?? current);
        onDecided?.();
      })
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not decide.'))
      .finally(() => setBusyId(null));
  };

  const approveGroup = (structureType: PendingItemStructureType, ids: string[]) => {
    setBusyGroup(structureType);
    approvePendingItemsBatch(ids)
      .then((result) => {
        const approvedIds = new Set(result.approved);
        setItems((current) => current?.filter((item) => !approvedIds.has(item.id)) ?? current);
        if (result.failed.length > 0) {
          setError(`${result.failed.length} of ${ids.length} could not be approved: ${result.failed[0]!.error}`);
        }
        onDecided?.();
      })
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not approve the batch.'))
      .finally(() => setBusyGroup(null));
  };

  const decideCategorySuggestion = (id: string, decision: 'approve' | 'reject' | 'park') => {
    if (busyId === id) return;
    setBusyId(id);
    (decision === 'approve' ? approveSuggestion(id) : decision === 'reject' ? rejectSuggestion(id) : parkSuggestion(id))
      .then(() => {
        setCategorySuggestions((current) => current?.filter((s) => s.id !== id) ?? current);
        onDecided?.();
      })
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not decide.'))
      .finally(() => setBusyId(null));
  };

  const decideFieldSuggestion = (id: string, decision: 'approve' | 'reject' | 'park') => {
    if (busyId === id) return;
    setBusyId(id);
    (decision === 'approve'
      ? approveMetricFieldSuggestion(id)
      : decision === 'reject'
        ? rejectMetricFieldSuggestion(id)
        : parkMetricFieldSuggestion(id)
    )
      .then(() => {
        setFieldSuggestions((current) => current?.filter((s) => s.id !== id) ?? current);
        onDecided?.();
      })
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not decide.'))
      .finally(() => setBusyId(null));
  };

  // Derived from `items`/etc. rather than gated behind the loading check
  // below, so every hook past this point (the keyboard registrations, the
  // scroll effect) runs unconditionally on every render — the loading
  // return has to come after all of them.
  const safeItems = items ?? [];
  const safeCategorySuggestions = categorySuggestions ?? [];
  const safeFieldSuggestions = fieldSuggestions ?? [];

  const groups = STRUCTURE_ORDER.map((structureType) => ({
    structureType,
    items: safeItems
      .filter((item) => item.structureType === structureType)
      .sort((a, b) => CONFIDENCE_ORDER[a.confidence] - CONFIDENCE_ORDER[b.confidence]),
  })).filter((group) => group.items.length > 0);

  const nothingPending = groups.length === 0 && safeCategorySuggestions.length === 0 && safeFieldSuggestions.length === 0;

  // Render order is review order: every group in `STRUCTURE_ORDER`, then the
  // suggestions section — the exact sequence `j`/`k` walks and the exact
  // sequence the JSX below renders in, so the two can never disagree about
  // "what comes next."
  const flatOrder: FlatRow[] = [
    ...groups.flatMap((group) =>
      group.items.map((item) => ({
        id: item.id,
        approve: () => decideItem(item.id, 'approve'),
        reject: () => decideItem(item.id, 'reject'),
      })),
    ),
    ...safeCategorySuggestions.map((suggestion) => ({
      id: suggestion.id,
      approve: () => decideCategorySuggestion(suggestion.id, 'approve'),
      reject: () => decideCategorySuggestion(suggestion.id, 'reject'),
      park: () => decideCategorySuggestion(suggestion.id, 'park'),
    })),
    ...safeFieldSuggestions.map((suggestion) => ({
      id: suggestion.id,
      approve: () => decideFieldSuggestion(suggestion.id, 'approve'),
      reject: () => decideFieldSuggestion(suggestion.id, 'reject'),
      park: () => decideFieldSuggestion(suggestion.id, 'park'),
    })),
  ];

  // Re-clamped from the raw `focusedIndex` on every render rather than kept
  // clamped in state: deciding a row shrinks `flatOrder` out from under
  // whatever index was focused, and this is what makes the item that slides
  // into that slot the next one focused, with no separate effect needed to
  // notice the shrink.
  const clampedIndex = flatOrder.length === 0 ? -1 : Math.min(Math.max(focusedIndex, 0), flatOrder.length - 1);
  const focusedRow = clampedIndex >= 0 ? flatOrder[clampedIndex]! : null;
  const focusedId = focusedRow?.id ?? null;

  const focusAndToggle = (id: string) => {
    const index = flatOrder.findIndex((row) => row.id === id);
    if (index >= 0) setFocusedIndex(index);
    toggleExpanded(id);
  };

  useGlobalKey('j', () => setFocusedIndex(clampedIndex + 1));
  useGlobalKey('k', () => setFocusedIndex(clampedIndex - 1));
  useGlobalKey('Enter', () => {
    if (focusedId) toggleExpanded(focusedId);
  });
  useGlobalKey('a', () => focusedRow?.approve());
  useGlobalKey('r', () => focusedRow?.reject());
  useGlobalKey('p', () => focusedRow?.park?.());

  useEffect(() => {
    if (!focusedId) return;
    rowRefs.current.get(focusedId)?.scrollIntoView({ block: 'nearest' });
  }, [focusedId]);

  if (items === null || categorySuggestions === null || fieldSuggestions === null) {
    return <p className={styles.hint}>Loading…</p>;
  }

  return (
    <div className={styles.list}>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      {nothingPending && <p className={styles.empty}>Nothing pending.</p>}

      {!nothingPending && (
        <div className={styles.hints}>
          <kbd className={styles.keyHint}>j k move</kbd>
          <kbd className={styles.keyHint}>↩ more info</kbd>
          <kbd className={styles.keyHint}>a approve</kbd>
          <kbd className={styles.keyHint}>r reject</kbd>
          {(safeCategorySuggestions.length > 0 || safeFieldSuggestions.length > 0) && (
            <kbd className={styles.keyHint}>p park</kbd>
          )}
        </div>
      )}

      {groups.map((group) => (
        <section key={group.structureType} className={styles.group}>
          <div className={styles.groupHead}>
            <h3 className={styles.groupTitle}>
              {PENDING_STRUCTURE_LABEL[group.structureType]}
              <span className={styles.groupCount}>{group.items.length}</span>
            </h3>
            <button
              type="button"
              className={styles.approveAllButton}
              onClick={() => approveGroup(group.structureType, group.items.map((item) => item.id))}
              disabled={busyGroup === group.structureType}
            >
              Approve all {group.items.length}
            </button>
          </div>
          <ul className={styles.rows}>
            {group.items.map((item) => {
              const { headline, meta } = summarize(item);
              const kindLabel = KIND_LABEL[item.kind];
              const visibility = visibilityLabel(item.structureType, item.category, visibilityDefaults);
              const eventTime = extractEventTime(item);
              const details = (
                <>
                  <p className={styles.fullText}>{headline || '(nothing extracted)'}</p>
                  {eventTime && (
                    <p className={styles.detail}>
                      {formatDate(eventTime)} · {formatTime(eventTime)}
                    </p>
                  )}
                  {meta.length > 0 && <p className={styles.detail}>{meta.join(' · ')}</p>}
                  {item.reason && <p className={styles.reason}>{item.reason}</p>}
                  {visibility && <p className={styles.visibility}>{visibility}</p>}
                </>
              );
              return (
                <DisclosureRow
                  key={item.id}
                  rowRef={(el) => {
                    if (el) rowRefs.current.set(item.id, el);
                    else rowRefs.current.delete(item.id);
                  }}
                  focused={focusedId === item.id}
                  expanded={expandedIds.has(item.id)}
                  onToggle={() => focusAndToggle(item.id)}
                  headline={headline}
                  details={details}
                  meta={
                    <>
                      {kindLabel && <span className={styles.kindBadge}>{kindLabel}</span>}
                      {item.category && <span className={styles.category}>{item.category}</span>}
                      <span className={`${styles.confidence} ${styles[`confidence-${item.confidence}`]}`}>
                        {item.confidence}
                      </span>
                    </>
                  }
                  actions={
                    <>
                      <button
                        type="button"
                        className={styles.approveButton}
                        onClick={() => decideItem(item.id, 'approve')}
                        disabled={busyId === item.id}
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        className={styles.rejectButton}
                        onClick={() => decideItem(item.id, 'reject')}
                        disabled={busyId === item.id}
                      >
                        Reject
                      </button>
                    </>
                  }
                />
              );
            })}
          </ul>
        </section>
      ))}

      {(safeCategorySuggestions.length > 0 || safeFieldSuggestions.length > 0) && (
        <section className={styles.group}>
          <div className={styles.groupHead}>
            <h3 className={styles.groupTitle}>New types suggested</h3>
          </div>
          <ul className={styles.rows}>
            {safeCategorySuggestions.map((suggestion) => (
              <DisclosureRow
                key={suggestion.id}
                rowRef={(el) => {
                  if (el) rowRefs.current.set(suggestion.id, el);
                  else rowRefs.current.delete(suggestion.id);
                }}
                focused={focusedId === suggestion.id}
                expanded={expandedIds.has(suggestion.id)}
                onToggle={() => focusAndToggle(suggestion.id)}
                headline={suggestion.name}
                details={
                  <>
                    <p className={styles.fullText}>{suggestion.name}</p>
                    <p className={styles.reason}>{suggestion.reason}</p>
                  </>
                }
                meta={<span className={styles.category}>{suggestion.structureType}</span>}
                actions={
                  <>
                    <button
                      type="button"
                      className={styles.approveButton}
                      onClick={() => decideCategorySuggestion(suggestion.id, 'approve')}
                      disabled={busyId === suggestion.id}
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      className={styles.parkButton}
                      onClick={() => decideCategorySuggestion(suggestion.id, 'park')}
                      disabled={busyId === suggestion.id}
                    >
                      Park
                    </button>
                    <button
                      type="button"
                      className={styles.rejectButton}
                      onClick={() => decideCategorySuggestion(suggestion.id, 'reject')}
                      disabled={busyId === suggestion.id}
                    >
                      Reject
                    </button>
                  </>
                }
              />
            ))}
            {safeFieldSuggestions.map((suggestion) => (
              <DisclosureRow
                key={suggestion.id}
                rowRef={(el) => {
                  if (el) rowRefs.current.set(suggestion.id, el);
                  else rowRefs.current.delete(suggestion.id);
                }}
                focused={focusedId === suggestion.id}
                expanded={expandedIds.has(suggestion.id)}
                onToggle={() => focusAndToggle(suggestion.id)}
                headline={suggestion.label}
                details={
                  <>
                    <p className={styles.fullText}>{suggestion.label}</p>
                    <p className={styles.detail}>{suggestion.description}</p>
                    {suggestion.unit && <p className={styles.detail}>Unit: {suggestion.unit}</p>}
                    {(suggestion.scoreMin !== null || suggestion.scoreMax !== null) && (
                      <p className={styles.detail}>
                        Range: {suggestion.scoreMin ?? '–'}–{suggestion.scoreMax ?? '–'}
                      </p>
                    )}
                    <p className={styles.reason}>{suggestion.reason}</p>
                  </>
                }
                meta={
                  <span className={styles.category}>
                    {suggestion.metric} · {suggestion.fieldType}
                  </span>
                }
                actions={
                  <>
                    <button
                      type="button"
                      className={styles.approveButton}
                      onClick={() => decideFieldSuggestion(suggestion.id, 'approve')}
                      disabled={busyId === suggestion.id}
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      className={styles.parkButton}
                      onClick={() => decideFieldSuggestion(suggestion.id, 'park')}
                      disabled={busyId === suggestion.id}
                    >
                      Park
                    </button>
                    <button
                      type="button"
                      className={styles.rejectButton}
                      onClick={() => decideFieldSuggestion(suggestion.id, 'reject')}
                      disabled={busyId === suggestion.id}
                    >
                      Reject
                    </button>
                  </>
                }
              />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
