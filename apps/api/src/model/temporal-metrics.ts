import { z } from 'zod';

/**
 * The first derived structure (`plan.md` M7, `requirements.md` §5.2):
 * "Things explicitly stated in a journal entry and stored against time —
 * exercise, alcohol, sleep, and so on. This is the most obvious case. The
 * list is open-ended."
 *
 * That list is genuinely open-ended in the requirements, but §5.3 is
 * absolute: **the AI never creates a new metric on its own** — it may only
 * suggest one for approval, or extract against one the user has requested.
 * Nothing resembling that suggestion/approval flow exists yet — it is
 * `plan.md` M8's job, not this one's. Restricting extraction to exactly the
 * three examples `requirements.md` §5.2 itself names keeps this seed set
 * something the user has already effectively requested, in their own
 * canonical document, rather than the AI inventing categories at runtime.
 * Growing this list later, once M8's approval mechanism exists, is additive
 * — nothing here has to change shape to allow it.
 */
export const TEMPORAL_METRIC_NAMES = ['exercise', 'alcohol', 'sleep'] as const;
export type TemporalMetricName = (typeof TEMPORAL_METRIC_NAMES)[number];

export const ExtractedMetricSchema = z.object({
  metric: z.enum(TEMPORAL_METRIC_NAMES),
  /**
   * Event time versus entry time (`requirements.md` §6.3): what is being
   * asked for here is when the thing *happened*, not when the entry was
   * written. The prompt supplies the entry's own written time so the model
   * has something to resolve a relative reference ("this morning",
   * "last night") against.
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
});
export type ExtractedMetric = z.infer<typeof ExtractedMetricSchema>;

export const ExtractionResultSchema = z.object({ metrics: z.array(ExtractedMetricSchema) });
export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;

/**
 * Autonomy is the default (`requirements.md` §6.1): explicit statements are
 * high-confidence and are committed without review, so the instruction here
 * is deliberately conservative in the other direction — say nothing rather
 * than guess, because a false positive is what someone would actually have
 * to notice and correct, while a missed one is simply not there yet.
 */
export const EXTRACTION_SYSTEM_PROMPT = `You extract simple temporal metrics from a personal journal entry: exercise, alcohol, and sleep.

Only extract something that is explicitly stated in the entry — never infer, assume, or guess. If the entry does not mention one of these three things happening, do not produce a record for it. An entry that mentions none of them should produce an empty list.

Each distinct occurrence is its own record. An entry mentioning both a morning run and an evening walk produces two "exercise" records, not one combined record.

For "detail", write a short, plain, factual description using only what the entry actually says — a duration, a quantity, a kind. Never add information the entry does not contain.

For "eventTime", resolve when the thing actually happened, not when the entry was written. Use the entry's own written time (given to you below) as the reference point for relative expressions like "this morning" or "last night". If the entry gives no time information at all for a specific event, use the entry's own written time exactly and mark eventTimeExplicit as false.`;

/** The entry-specific half of the prompt — the model's own written time, so
 * it has something to resolve a relative time expression against
 * (`requirements.md` §6.3), and the body itself. */
export function buildExtractionPrompt(entry: { created: string; body: string }): string {
  return `This entry was written at ${entry.created}.\n\n${entry.body}`;
}
