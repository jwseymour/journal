import { z } from 'zod';
import type { DefineFieldInput, MetricFieldDefinition } from '../index/metric-fields-index.js';
import { CONFIDENCE_PROMPT_PARAGRAPH, CONFIDENCE_REASON_SCHEMA, CONFIDENCE_SCHEMA } from './confidence.js';

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
 *
 * `plan.md` M9 adds structured fields per metric (`MetricFieldDefinition`),
 * same growth model extended one level: the AI may suggest a new field
 * (`suggestedField`), or the user defines one directly. The schema is a
 * discriminated union keyed by `metric` — each approved name gets its own
 * `fields` shape built from its own definitions, so it is structurally
 * impossible for the model to put `sport` on an `alcohol` record, not just
 * a prompt-discipline convention.
 */
export const METRIC_SEED_NAMES = [
  'exercise',
  'alcohol',
  'sleep',
  'food',
  'caffeine',
  'weight',
  'mood',
  'activities',
  'productivity',
  'social',
  'symptoms',
] as const;

/**
 * Fields worth having on a metric from day one, rather than left for the
 * user to define by hand through `/categories` — approved directly, the
 * same second route `requirements.md` §5.3 gives every open-ended category
 * (`DefineMetricFieldRequest`'s own route, just applied at boot instead of
 * from a request). A bare occurrence is the deliberate default for every
 * metric above **except** these: a number is what actually makes "weight"
 * or "3 cups of coffee" worth plotting as a trend rather than a plain
 * yes/no day (`design.md` §5.3 — a line, not just a calendar heatmap).
 *
 * Applied idempotently at every boot (`index.ts`), mirroring
 * `CategoriesIndex.seed`: `MetricFieldsIndex.define`'s `INSERT OR IGNORE`,
 * plus the table's own `UNIQUE(metric, field_key)` constraint, means a pair
 * that already exists — including one since edited through `/categories`
 * — is left exactly as it is. Adding a new entry here is therefore always
 * safe; it can never clobber a definition the user has since changed.
 */
export const METRIC_FIELD_SEEDS: readonly Omit<DefineFieldInput, 'id' | 'now'>[] = [
  {
    metric: 'weight',
    fieldKey: 'value',
    label: 'Weight',
    fieldType: 'numeric',
    unit: 'kg',
    scoreMin: null,
    scoreMax: null,
    description: 'The weight recorded, in kilograms.',
  },
  {
    metric: 'mood',
    fieldKey: 'state',
    label: 'Mood',
    fieldType: 'score',
    unit: null,
    scoreMin: 1,
    scoreMax: 5,
    description: 'How the writer describes feeling, from 1 (worst) to 5 (best).',
  },
  {
    metric: 'productivity',
    fieldKey: 'score',
    label: 'Productivity',
    fieldType: 'score',
    unit: null,
    scoreMin: 1,
    scoreMax: 5,
    description: 'How productive the writer felt the period was, from 1 (least) to 5 (most).',
  },
  {
    metric: 'symptoms',
    fieldKey: 'severity',
    label: 'Severity',
    fieldType: 'score',
    unit: null,
    scoreMin: 1,
    scoreMax: 5,
    description: 'How severe the symptom was, from 1 (barely noticeable) to 5 (severe).',
  },
  {
    metric: 'caffeine',
    fieldKey: 'amount',
    label: 'Amount',
    fieldType: 'numeric',
    unit: 'cups',
    scoreMin: null,
    scoreMax: null,
    description: 'How much caffeine was had, in cups of coffee or tea (e.g. "3 cups" → 3).',
  },
];

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

/** One field's value schema — always nullable, never guessed. Generalizes
 * the same nullable-numeric-field precedent already shipped in
 * `reviews.ts`'s `rating`, whose own comment says inventing a value "would
 * be exactly the extrapolation §5.2 prohibits." */
function buildFieldValueSchema(field: MetricFieldDefinition, approvedEnumValues: readonly string[]): z.ZodTypeAny {
  const base: z.ZodTypeAny =
    field.fieldType === 'numeric'
      ? z.number()
      : field.fieldType === 'score'
        ? z.number().min(field.scoreMin ?? 1).max(field.scoreMax ?? 5)
        : field.fieldType === 'enum' && approvedEnumValues.length > 0
          ? z.enum(approvedEnumValues as [string, ...string[]])
          : z.string(); // enum with no approved values yet — degrade to free text rather than an impossible-to-satisfy enum

  return base.nullable().describe(
    `${field.description}${field.unit ? ` (in ${field.unit})` : ''}. null if the entry does not state ` +
      'this — never infer or guess a value that was not actually written.',
  );
}

