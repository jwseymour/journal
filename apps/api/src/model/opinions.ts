import { z } from 'zod';
import { CONFIDENCE_REASON_SCHEMA, CONFIDENCE_SCHEMA } from './confidence.js';

/**
 * Layer 1 of the concept model (`plan.md` M8, `requirements.md` §5.2,
 * reframed 2026-08-30): a subject worth gathering everything about —
 * "my philosophy," "relationships," "my brain" — where any single entry
 * only ever holds a fragment, and the point is having it all in one place
 * over time. Grouping the fragments is the primary job; a generated
 * cross-entry summary (`opinion-summarizer.ts`) is a secondary, optional
 * view on top of that grouping, not the reason this structure exists.
 *
 * This started narrower — "opinions actually expressed" only, a view or
 * belief and nothing else. That excluded exactly the plain facts and
 * observations that make a subject like "my brain" or "relationships"
 * worth gathering in the first place, so the scope is now anything the
 * entry actually says about the subject: a fact, an event, a reflection,
 * or a stated view, condensed faithfully. What does not change is the
 * absolute constraint this structure has always had: it must not
 * extrapolate from what was written. Summarising what's there is the job;
 * inferring what isn't is not.
 *
 * This file only extracts what one entry said — per-entry, faithful,
 * unextended. Combining statements across entries into a cited summary is
 * `opinion-summarizer.ts`'s job, deliberately kept separate: the
 * no-extrapolation constraint is easiest to hold to one entry at a time.
 *
 * The allowed subjects, same pattern as every other structure, come from
 * `CategoriesIndex.approvedNames('opinion_subject')` at call time — seeded
 * with the original two plus every subject approved since, grown only
 * through approval.
 */
export const OPINION_SUBJECT_SEED_NAMES = [
  'philosophy',
  'future',
  'relationships',
  'identity',
  'neurodivergence',
] as const;

const SuggestedCategorySchema = z
  .object({
    name: z.string().describe('A short, lowercase subject name, e.g. "career" or "politics".'),
    reason: z.string().describe('One brief sentence: what in the entry prompted this suggestion.'),
  })
  .nullable()
  .describe(
    'If the entry says something worth gathering about a subject that does not fit any approved ' +
      'subject above, name ONE new subject here. Otherwise null. Never force it into the wrong ' +
      'approved subject, and never suggest one already approved.',
  );

/** A concept subject open a conversation topic for a resolution to target
 * — `id: X` in the prompt, matched against `resolutions[].statementId`
 * below, exactly the `[id: X] question text` convention
 * `questions.ts`'s equivalent list already uses. Never trusted blindly —
 * `opinions-extractor.ts` filters `resolutions` to ids that are actually in
 * this set before they become candidates. */
export interface OpenConceptQuestion {
  id: string;
  subject: string;
  statement: string;
}

/** A plain string, not an enum of currently-open ids — same choice
 * `questions.ts`'s equivalent schema makes, so an empty open-list never
 * needs a degenerate "matches nothing" schema shape. The extractor filters
 * against the real open set afterward; a hallucinated id is dropped there,
 * never trusted because it happened to parse. */
const ResolutionSchema = z.object({
  statementId: z.string().describe('The id of the open item from the list above that this entry resolves.'),
  resolution: z
    .string()
    .describe(
      'A faithful quote or summary of what THIS entry actually says in answer — never an answer ' +
        'inferred beyond what was actually written.',
    ),
  confidence: CONFIDENCE_SCHEMA,
  confidenceReason: CONFIDENCE_REASON_SCHEMA,
});

