import { z } from 'zod';

/**
 * Layer 1 of the opinion model (`plan.md` M8, `requirements.md` §5.2):
 * "For example my philosophy, or my view of my future. The defining
 * characteristic is that any single journal entry contains only partial
 * information on the subject... There is an absolute constraint on this
 * structure: it must not extrapolate from what I have written."
 *
 * This file only extracts what one entry said — per-entry, faithful,
 * unextended. Combining statements across entries into a cited summary is
 * `opinion-summarizer.ts`'s job, deliberately kept separate: the
 * no-extrapolation constraint is easiest to hold to one entry at a time.
 *
 * The allowed subjects, same pattern as every other structure, come from
 * `CategoriesIndex.approvedNames('opinion_subject')` at call time — seeded
 * once with the two named examples, grown only through approval.
 */
export const OPINION_SUBJECT_SEED_NAMES = ['philosophy', 'future'] as const;

const SuggestedCategorySchema = z
  .object({
    name: z.string().describe('A short, lowercase subject name, e.g. "career" or "politics".'),
    reason: z.string().describe('One brief sentence: what in the entry prompted this suggestion.'),
  })
  .nullable()
  .describe(
    'If the entry expresses a view on a subject that does not fit any approved subject above, ' +
      'name ONE new subject here. Otherwise null. Never force it into the wrong approved subject, ' +
      'and never suggest one already approved.',
  );

function buildOpinionSchema(approvedSubjects: readonly string[]) {
  if (approvedSubjects.length === 0) {
    throw new Error('buildOpinionSchema: no approved subjects — CategoriesIndex was never seeded.');
  }
  const subjectEnum = z.enum(approvedSubjects as [string, ...string[]]);
  return z.object({
    statements: z.array(
      z.object({
        subject: subjectEnum,
        /** A faithful summary of what THIS entry expressed — "summarise",
         * not "extrapolate" (`requirements.md` §5.2): condensing what was
         * actually said is wanted, inferring what wasn't is prohibited. */
        statement: z
          .string()
          .describe(
            'A faithful summary of the view expressed in this entry — condense what was actually ' +
              'said, never add reasoning, implications, or conclusions the entry does not itself state.',
          ),
        eventTime: z
          .string()
          .describe(
            "RFC 3339 timestamp with a UTC offset for when this view was expressed, resolved from " +
              "the entry's prose relative to the entry's own written time. If the entry gives no time " +
              "information, repeat the entry's own written time exactly.",
          ),
        eventTimeExplicit: z
          .boolean()
          .describe(
            'true only if the entry itself states or implies when; false if eventTime was defaulted ' +
              "to the entry's own written time.",
          ),
      }),
    ),
    suggestedCategory: SuggestedCategorySchema,
  });
}
export type OpinionExtractionResult = z.infer<ReturnType<typeof buildOpinionSchema>>;

function buildOpinionSystemPrompt(approvedSubjects: readonly string[]): string {
  return `You extract expressed opinions from a personal journal entry — views, beliefs, or positions the writer explicitly states on a subject they care about tracking over time.

The only approved subjects right now are: ${approvedSubjects.join(', ')}. Only extract a view the entry actually states — never infer a position from mood, tone, or adjacent topics. If the entry expresses no view on an approved subject, return an empty list.

This is the single most important rule: never extrapolate. Summarise only what the entry itself says. Do not add reasoning the entry doesn't contain, do not draw out an implication the writer didn't state, do not extend an argument on the writer's behalf. If in doubt, leave it out — a missed statement can be caught by a later entry; a fabricated one cannot be un-said.

Each distinct view is its own record, even on the same subject within one entry.

For "eventTime", resolve when this view was expressed, not when the entry was written (they are almost always the same instant, since a view is expressed by the act of writing it, but resolve it the same way as the other structures for consistency). If the entry gives no time information at all, use the entry's own written time exactly and mark eventTimeExplicit as false.

If the entry expresses a view that does not fit an approved subject, use "suggestedCategory" to name it rather than forcing the wrong subject or inventing one in "subject" (only the approved names above are valid there).`;
}

export interface OpinionExtractionRequest {
  schema: ReturnType<typeof buildOpinionSchema>;
  system: string;
}

export function buildOpinionExtractionRequest(approvedSubjects: readonly string[]): OpinionExtractionRequest {
  return { schema: buildOpinionSchema(approvedSubjects), system: buildOpinionSystemPrompt(approvedSubjects) };
}

export function buildExtractionPrompt(entry: { created: string; body: string }): string {
  return `This entry was written at ${entry.created}.\n\n${entry.body}`;
}
