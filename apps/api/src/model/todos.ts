import { z } from 'zod';

/**
 * To-dos (`plan.md` M15) — an outstanding task, errand, or commitment the
 * writer states or clearly implies, that a later entry may go on to report
 * done. Structurally the same two-in-one shape as `questions.ts`: a single
 * record's life can span two entries, so extraction does two things in one
 * call — `newTodos` extracts per-entry, `completions` checks the entry
 * against every currently open to-do from earlier entries (**including**
 * ones created directly in the UI with no entry at all, since those can
 * still be reported done by a later entry — `requirements.md` §11). No
 * approved-name enum, same reasoning as questions: a to-do's content is the
 * whole of it.
 */

const NewTodoSchema = z.object({
  /** Faithful to how the entry actually states it — not sharpened into
   * something more specific, more urgent, or more resolved than what was
   * written. */
  text: z
    .string()
    .describe(
      'The outstanding task, errand, or commitment, phrased faithfully to how the entry actually states or ' +
        'implies it — never paraphrased into something more specific or more urgent than what was written.',
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

const CompletionSchema = z.object({
  /** Never trusted blindly — `TodosExtractor` checks this against the
   * exact ids it actually offered before storing anything, the same
   * never-trust-a-citation posture `QuestionsExtractor` applies to its own
   * resolutions. */
  todoId: z
    .string()
    .describe(
      'The exact id, from the "currently open to-dos" list given below, that this entry reports done. ' +
        'Never invent an id, and never guess which one if it is genuinely unclear.',
    ),
  resolution: z
    .string()
    .describe(
      'A faithful quote or summary of what THIS entry actually says about it being done — never inferred ' +
        'or assumed beyond what the entry itself states.',
    ),
});

export const TodoExtractionSchema = z.object({
  newTodos: z.array(NewTodoSchema),
  completions: z.array(CompletionSchema),
});
export type TodoExtractionResult = z.infer<typeof TodoExtractionSchema>;

export const TODO_SYSTEM_PROMPT = `You do two things with a personal journal entry: extract any new outstanding task, errand, or commitment it raises, and check whether it reports any to-do raised earlier as now done.

A to-do is an action still to be taken — "need to call the dentist," "should fix the fence this weekend," "have to reply to that email." It is different from a question: a question is something undecided the writer is wrestling with; a to-do is a concrete action still outstanding. If the entry only poses something as undecided, that belongs to a question, not a to-do — do not extract the same sentence as both.

For "newTodos", phrase each one faithful to how the entry actually states or implies it — do not sharpen it into something more specific, more urgent, or more resolved than what was written. Do not raise something as newly outstanding if this same entry already reports it done itself.

You will be given a list of currently open to-dos, each with its own id, some raised in earlier entries and some added directly without any entry behind them. For "completions", check whether this entry's content genuinely reports any of them done. Only include one if the entry actually says so — never guess or infer completion just because the topic came up in passing. Use only the exact ids given; never invent one. "resolution" must be a faithful quote or summary of what this entry actually says, never something you have inferred beyond that.

If the entry raises no trackable to-do and reports none of the given ones done, return empty arrays for both.`;

export interface OpenTodoCandidate {
  id: string;
  text: string;
}

export function buildTodoExtractionPrompt(
  entry: { created: string; body: string },
  openTodos: readonly OpenTodoCandidate[],
): string {
  const openList =
    openTodos.length > 0 ? openTodos.map((t) => `[id: ${t.id}] ${t.text}`).join('\n') : '(none currently open)';
  return `This entry was written at ${entry.created}.\n\nCurrently open to-dos:\n${openList}\n\nEntry:\n${entry.body}`;
}