function buildOpinionSchema(approvedSubjects: readonly string[]) {
  if (approvedSubjects.length === 0) {
    throw new Error('buildOpinionSchema: no approved subjects — CategoriesIndex was never seeded.');
  }
  const subjectEnum = z.enum(approvedSubjects as [string, ...string[]]);
  return z.object({
    statements: z.array(
      z.object({
        subject: subjectEnum,
        /** A faithful record of what THIS entry actually said about the
         * subject — "summarise", not "extrapolate" (`requirements.md`
         * §5.2): condensing what was actually written is wanted, inferring
         * what wasn't is prohibited. Deliberately broader than "opinion" —
         * a plain fact or observation about the subject counts exactly as
         * much as a stated view. */
        statement: z
          .string()
          .describe(
            'A faithful record of what this entry actually says about the subject — a fact, an ' +
              'event, an observation, or a stated view. Condense what was actually written; never add ' +
              'reasoning, implications, or conclusions the entry does not itself state.',
          ),
        /** The per-person conversation-topics idea, folded into this
         * structure rather than built separately (`requirements.md` §11,
         * resolved 2026-08-30): `'question'` is something to raise with
         * the subject later, carrying the same open/resolved lifecycle
         * `OpenQuestion` has; everything else is `'note'`. */
        kind: z
          .enum(['note', 'question'])
          .describe(
            '"question" only if this is something to ask or bring up with the subject later — a ' +
              'genuine open item, not yet answered. "note" for everything else: a fact, an event, an ' +
              'observation, or a stated view that is not itself a thing to go ask about.',
          ),
        eventTime: z
          .string()
          .describe(
            "RFC 3339 timestamp with a UTC offset for when this was said, resolved from " +
              "the entry's prose relative to the entry's own written time. If the entry gives no time " +
              "information, repeat the entry's own written time exactly.",
          ),
        eventTimeExplicit: z
          .boolean()
          .describe(
            'true only if the entry itself states or implies when; false if eventTime was defaulted ' +
              "to the entry's own written time.",
          ),
        confidence: CONFIDENCE_SCHEMA,
        confidenceReason: CONFIDENCE_REASON_SCHEMA,
      }),
    ),
    /** Whether this entry answers a conversation topic raised earlier —
     * checked against the currently-open list given in the prompt, the
     * same "one call, both directions" shape `questions.ts` already uses. */
    resolutions: z.array(ResolutionSchema),
    suggestedCategory: SuggestedCategorySchema,
  });
}
export type OpinionExtractionResult = z.infer<ReturnType<typeof buildOpinionSchema>>;

function buildOpinionSystemPrompt(approvedSubjects: readonly string[], openQuestions: readonly OpenConceptQuestion[]): string {
  const openList =
    openQuestions.length === 0
      ? '(none currently open)'
      : openQuestions.map((q) => `[id: ${q.id}] (${q.subject}) ${q.statement}`).join('\n');

  return `You extract anything a personal journal entry actually says about a subject the writer cares about gathering over time — a fact, an event, an observation, or a stated view. This is broader than "opinion": a plain fact about the subject (something that happened, something noticed) counts exactly as much as a stated belief or position. The point is collecting everything written about the subject in one place, not filtering for opinions specifically.

The only approved subjects right now are: ${approvedSubjects.join(', ')}. Extract a statement whenever the entry plausibly says something about an approved subject — you no longer need to be certain it counts, since a human reviews every statement before it becomes part of the record. Tag your own confidence honestly: "high" for something explicit and unambiguous; "medium" for a reasonable reading that took some judgement to recognise as being about the subject; "low" for a plausible but genuinely borderline reading. If the entry says nothing about an approved subject at all, return an empty list.

Some statements are "question"-kind — something to raise or ask the subject about later, not yet answered. These currently‑open conversation topics are:
${openList}

If this entry answers or addresses one of those — the writer had the conversation, found out the answer, or the topic is no longer relevant — record it in "resolutions" with the matching id and a faithful quote or summary of the answer. Only match an id actually listed above; if nothing in the entry addresses any of them, return an empty "resolutions" list. This is separate from "statements": an entry can raise brand-new statements, resolve old ones, both, or neither.

This is the single most important rule, and confidence changes nothing about it: never extrapolate. Record only what the entry itself says, at whatever confidence. Do not add reasoning the entry doesn't contain, do not draw out an implication the writer didn't state, do not extend an argument or a fact on the writer's behalf — a "low confidence" statement is still a faithful record of something actually written, never an invention. If a candidate exists only because you extended the writer's reasoning rather than found it stated, it is not a real candidate at all — do not produce it even tagged "low". If in doubt about whether something counts, extract it and mark it low confidence for a human to judge; if in doubt about what it actually says, leave it out — a missed statement can be caught by a later entry, a fabricated one cannot be un-said. The same caution applies to resolutions: only match one you can actually quote or summarise faithfully from this entry.

Each distinct thing said is its own record, even on the same subject within one entry.

For "eventTime", resolve when this was said or happened, not when the entry was written (they are almost always the same instant, since most of this is expressed by the act of writing it, but resolve it the same way as the other structures for consistency). If the entry gives no time information at all, use the entry's own written time exactly and mark eventTimeExplicit as false.

If the entry says something worth gathering about a subject that does not fit an approved subject, use "suggestedCategory" to name it rather than forcing the wrong subject or inventing one in "subject" (only the approved names above are valid there).`;
}

export interface OpinionExtractionRequest {
  schema: ReturnType<typeof buildOpinionSchema>;
  system: string;
}

export function buildOpinionExtractionRequest(
  approvedSubjects: readonly string[],
  openQuestions: readonly OpenConceptQuestion[],
): OpinionExtractionRequest {
  return { schema: buildOpinionSchema(approvedSubjects), system: buildOpinionSystemPrompt(approvedSubjects, openQuestions) };
}

export function buildExtractionPrompt(entry: { created: string; body: string }): string {
  return `This entry was written at ${entry.created}.\n\n${entry.body}`;
}
