import { z } from 'zod';

/**
 * Open questions (`plan.md` M8c) — something the writer poses as genuinely
 * undecided, that a later entry may go on to answer. Structurally unlike
 * every other derived structure: a single record's life can span two
 * entries, so extraction here does two things in one call rather than one —
 * `newQuestions` extracts per-entry, exactly like `opinions.ts`, but
 * `resolutions` also checks the entry against every *currently open*
 * question from earlier entries. No approved-name enum, unlike metrics,
 * reviews, lists, and opinions: a question's content is the whole of it,
 * there is nothing to categorise it against.
 *
 * The two-in-one shape is deliberate rather than two separate calls: every
 * other extractor makes exactly one `ModelClient.extract()` call per entry,
 * and there is no reason for this one to cost two.
 */

const NewQuestionSchema = z.object({
  /** Faithful to how the entry actually poses it — not sharpened into
   * something more resolved, profound, or specific than what was written. */
  question: z
    .string()
    .describe(
      'The open question or undecided thing, phrased faithfully to how the entry actually poses it — ' +
        'never paraphrased into something more resolved or more profound than what was written.',
    ),
  eventTime: z
    .string()
    .describe(
      "RFC 3339 timestamp with a UTC offset for when this was raised, resolved from the entry's " +
        "prose relative to the entry's own written time. If the entry gives no time information, " +
        "repeat the entry's own written time exactly.",
    ),
  eventTimeExplicit: z
    .boolean()
    .describe(
      'true only if the entry itself states or implies when; false if eventTime was defaulted to ' +
        "the entry's own written time.",
    ),
});

const ResolutionSchema = z.object({
  /** Never trusted blindly — `QuestionsExtractor` checks this against the
   * exact ids it actually offered before storing anything, the same
   * never-trust-a-citation posture `OpinionSummarizer` applies to its own
   * citations. */
  questionId: z
    .string()
    .describe(
      'The exact id, from the "currently open questions" list given below, that this entry ' +
        'addresses. Never invent an id, and never guess which one if it is genuinely unclear.',
    ),
  resolution: z
    .string()
    .describe(
      'A faithful quote or summary of what THIS entry actually says in answer — never an answer ' +
        'inferred or assumed beyond what the entry itself states.',
    ),
});

export const OpenQuestionExtractionSchema = z.object({
  newQuestions: z.array(NewQuestionSchema),
  resolutions: z.array(ResolutionSchema),
});
export type OpenQuestionExtractionResult = z.infer<typeof OpenQuestionExtractionSchema>;

export const OPEN_QUESTION_SYSTEM_PROMPT = `You do two things with a personal journal entry: extract any new open question it raises, and check whether it resolves any question raised earlier that is still open.

Not every question in the entry counts as one to track. A rhetorical aside or a passing "should I go for a run today?" is not this. Something the writer is visibly undecided about, wrestling with, or explicitly flags as unresolved is. If in doubt, leave it out — a missed one can be caught later; a fabricated one cannot be un-said.

For "newQuestions", phrase each one faithful to how the entry actually poses it — do not sharpen it into something more resolved, profound, or specific than what was written. Do not raise something as newly open if this same entry already answers it itself.

You will be given a list of currently open questions, each with its own id, raised in earlier entries. For "resolutions", check whether this entry's content actually addresses any of them. Only include one if the entry genuinely speaks to it — never guess or infer that a question was resolved just because the topic came up in passing. Use only the exact ids given; never invent one. "resolution" must be a faithful quote or summary of what this entry actually says, never an answer you have inferred beyond that.

If the entry raises no trackable question and resolves none of the given ones, return empty arrays for both.`;

export interface OpenQuestionCandidate {
  id: string;
  question: string;
}

export function buildQuestionExtractionPrompt(
  entry: { created: string; body: string },
  openQuestions: readonly OpenQuestionCandidate[],
): string {
  const openList =
    openQuestions.length > 0
      ? openQuestions.map((q) => `[id: ${q.id}] ${q.question}`).join('\n')
      : '(none currently open)';
  return `This entry was written at ${entry.created}.\n\nCurrently open questions:\n${openList}\n\nEntry:\n${entry.body}`;
}
