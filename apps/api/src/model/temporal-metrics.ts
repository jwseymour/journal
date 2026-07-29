import { z } from 'zod';

/**
 * The first derived structure (`plan.md` M7, `requirements.md` §5.2):
 * "Things explicitly stated in a journal entry and stored against time —
 * exercise, alcohol, sleep, and so on. This is the most obvious case. The
 * list is open-ended."
 *
 * The allowed metric names are no longer fixed in this file — they come
 * from `CategoriesIndex.approvedNames('metric')` at call time, seeded once
 * with exactly these three (`requirements.md` §5.2's own examples), and
 * grown from there only through the approval routes §5.3 requires: the AI
 * suggesting a category via this same extraction call's `suggestedCategory`
 * output, or the user requesting one directly. Nothing here invents a
 * category — the schema simply reflects whatever is currently approved.
 */
export const METRIC_SEED_NAMES = ['exercise', 'alcohol', 'sleep'] as const;

const SuggestedCategorySchema = z
  .object({
    name: z.string().describe('A short, lowercase category name, e.g. "meditation".'),
    reason: z.string().describe('One brief sentence: what in the entry prompted this suggestion.'),
  })
  .nullable()
  .describe(
    'If the entry describes something metric-like — explicitly stated and stored against time — ' +
      'that does not fit any approved category above, name ONE new category here. Otherwise null. ' +
      'Never force something into the wrong approved category just to avoid returning a suggestion, ' +
      'and never suggest a category that is already in the approved list.',
  );

function buildMetricSchema(approvedNames: readonly string[]) {
  if (approvedNames.length === 0) {
    throw new Error('buildMetricSchema: no approved metric categories — CategoriesIndex was never seeded.');
  }
  const metricEnum = z.enum(approvedNames as [string, ...string[]]);
  return z.object({
    metrics: z.array(
      z.object({
        metric: metricEnum,
        /**
         * Event time versus entry time (`requirements.md` §6.3): what is
         * being asked for here is when the thing *happened*, not when the
         * entry was written. The prompt supplies the entry's own written
         * time so the model has something to resolve a relative reference
         * ("this morning", "last night") against.
         */
        eventTime: z
          .string()
          .describe(
            "RFC 3339 timestamp with a UTC offset for when this actually happened, resolved from " +
              "the entry's prose relative to the entry's own written time. If the entry gives no " +
              "time information for this specific event, repeat the entry's own written time exactly.",
          ),
        eventTimeExplicit: z
          .boolean()
          .describe(
            'true only if the entry itself states or clearly implies a time or date for this ' +
              'specific event (e.g. "this morning", "last night", "on Tuesday"); false if eventTime ' +
              "was defaulted to the entry's own written time because the entry said nothing about when.",
          ),
        detail: z
          .string()
          .describe(
            'A short, plain, factual description taken from what was actually written — quantity, ' +
              'duration, or kind, exactly as stated. Empty string if nothing beyond the bare fact was said.',
          ),
      }),
    ),
    suggestedCategory: SuggestedCategorySchema,
  });
}
export type ExtractionResult = z.infer<ReturnType<typeof buildMetricSchema>>;

/**
 * Autonomy is the default (`requirements.md` §6.1): explicit statements are
 * high-confidence and are committed without review, so the instruction here
 * is deliberately conservative in the other direction — say nothing rather
 * than guess, because a false positive is what someone would actually have
 * to notice and correct, while a missed one is simply not there yet.
 */
function buildMetricSystemPrompt(approvedNames: readonly string[]): string {
  return `You extract simple temporal metrics from a personal journal entry — things explicitly stated and stored against time.

The only approved categories right now are: ${approvedNames.join(', ')}. Only extract something that is explicitly stated in the entry — never infer, assume, or guess. If the entry does not mention one of the approved categories happening, do not produce a record for it. An entry mentioning none of them should produce an empty metrics list.

Each distinct occurrence is its own record. An entry mentioning both a morning run and an evening walk produces two "exercise" records, not one combined record.

For "detail", write a short, plain, factual description using only what the entry actually says — a duration, a quantity, a kind. Never add information the entry does not contain.

For "eventTime", resolve when the thing actually happened, not when the entry was written. Use the entry's own written time (given to you below) as the reference point for relative expressions like "this morning" or "last night". If the entry gives no time information at all for a specific event, use the entry's own written time exactly and mark eventTimeExplicit as false.

If the entry describes something metric-like that genuinely does not fit any approved category, use "suggestedCategory" to name it rather than forcing it into the wrong one or inventing a new category name in the "metric" field (which is impossible — only the approved names above are valid there).`;
}

export interface MetricExtractionRequest {
  schema: ReturnType<typeof buildMetricSchema>;
  system: string;
}

export function buildMetricExtractionRequest(approvedNames: readonly string[]): MetricExtractionRequest {
  return { schema: buildMetricSchema(approvedNames), system: buildMetricSystemPrompt(approvedNames) };
}

/** The entry-specific half of the prompt — the model's own written time, so
 * it has something to resolve a relative time expression against
 * (`requirements.md` §6.3), and the body itself. */
export function buildExtractionPrompt(entry: { created: string; body: string }): string {
  return `This entry was written at ${entry.created}.\n\n${entry.body}`;
}
