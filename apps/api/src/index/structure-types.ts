import type { TouchedSourceType } from '../durable/touched-mirror.js';
import type { CoreStructureType } from './categories-index.js';

/**
 * Maps between the two structure-type vocabularies this codebase carries
 * side by side: the per-record vocabulary (`TouchedSourceType`, and
 * `PublishableSourceType` in `publish/publisher.ts`, which is the same set
 * plus `'entry'`/`'document'`) names one of the six touchable derived-record
 * shapes; the category-namespace vocabulary (`CoreStructureType`, used only
 * by `CategoriesIndex`/`VisibilityDefaultsIndex`) names one of the four
 * structure types that have an open-ended category field at all.
 *
 * `GET /publish-queue` (`plan.md` M16) already did this mapping once,
 * inline, in a hand-written `if`/`else` chain. The live pending-item
 * pipeline (`plan.md` M18) needs the same mapping repeatedly — once per
 * candidate, to look up its category's visibility default on approval — so
 * it is extracted here rather than duplicated a second and third time.
 */

export function recordTypeToCoreStructureType(sourceType: TouchedSourceType): CoreStructureType | null {
  switch (sourceType) {
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
      // Neither has a category namespace: questions publish one at a time,
      // directly (`QuestionsIndex`'s own doc comment); todos have no
      // publish mechanism at all.
      return null;
  }
}

/** The inverse — always defined, since every category-namespaced structure
 * type has exactly one record shape behind it. */
export function coreStructureTypeToRecordType(structureType: CoreStructureType): TouchedSourceType {
  switch (structureType) {
    case 'metric':
      return 'metric';
    case 'review_medium':
      return 'review';
    case 'list_type':
      return 'list_item';
    case 'opinion_subject':
      return 'opinion_statement';
  }
}