function buildFieldsSchema(fields: readonly MetricFieldDefinition[], enumValuesByFieldId: ReadonlyMap<string, readonly string[]>) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of fields) shape[field.fieldKey] = buildFieldValueSchema(field, enumValuesByFieldId.get(field.id) ?? []);
  return z.object(shape);
}

function buildMetricVariantSchema(
  metric: string,
  fields: readonly MetricFieldDefinition[],
  enumValuesByFieldId: ReadonlyMap<string, readonly string[]>,
) {
  return z.object({
    metric: z.literal(metric),
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
    fields: buildFieldsSchema(fields, enumValuesByFieldId),
    confidence: CONFIDENCE_SCHEMA,
    confidenceReason: CONFIDENCE_REASON_SCHEMA,
  });
}

function buildSuggestedFieldSchema(metricEnum: z.ZodEnum<[string, ...string[]]>) {
  return z
    .object({
      metric: metricEnum,
      fieldKey: z.string().describe('A short, lowercase, machine-safe key, e.g. "pace_min_per_km".'),
      label: z.string().describe('A short human label, e.g. "Pace".'),
      fieldType: z.enum(['numeric', 'enum', 'text', 'score']),
      unit: z.string().nullable().describe('Numeric fields only, e.g. "min/km". null otherwise.'),
      description: z.string().describe('One sentence: what this field captures.'),
      reason: z.string().describe('One brief sentence: what in the entry prompted this suggestion.'),
    })
    .nullable()
    .describe(
      'If this entry mentions something quantifiable or trackable for one of the metrics above that ' +
        'has no defined field yet (e.g. pace, mentioned repeatedly, with no "pace" field on exercise), ' +
        'suggest ONE new field here. Otherwise null. Never suggest a field that already exists.',
    );
}

/** The escape hatch for an `enum`-typed field's value schema being a closed
 * `z.enum(approvedValues)` (or plain `z.string()` before anything is
 * approved) — without this, a value the entry states but that isn't
 * approved yet (a new sport, a new drink type) has nowhere to go except
 * null, silently. `fieldKey` is deliberately a free string here, not
 * re-validated against the metric's real fields by this schema — the
 * extractor checks it against the real, currently-known enum fields before
 * ever calling `MetricFieldsIndex`/`CategoriesIndex`, the same "never trust
 * what crosses the boundary" posture `OpinionSummarizer` applies to
 * AI-cited statement ids. */
function buildSuggestedFieldValueSchema(metricEnum: z.ZodEnum<[string, ...string[]]>) {
  return z
    .object({
      metric: metricEnum,
      fieldKey: z.string().describe('The existing category-type field this value belongs to, e.g. "sport".'),
      value: z.string().describe('The new value, e.g. "climbing".'),
      reason: z.string().describe('One brief sentence: what in the entry prompted this suggestion.'),
    })
    .nullable()
    .describe(
      'If this entry states a value for an existing category-type field that is not in its approved ' +
        'list above (e.g. a new sport, a new drink type), suggest it here rather than forcing the ' +
        'closest approved value or leaving the field silently null. Otherwise null.',
    );
}

function buildMetricSchema(
  approvedNames: readonly string[],
  fieldsByMetric: ReadonlyMap<string, readonly MetricFieldDefinition[]>,
  enumValuesByFieldId: ReadonlyMap<string, readonly string[]>,
) {
  if (approvedNames.length === 0) {
    throw new Error('buildMetricSchema: no approved metric categories — CategoriesIndex was never seeded.');
  }
  const metricEnum = z.enum(approvedNames as [string, ...string[]]);
  const variants = approvedNames.map((name) =>
    buildMetricVariantSchema(name, fieldsByMetric.get(name) ?? [], enumValuesByFieldId),
  );
  const metricsArray =
    variants.length === 1
      ? z.array(variants[0]!)
      : z.array(
          z.discriminatedUnion('metric', variants as [(typeof variants)[number], (typeof variants)[number], ...(typeof variants)[number][]]),
        );

  return z.object({
    metrics: metricsArray,
    suggestedCategory: SuggestedCategorySchema,
    suggestedField: buildSuggestedFieldSchema(metricEnum),
    suggestedFieldValue: buildSuggestedFieldValueSchema(metricEnum),
  });
}
export type ExtractionResult = z.infer<ReturnType<typeof buildMetricSchema>>;

