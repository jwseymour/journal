import type { PendingItemConfidence, PendingItemStructureType, VisibilityStructureType } from '@journal/contract';

/**
 * Display labels and cross-vocabulary mapping for `PendingItemStructureType`
 * (`plan.md` M18) — kept in one place so the popup and the fallback queue
 * can never describe the same structure type two different ways.
 */
export const PENDING_STRUCTURE_LABEL: Record<PendingItemStructureType, string> = {
  metric: 'Metric',
  review: 'Review',
  list_item: 'List item',
  opinion_statement: 'Opinion statement',
  question: 'Question',
  todo: 'To-do',
};

/** The confidence tiers, ordered low to high — this is the review popup's
 * within-group sort (`plan.md` M18: "the confidence would be for the popup
 * groupings, but not then stored once it is approved"). */
export const CONFIDENCE_ORDER: Record<PendingItemConfidence, number> = { low: 0, medium: 1, high: 2 };

export const CONFIDENCE_LABEL: Record<PendingItemConfidence, string> = {
  low: 'Low confidence',
  medium: 'Medium confidence',
  high: 'High confidence',
};

/**
 * A question or a to-do has no category and so never has a visibility
 * setting of its own (`contract`'s `VisibilityStructureType` comment) — a
 * question publishes one at a time, directly; a to-do has no publish
 * mechanism at all. `null` for both, meaning "no visibility badge to show."
 */
export function pendingStructureTypeToVisibilityType(
  structureType: PendingItemStructureType,
): VisibilityStructureType | null {
  switch (structureType) {
    case 'metric':
      return 'metric';
    case 'review':
      return 'review_medium';
    case 'list_item':
      return 'list_type';
    case 'opinion_statement':
      return 'opinion_subject';
    case 'question':
    case 'todo':
      return null;
  }
}
