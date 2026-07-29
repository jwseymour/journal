import type { MetricsIndex, TemporalMetricRecord } from '../index/metrics-index.js';
import { ulid } from '../record/id.js';
import { nowTimestamp, parseTimestamp } from '../record/time.js';
import type { EntryStore } from '../store/entry-store.js';
import type { ModelClient } from './model-client.js';
import { buildExtractionPrompt, EXTRACTION_SYSTEM_PROMPT, ExtractionResultSchema } from './temporal-metrics.js';

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
  readonly #modelClient: ModelClient;

  constructor(metricsIndex: MetricsIndex, modelClient: ModelClient) {
    this.#metricsIndex = metricsIndex;
    this.#modelClient = modelClient;
  }

  async extractEntry(entry: { id: string; created: string; body: string }): Promise<void> {
    const result = await this.#modelClient.extract({
      schema: ExtractionResultSchema,
      system: EXTRACTION_SYSTEM_PROMPT,
      prompt: buildExtractionPrompt(entry),
    });

    const extractedAt = nowTimestamp().canonical;
    const records: Omit<TemporalMetricRecord, 'entryId'>[] = result.metrics.map((metric) => {
      // The model is asked to always return a valid, offset-carrying RFC 3339
      // string, but nothing from outside this process is trusted blindly —
      // a malformed `eventTime` falls back to the entry's own written time
      // rather than corrupting the record or failing the whole extraction.
      const parsed = parseTimestamp(metric.eventTime);
      const eventTime = parsed ? parsed.canonical : entry.created;
      const eventEpochMs = parsed ? parsed.epochMs : (parseTimestamp(entry.created)?.epochMs ?? Date.now());
      return {
        id: ulid(Date.now()),
        metric: metric.metric,
        eventTime,
        eventEpochMs,
        eventTimeExplicit: parsed !== null && metric.eventTimeExplicit,
        detail: metric.detail,
        extractedAt,
      };
    });

    this.#metricsIndex.replaceEntry(entry.id, records);
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
