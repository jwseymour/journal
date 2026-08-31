import { z } from 'zod';
import { CONFIDENCE_PROMPT_PARAGRAPH, CONFIDENCE_REASON_SCHEMA, CONFIDENCE_SCHEMA } from './confidence.js';

/**
 * The second derived structure (`plan.md` M8, `requirements.md` §5.2):
 * "For things like films, books, and music. These are more like a table
 * with various fields, and are treated differently from simple metrics.
 * Each time the same thing is encountered, a new record is created for
 * that event — not an edit to a single existing record."
 *
 * The allowed media, same as metrics, come from
 * `CategoriesIndex.approvedNames('review_medium')` at call time — seeded
 * once with these three named examples, grown only through the approval
 * routes `requirements.md` §5.3 requires.
 */
export const REVIEW_MEDIUM_SEED_NAMES = ['film', 'book', 'music'] as const;

const SuggestedCategorySchema = z
  .object({
    name: z.string().describe('A short, lowercase medium name, e.g. "podcast" or "exhibition".'),
    reason: z.string().describe('One brief sentence: what in the entry prompted this suggestion.'),
  })
  .nullable()
  .describe(
    'If the entry reviews or gives an opinion on something whose medium does not fit any approved ' +
      'medium above, name ONE new medium here. Otherwise null. Never force it into the wrong ' +
      'approved medium just to avoid returning a suggestion, and never suggest one already approved.',
  );

function buildReviewSchema(approvedMedia: readonly string[]) {
  if (approvedMedia.length === 0) {
    throw new Error('buildReviewSchema: no approved review media — CategoriesIndex was never seeded.');
  }
  const mediumEnum = z.enum(approvedMedia as [string, ...string[]]);
  return z.object({
    reviews: z.array(
      z.object({
        title: z.string().describe('The title of the thing being reviewed, exactly as named in the entry.'),
        medium: mediumEnum,
        /** Nullable, not a forced numeric default — many opinions expressed
         * in an entry never state a rating at all, and inventing one would
         * be exactly the extrapolation `requirements.md` §5.2 prohibits for
         * derived structures that summarise opinions. */
        rating: z
          .number()
          .min(1)
          .max(5)
          .nullable()
          .describe(
            'A 1-5 rating ONLY if the entry states or clearly implies one. null if no rating was ' +
              'given — never infer a number from tone alone.',
          ),
        /** Nullable for the same reason as `rating`: many reviews say
         * nothing about how far through the work this encounter was, and a
         * multi-session medium like a book is often reviewed before it is
         * finished, so a forced value would misrepresent that. */
        progress: z
          .number()
          .min(0)
          .max(100)
          .nullable()
          .describe(
            'Percent of the work experienced as of this encounter, 0-100. For a medium normally ' +
              'consumed in one sitting (e.g. film, music), default to 100 unless the entry says or ' +
              'implies otherwise (still watching or listening, stopped partway, gave up). For a medium ' +
              'normally consumed over multiple sessions (e.g. book), set this ONLY if the entry states ' +
              'or clearly implies a fraction (e.g. "halfway through", "just started") — otherwise null. ' +
              'Never guess a number from tone alone.',
          ),
        opinion: z
          .string()
          .describe('The opinion or reaction as actually expressed in the entry — summarised, not invented.'),
        eventTime: z
          .string()
          .describe(
            "RFC 3339 timestamp with a UTC offset for when this was encountered (watched, read, " +
              "listened to), resolved from the entry's prose relative to the entry's own written time. " +
              "If the entry gives no time information, repeat the entry's own written time exactly.",
          ),
        eventTimeExplicit: z
          .boolean()
          .describe(
            'true only if the entry itself states or implies when this was encountered; false if ' +
              "eventTime was defaulted to the entry's own written time.",
          ),
        confidence: CONFIDENCE_SCHEMA,
        confidenceReason: CONFIDENCE_REASON_SCHEMA,
      }),
    ),
    suggestedCategory: SuggestedCategorySchema,
  });
}
export type ReviewExtractionResult = z.infer<ReturnType<typeof buildReviewSchema>>;

function buildReviewSystemPrompt(approvedMedia: readonly string[]): string {
  return `You extract reviews and opinions of specific named works from a personal journal entry — things like films, books, or music that are reviewed or reacted to.

The only approved media right now are: ${approvedMedia.join(', ')}. ${CONFIDENCE_PROMPT_PARAGRAPH} If the entry names no reviewable work at all, return an empty list.

Each encounter is its own record, even for something reviewed before. If the entry reviews two different films, that is two records.

For "opinion", summarise only what the entry actually says — never extend the reasoning or add praise/criticism the entry does not contain. This structure organises opinions actually expressed; it does not extrapolate.

For "rating", use null unless the entry gives or clearly implies a 1-5 rating. Do not guess a number from tone.

For "progress", give a 0-100 percentage of how far through the work this encounter was. For a medium normally finished in one sitting (film, music), default to 100 unless the entry indicates the work was left unfinished (stopped partway, still watching or listening, gave up). For a medium normally spread across multiple sessions (book), only set a value the entry actually implies (e.g. "halfway through," "just started") — otherwise null. Never guess a number from tone alone.

For "eventTime", resolve when the thing was actually encountered, not when the entry was written. Use the entry's own written time (given below) as the reference point for relative expressions. If nothing is said about when, use the entry's own written time exactly and mark eventTimeExplicit as false.

If the entry reviews something whose medium genuinely does not fit an approved medium, use "suggestedCategory" to name it rather than forcing the wrong medium or inventing one in the "medium" field (only the approved names above are valid there).`;
}

export interface ReviewExtractionRequest {
  schema: ReturnType<typeof buildReviewSchema>;
  system: string;
}

export function buildReviewExtractionRequest(approvedMedia: readonly string[]): ReviewExtractionRequest {
  return { schema: buildReviewSchema(approvedMedia), system: buildReviewSystemPrompt(approvedMedia) };
}

export function buildExtractionPrompt(entry: { created: string; body: string }): string {
  return `This entry was written at ${entry.created}.\n\n${entry.body}`;
}
