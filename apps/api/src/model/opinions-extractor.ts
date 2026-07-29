import type { CategoriesIndex } from '../index/categories-index.js';
import type { OpinionStatementRecord, OpinionStatementsIndex } from '../index/opinion-statements-index.js';
import { ulid } from '../record/id.js';
import { nowTimestamp } from '../record/time.js';
import type { EntryStore } from '../store/entry-store.js';
import { resolveEventTime } from './event-time.js';
import type { ModelClient } from './model-client.js';
import { buildExtractionPrompt, buildOpinionExtractionRequest } from './opinions.js';

const PAGE_SIZE = 100;

/**
 * Turns one entry's body into opinion-statement records via `ModelClient` —
 * layer 1 of the opinion model (`plan.md` M8). Same shape as `Extractor`,
 * `ReviewsExtractor`, and `ListsExtractor` — its own class rather than a
 * shared generic, for the reasons `ReviewsExtractor`'s comment gives.
 *
 * Deliberately does not touch summaries: regenerating the cited per-subject
 * summary is `OpinionSummarizer`'s job, run as its own pass after every
 * entry has been (re-)extracted — see `reprocess.ts`.
 */
export class OpinionsExtractor {
  readonly #statementsIndex: OpinionStatementsIndex;
  readonly #categoriesIndex: CategoriesIndex;
  readonly #modelClient: ModelClient;

  constructor(statementsIndex: OpinionStatementsIndex, categoriesIndex: CategoriesIndex, modelClient: ModelClient) {
    this.#statementsIndex = statementsIndex;
    this.#categoriesIndex = categoriesIndex;
    this.#modelClient = modelClient;
  }

  async extractEntry(entry: { id: string; created: string; body: string }): Promise<void> {
    const approvedSubjects = this.#categoriesIndex.approvedNames('opinion_subject');
    const { schema, system } = buildOpinionExtractionRequest(approvedSubjects);
    const result = await this.#modelClient.extract({ schema, system, prompt: buildExtractionPrompt(entry) });

    const extractedAt = nowTimestamp().canonical;
    const records: Omit<OpinionStatementRecord, 'entryId'>[] = result.statements.map((statement) => {
      const resolved = resolveEventTime(statement.eventTime, statement.eventTimeExplicit, entry.created);
      return {
        id: ulid(Date.now()),
        subject: statement.subject,
        statement: statement.statement,
        ...resolved,
        extractedAt,
      };
    });

    this.#statementsIndex.replaceEntry(entry.id, records);

    if (result.suggestedCategory) {
      this.#categoriesIndex.suggest({
        structureType: 'opinion_subject',
        name: result.suggestedCategory.name,
        reason: result.suggestedCategory.reason,
        entryId: entry.id,
        id: ulid(Date.now()),
        now: extractedAt,
      });
    }
  }

  removeEntry(entryId: string): void {
    this.#statementsIndex.removeEntry(entryId);
  }

  async reprocessAll(store: EntryStore): Promise<{ entryCount: number; statementCount: number }> {
    this.#statementsIndex.clear();
    let cursor: string | undefined;
    let entryCount = 0;
    do {
      const page = await store.list({ limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) });
      for (const summary of page.entries) {
        const entry = await store.get(summary.id);
        if (!entry) continue;
        await this.extractEntry(entry);
        entryCount += 1;
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    const { statementCount } = this.#statementsIndex.stats();
    return { entryCount, statementCount };
  }
}
