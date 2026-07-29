import { z } from 'zod';

/**
 * The third derived structure (`plan.md` M8, `requirements.md` §5.2):
 * "Lists of atomic items. For example quotes. These behave differently
 * again from the structures above."
 *
 * "Atomic" is the operative word: unlike a review (many fields describing
 * one encounter) or a metric (a value against time), a list item is just
 * the thing itself — a quote is its exact words, not a summary of them.
 *
 * The allowed item types, same pattern as metrics and review media, come
 * from `CategoriesIndex.approvedNames('list_type')` at call time — seeded
 * with the one named example, "quote", grown only through the approval
 * routes `requirements.md` §5.3 requires.
 */
export const LIST_TYPE_SEED_NAMES = ['quote'] as const;

const SuggestedCategorySchema = z
  .object({
    name: z.string().describe('A short, lowercase item-type name, e.g. "recipe" or "todo".'),
    reason: z.string().describe('One brief sentence: what in the entry prompted this suggestion.'),
  })
  .nullable()
  .describe(
    'If the entry contains an atomic item that does not fit any approved list type above, name ONE ' +
      'new type here. Otherwise null. Never force it into the wrong approved type, and never suggest ' +
      'one already approved.',
  );

function buildListItemSchema(approvedTypes: readonly string[]) {
  if (approvedTypes.length === 0) {
    throw new Error('buildListItemSchema: no approved list types — CategoriesIndex was never seeded.');
  }
  const typeEnum = z.enum(approvedTypes as [string, ...string[]]);
  return z.object({
    items: z.array(
      z.object({
        listType: typeEnum,
        /** The item exactly as written — for a quote, its exact words, not
         * a paraphrase. Extraction must never rewrite what was actually
         * said (`requirements.md` §4.8's "no user markup" principle applied
         * to content, not formatting: the AI structures, it does not edit). */
        text: z.string().describe('The atomic item exactly as it appears in the entry — verbatim, never paraphrased.'),
        context: z
          .string()
          .describe(
            'Brief surrounding context actually stated — who said it, where it is from, why it was ' +
              'noted. Empty string if the entry gives none.',
          ),
        eventTime: z
          .string()
          .describe(
            "RFC 3339 timestamp with a UTC offset for when this was encountered, resolved from the " +
              "entry's prose relative to the entry's own written time. If the entry gives no time " +
              "information, repeat the entry's own written time exactly.",
          ),
        eventTimeExplicit: z
          .boolean()
          .describe(
            'true only if the entry itself states or implies when this was encountered; false if ' +
              "eventTime was defaulted to the entry's own written time.",
          ),
      }),
    ),
    suggestedCategory: SuggestedCategorySchema,
  });
}
export type ListExtractionResult = z.infer<ReturnType<typeof buildListItemSchema>>;

function buildListSystemPrompt(approvedTypes: readonly string[]): string {
  return `You extract atomic items from a personal journal entry — small, self-contained things worth keeping on their own, distinct from the surrounding prose.

The only approved item types right now are: ${approvedTypes.join(', ')}. Only extract something the entry actually contains verbatim or near-verbatim — never invent or paraphrase a "quote" into different words. If the entry contains nothing that fits an approved type, return an empty list.

For "text", use the item exactly as written. For "context", use only what the entry actually states about where it came from or why it was noted — never guess.

For "eventTime", resolve when this was actually encountered, not when the entry was written. Use the entry's own written time (given below) as the reference point for relative expressions. If nothing is said about when, use the entry's own written time exactly and mark eventTimeExplicit as false.

If the entry contains an atomic item that does not fit an approved type, use "suggestedCategory" to name it rather than forcing the wrong type or inventing one in "listType" (only the approved names above are valid there).`;
}

export interface ListExtractionRequest {
  schema: ReturnType<typeof buildListItemSchema>;
  system: string;
}

export function buildListExtractionRequest(approvedTypes: readonly string[]): ListExtractionRequest {
  return { schema: buildListItemSchema(approvedTypes), system: buildListSystemPrompt(approvedTypes) };
}

export function buildExtractionPrompt(entry: { created: string; body: string }): string {
  return `This entry was written at ${entry.created}.\n\n${entry.body}`;
}
