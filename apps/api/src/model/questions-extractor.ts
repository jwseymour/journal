import type { QuestionRecord, QuestionsIndex } from '../index/questions-index.js';
import { ulid } from '../record/id.js';
import { nowTimestamp } from '../record/time.js';
import type { EntryStore, StoredEntry } from '../store/entry-store.js';
import { resolveEventTime } from './event-time.js';
import type { ModelClient } from './model-client.js';
import { buildQuestionExtractionPrompt, OPEN_QUESTION_SYSTEM_PROMPT, OpenQuestionExtractionSchema } from './questions.js';

const PAGE_SIZE = 100;

/**
 * Turns one entry into open-question records via `ModelClient` — the same
 * one-call-per-entry shape as `Extractor`, `ReviewsExtractor`,
 * `ListsExtractor`, and `OpinionsExtractor`, but the one call does two
 * things: raise whatever this entry newly poses, and check the entry
 * against every question still open from earlier entries.
 *
 * That second half is what makes processing *order* load-bearing here in a
 * way it never is for any other extractor — resolution can only ever look
 * backward in time, so `reprocessAll` below sorts entries chronologically
 * before extracting, unlike every sibling extractor, which does not care
 * what order `store.list()` happens to hand entries back in.
 */
export class QuestionsExtractor {
  readonly #questionsIndex: QuestionsIndex;
  readonly #modelClient: ModelClient;

  constructor(questionsIndex: QuestionsIndex, modelClient: ModelClient) {
    this.#questionsIndex = questionsIndex;
    this.#modelClient = modelClient;
  }

  async extractEntry(entry: { id: string; created: string; body: string }): Promise<void> {
    const openQuestions = this.#questionsIndex.listOpen();
    const prompt = buildQuestionExtractionPrompt(
      entry,
      openQuestions.map((q) => ({ id: q.id, question: q.question })),
    );
    const result = await this.#modelClient.extract({
      schema: OpenQuestionExtractionSchema,
      system: OPEN_QUESTION_SYSTEM_PROMPT,
      prompt,
    });

    const extractedAt = nowTimestamp().canonical;
    const raised: Omit<QuestionRecord, 'entryId'>[] = result.newQuestions.map((q) => {
      const resolved = resolveEventTime(q.eventTime, q.eventTimeExplicit, entry.created);
      return {
        id: ulid(Date.now()),
        question: q.question,
        ...resolved,
        extractedAt,
        status: 'open',
        resolvedEntryId: null,
        resolution: null,
        resolvedAt: null,
      };
    });
    this.#questionsIndex.replaceRaised(entry.id, raised);

    // Never trust a citation blindly — the same posture `OpinionSummarizer`
    // applies to its own citations, applied here to question ids instead: a
    // resolution naming an id that was never actually offered is dropped
    // rather than stored.
    const openIds = new Set(openQuestions.map((q) => q.id));
    for (const resolution of result.resolutions) {
      if (!openIds.has(resolution.questionId)) continue;
      this.#questionsIndex.resolve(resolution.questionId, {
        resolvedEntryId: entry.id,
        resolution: resolution.resolution,
        resolvedAt: extractedAt,
      });
    }
  }

  removeEntry(entryId: string): void {
    this.#questionsIndex.removeEntry(entryId);
  }

  /** Reprocess-from-scratch (`requirements.md` §6.4), in chronological
   * order — the one thing every sibling extractor's `reprocessAll` does not
   * need, since none of them has a notion of "before" and "after" between
   * entries the way a resolution does. */
  async reprocessAll(store: EntryStore): Promise<{ entryCount: number; questionCount: number; openCount: number; resolvedCount: number }> {
    this.#questionsIndex.clear();

    const entries: StoredEntry[] = [];
    let cursor: string | undefined;
    do {
      const page = await store.list({ limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) });
      for (const summary of page.entries) {
        const entry = await store.get(summary.id);
        if (entry) entries.push(entry);
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    entries.sort((a, b) => Date.parse(a.created) - Date.parse(b.created));

    for (const entry of entries) {
      await this.extractEntry(entry);
    }

    const stats = this.#questionsIndex.stats();
    return { entryCount: entries.length, ...stats };
  }
}
