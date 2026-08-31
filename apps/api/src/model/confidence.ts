import { z } from 'zod';

/**
 * Shared by every extraction schema (`temporal-metrics.ts`, `reviews.ts`,
 * `lists.ts`, `opinions.ts`, `questions.ts`, `todos.ts`) — one candidate's
 * confidence tag (`plan.md` M18). A coarse categorical tier, not a numeric
 * score: a model is not a reliably calibrated self-reporter of a continuous
 * probability, and every other open-ended judgment already in these schemas
 * (`eventTimeExplicit`, `fieldType`) is a small enum, not a float.
 *
 * This is what makes extracting a low-confidence candidate safe rather than
 * reckless (`requirements.md` §6.1, rewritten at M18): nothing produced by
 * extraction commits on its own anymore, whatever its confidence — a human
 * approves every candidate, individually or in a batch, before it becomes a
 * real record. `confidence`/`confidenceReason` exist to arrange that review
 * (lowest-surfaced-confidence first, within its structure-type group) and
 * are discarded the moment an item is approved — never stored on the
 * committed record.
 *
 * "low" itself never reaches that review: `LivePendingProcessor` drops any
 * candidate tagged "low" before it becomes a pending item at all (see the
 * filter right before `insertBatch` there). The model still tags it
 * honestly rather than rounding up to avoid being discarded — confidence
 * describes the model's own certainty in the reading, not a request to be
 * shown — the pipeline just never surfaces the result.
 */
export const CONFIDENCE_SCHEMA = z
  .enum(['high', 'medium', 'low'])
  .describe(
    '"high" if the entry states this explicitly and unambiguously; "medium" if it is a reasonable ' +
      'reading that involves some inference from context; "low" if this is a plausible but genuinely ' +
      'uncertain reading. Never omit this or default to "high" to avoid scrutiny — a human reviews ' +
      'every candidate regardless, and confidence only decides how that review is organized.',
  );

export const CONFIDENCE_REASON_SCHEMA = z
  .string()
  .nullable()
  .describe(
    'One brief clause explaining the reading — required whenever confidence is not "high"; null when it is.',
  );

export type Confidence = z.infer<typeof CONFIDENCE_SCHEMA>;

/**
 * The instruction every extraction system prompt now includes, replacing
 * each file's previous "say nothing rather than guess" stance — the actual
 * reversal of `requirements.md` §6.1. A missed candidate is invisible to
 * review and can only be caught by a later entry; a low-confidence one that
 * gets tagged and reviewed costs nothing beyond one click. This does not
 * license inventing content: `detail`/`statement`/`text`/etc. must still
 * come only from a genuine reading of the entry — confidence describes how
 * sure that reading is, never permission to add what a reading cannot
 * support.
 */
export const CONFIDENCE_PROMPT_PARAGRAPH =
  'Extract a candidate whenever a reading of the entry plausibly supports one — you no longer need to be ' +
  'certain. Tag your own confidence honestly using the field provided: "high" for something explicit and ' +
  'unambiguous, "medium" for a reasonable reading that involves some inference, "low" for a plausible but ' +
  'genuinely uncertain one. Tag honestly rather than rounding up to "medium" to avoid being filtered out: ' +
  '"medium" and "high" candidates reach a human for review, but "low" ones are discarded automatically before ' +
  'anyone sees them, so an honest "low" costs nothing while a dishonestly-inflated "medium" wastes the ' +
  "reviewer's time on something you already doubted. This is not license to invent: confidence describes how " +
  'sure you are of a reading that is still genuinely there in the entry, never a way to add detail the entry ' +
  'does not support. If the entry gives no basis for a reading at all, do not produce a candidate for it.';
