import type { CategoriesIndex } from '../index/categories-index.js';
import type { MetricFieldDefinition, MetricFieldsIndex } from '../index/metric-fields-index.js';
import type { MetricsIndex, TemporalMetricRecord } from '../index/metrics-index.js';
import { ulid } from '../record/id.js';
import { nowTimestamp } from '../record/time.js';
import type { EntryStore } from '../store/entry-store.js';
import { resolveEventTime } from './event-time.js';
import type { ModelClient } from './model-client.js';
import { buildExtractionPrompt, buildMetricExtractionRequest } from './temporal-metrics.js';

const PAGE_SIZE = 100;

/**
 * Turns one entry's body into temporal-metric records via `ModelClient`, and
 * drives the full-corpus reprocess (`plan.md` M7).
 *
 * Extraction is real money, not local compute — unlike `SearchIndexer`
 * (`plan.md` M6), nothing here is wired into the live write path. Autosave
 * fires on every debounced keystroke; a paid API call on every one of those
 * would be both wasteful and a surprise on the user's bill. `reprocessAll`
 * is the deliberate, explicit way this runs for now — batch, sequential,
 * and only ever something the user chooses to run.
 */
export class Extractor {
  readonly #metricsIndex: MetricsIndex;
  readonly #metricFieldsIndex: MetricFieldsIndex;
  readonly #categoriesIndex: CategoriesIndex;
  readonly #modelClient: ModelClient;

  constructor(metricsIndex: MetricsIndex, metricFieldsIndex: MetricFieldsIndex, categoriesIndex: CategoriesIndex, modelClient: ModelClient) {
    this.#metricsIndex = metricsIndex;
    this.#metricFieldsIndex = metricFieldsIndex;
    this.#categoriesIndex = categoriesIndex;
    this.#modelClient = modelClient;
  }

  async extractEntry(entry: { id: string; created: string; body: string }): Promise<void> {
    const approvedNames = this.#categoriesIndex.approvedNames('metric');

    const fieldsByMetric = new Map<string, MetricFieldDefinition[]>();
    const enumValuesByFieldId = new Map<string, readonly string[]>();
    // Also indexed by (metric, fieldKey) — what validating `suggestedFieldValue`
    // against the real, currently-known enum fields needs below.
    const enumFieldsByMetricAndKey = new Map<string, MetricFieldDefinition>();
    for (const name of approvedNames) {
      const fields = this.#metricFieldsIndex.listForMetric(name);
      fieldsByMetric.set(name, fields);
      for (const field of fields) {
        if (field.fieldType === 'enum') {
          enumValuesByFieldId.set(field.id, this.#categoriesIndex.approvedNames(`metric_field:${field.metric}:${field.fieldKey}`));
          enumFieldsByMetricAndKey.set(`${field.metric}:${field.fieldKey}`, field);
        }
      }
    }

    const { schema, system } = buildMetricExtractionRequest(approvedNames, fieldsByMetric, enumValuesByFieldId);
    const result = await this.#modelClient.extract({ schema, system, prompt: buildExtractionPrompt(entry) });

    const extractedAt = nowTimestamp().canonical;
    const records: Omit<TemporalMetricRecord, 'entryId'>[] = result.metrics.map((metric) => {
      const resolved = resolveEventTime(metric.eventTime, metric.eventTimeExplicit, entry.created);
      return {
        id: ulid(Date.now()),
        metric: metric.metric,
        ...resolved,
        detail: metric.detail,
        fields: metric.fields ?? {},
        extractedAt,
      };
    });

    this.#metricsIndex.replaceEntry(entry.id, records);

    // The AI suggesting a new category (`requirements.md` §5.3's first
    // route) — never auto-approved, just recorded for a human to decide on
    // via `POST /categories/:id/approve`.
    if (result.suggestedCategory) {
      this.#categoriesIndex.suggest({
        structureType: 'metric',
        name: result.suggestedCategory.name,
        reason: result.suggestedCategory.reason,
        entryId: entry.id,
        id: ulid(Date.now()),
        now: extractedAt,
      });
    }

    // The AI suggesting a new field for an existing metric — same route,
    // extended one level (`plan.md` M9): never auto-approved, just recorded
    // for a human to decide on via the same shape of endpoint.
    if (result.suggestedField) {
      this.#metricFieldsIndex.suggest({
        metric: result.suggestedField.metric,
        fieldKey: result.suggestedField.fieldKey,
        label: result.suggestedField.label,
        fieldType: result.suggestedField.fieldType,
        unit: result.suggestedField.unit,
        scoreMin: null,
        scoreMax: null,
        description: result.suggestedField.description,
        reason: result.suggestedField.reason,
        entryId: entry.id,
        id: ulid(Date.now()),
        now: extractedAt,
      });
    }

    // The AI suggesting a new value for an existing enum field — never
    // trusted blindly: `fieldKey` is a free string in the schema (see
    // `buildSuggestedFieldValueSchema`'s own comment), so it is checked
    // against the real, currently-known enum fields before ever reaching
    // `CategoriesIndex.suggest`, the same "never trust what crosses the
    // boundary" posture `OpinionSummarizer` applies to cited statement ids.
    if (result.suggestedFieldValue) {
      const field = enumFieldsByMetricAndKey.get(`${result.suggestedFieldValue.metric}:${result.suggestedFieldValue.fieldKey}`);
      if (field) {
        this.#categoriesIndex.suggest({
          structureType: `metric_field:${field.metric}:${field.fieldKey}`,
          name: result.suggestedFieldValue.value,
          reason: result.suggestedFieldValue.reason,
          entryId: entry.id,
          id: ulid(Date.now()),
          now: extractedAt,
        });
      }
    }
  }

  removeEntry(entryId: string): void {
    this.#metricsIndex.removeEntry(entryId);
  }

  /**
   * Reprocess-from-scratch (`requirements.md` §6.4): every entry, re-sent to
   * the model, nothing carried over from before. This is also the
   * model-migration procedure (`requirements.md` §7.6) — run once against
   * one `EXTRACTION_MODEL`, run again against another, and diff `GET
   * /metrics` between the two.
   *
   * Sequential, not parallel — a real API cost per entry, so a large corpus
   * should cost predictably and rate-limit gracefully rather than arrive as
   * a burst.
   */
  async reprocessAll(store: EntryStore): Promise<{ entryCount: number; metricCount: number }> {
    this.#metricsIndex.clear();
    let cursor: string | undefined;
    let entryCount = 0;
    do {
      const page = await store.list({ limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) });
      for (const summary of page.entries) {
        const entry = await store.get(summary.id);
        if (!entry) continue; // vanished between list and get — same tolerance as M1
        await this.extractEntry(entry);
        entryCount += 1;
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    const { metricCount } = this.#metricsIndex.stats();
    return { entryCount, metricCount };
  }
}