/**
 * Every candidate now passes through explicit human approval before it
 * becomes a real record (`requirements.md` §6.1, rewritten at `plan.md`
 * M18) — a deliberate reversal of this file's original "say nothing rather
 * than guess" stance. See `confidence.ts` for the full reasoning behind
 * `CONFIDENCE_PROMPT_PARAGRAPH` below.
 */
function buildMetricSystemPrompt(
  approvedNames: readonly string[],
  fieldsByMetric: ReadonlyMap<string, readonly MetricFieldDefinition[]>,
  enumValuesByFieldId: ReadonlyMap<string, readonly string[]>,
): string {
  const fieldParagraphs = approvedNames
    .map((name) => {
      const fields = fieldsByMetric.get(name) ?? [];
      if (fields.length === 0) return null;
      const described = fields
        .map((f) => {
          const approvedValues = f.fieldType === 'enum' ? enumValuesByFieldId.get(f.id) ?? [] : null;
          const valuesNote = approvedValues ? ` — approved values: ${approvedValues.length > 0 ? approvedValues.join(', ') : '(none yet)'}` : '';
          return `"${f.fieldKey}" (${f.label}): ${f.description}${f.unit ? ` (in ${f.unit})` : ''}${valuesNote}`;
        })
        .join('; ');
      return `For "${name}", also fill in these fields where the entry states them: ${described}. Leave a field null rather than guessing if the entry does not say, and never force a value into a category-type field that isn't in its approved list.`;
    })
    .filter((p): p is string => p !== null)
    .join('\n\n');

  return `You extract simple temporal metrics from a personal journal entry — things stated or plausibly implied and stored against time.

The only approved categories right now are: ${approvedNames.join(', ')}. ${CONFIDENCE_PROMPT_PARAGRAPH} An entry giving no basis for any approved category should produce an empty metrics list.

Each distinct occurrence is its own record. An entry mentioning both a morning run and an evening walk produces two "exercise" records, not one combined record.

For "detail", write a short, plain, factual description using only what the entry actually says — a duration, a quantity, a kind. Never add information the entry does not contain.

For "eventTime", resolve when the thing actually happened, not when the entry was written. Use the entry's own written time (given to you below) as the reference point for relative expressions like "this morning" or "last night". If the entry gives no time information at all for a specific event, use the entry's own written time exactly and mark eventTimeExplicit as false.

If the entry describes something metric-like that genuinely does not fit any approved category, use "suggestedCategory" to name it rather than forcing it into the wrong one or inventing a new category name in the "metric" field (which is impossible — only the approved names above are valid there).${fieldParagraphs ? `\n\n${fieldParagraphs}` : ''}

If an entry mentions something quantifiable or trackable for one of the metrics above that has no defined field yet, use "suggestedField" to propose one rather than cramming it into "detail" alone or inventing a field key that isn't in the schema (which is impossible). Otherwise leave "suggestedField" null.

If an entry states a value for an existing category-type field that is not in its approved list (e.g. a new sport, a new drink type), use "suggestedFieldValue" to propose it rather than forcing the closest approved value or leaving the field silently null. Otherwise leave "suggestedFieldValue" null.`;
}

export interface MetricExtractionRequest {
  schema: ReturnType<typeof buildMetricSchema>;
  system: string;
}

export function buildMetricExtractionRequest(
  approvedNames: readonly string[],
  fieldsByMetric: ReadonlyMap<string, readonly MetricFieldDefinition[]>,
  enumValuesByFieldId: ReadonlyMap<string, readonly string[]>,
): MetricExtractionRequest {
  return {
    schema: buildMetricSchema(approvedNames, fieldsByMetric, enumValuesByFieldId),
    system: buildMetricSystemPrompt(approvedNames, fieldsByMetric, enumValuesByFieldId),
  };
}

/** The entry-specific half of the prompt — the model's own written time, so
 * it has something to resolve a relative time expression against
 * (`requirements.md` §6.3), and the body itself. */
export function buildExtractionPrompt(entry: { created: string; body: string }): string {
  return `This entry was written at ${entry.created}.\n\n${entry.body}`;
}
