import type { OpinionStatementRecord, OpinionStatementsIndex } from '../index/opinion-statements-index.js';
import type { OpinionSummariesIndex, OpinionSummaryPartRecord } from '../index/opinion-summaries-index.js';
import { ulid } from '../record/id.js';
import { nowTimestamp } from '../record/time.js';
import type { ModelClient } from './model-client.js';
import { buildOpinionSummaryPrompt, OPINION_SUMMARY_SYSTEM_PROMPT, OpinionSummarySchema } from './opinion-summaries.js';

/**
 * Layer 2 of the opinion model (`plan.md` M8) — regenerates one subject's
 * cited summary from every current statement on it. Deliberately a
 * separate pass from `OpinionsExtractor`, run after it: statement
 * extraction is per-entry, this is per-subject, and the two costs are
 * genuinely different shapes (`reprocess.ts` runs both).
 *
 * The one thing this class exists to guarantee: **nothing the model cites
 * is trusted blindly.** Every `sourceStatementIds` entry the model returns
 * is checked against the statements actually given to it — the same
 * "never trust what crosses the boundary" posture `resolveEventTime`'s
 * fallback applies to timestamps, applied here to citations instead. A
 * citation naming a real id but the *wrong* one would misattribute a
 * claim; a citation naming an id that doesn't exist at all is unambiguously
 * a hallucination. This class can only catch the second kind by
 * construction — it is the cheap, mechanical half of the guarantee, not a
 * substitute for a human occasionally checking a part against what it
 * cites.
 */
export class OpinionSummarizer {
  readonly #summariesIndex: OpinionSummariesIndex;
  readonly #statementsIndex: OpinionStatementsIndex;
  readonly #modelClient: ModelClient;

  constructor(summariesIndex: OpinionSummariesIndex, statementsIndex: OpinionStatementsIndex, modelClient: ModelClient) {
    this.#summariesIndex = summariesIndex;
    this.#statementsIndex = statementsIndex;
    this.#modelClient = modelClient;
  }

  async summarizeSubject(subject: string): Promise<void> {
    const statements = this.#statementsIndex.bySubject(subject);
    if (statements.length === 0) {
      // Every statement on this subject was discarded or its entries
      // vanished — an empty summary is not a summary of nothing, it is no
      // summary at all.
      this.#summariesIndex.removeSubject(subject);
      return;
    }

    const result = await this.#modelClient.extract({
      schema: OpinionSummarySchema,
      system: OPINION_SUMMARY_SYSTEM_PROMPT,
      prompt: buildOpinionSummaryPrompt(subject, statements),
    });

    const byId = new Map<string, OpinionStatementRecord>(statements.map((s) => [s.id, s]));
    const generatedAt = nowTimestamp().canonical;

    const parts: Omit<OpinionSummaryPartRecord, 'subject'>[] = [];
    result.parts.forEach((part, index) => {
      // Silently dropping a hallucinated id rather than the whole part —
      // the part may still be fully supported by its other, real citations.
      const cited = part.sourceStatementIds.filter((id) => byId.has(id));
      if (cited.length === 0) return; // no real citation survived; nothing to stand behind this part
      const entryIds = [...new Set(cited.map((id) => byId.get(id)!.entryId))];
      parts.push({
        id: ulid(Date.now()),
        partIndex: index,
        text: part.text,
        sourceStatementIds: cited,
        sourceEntryIds: entryIds,
        generatedAt,
      });
    });

    this.#summariesIndex.replaceSubject(subject, parts);
  }

  /** Every subject with at least one current statement, regenerated from
   * scratch (`requirements.md` §6.4) — run as the second half of
   * `reprocess`, after every entry has produced its statements. */
  async summarizeAll(): Promise<{ subjectCount: number; partCount: number }> {
    this.#summariesIndex.clear();
    const subjects = this.#statementsIndex.subjectsWithStatements();
    for (const subject of subjects) {
      await this.summarizeSubject(subject);
    }
    return this.#summariesIndex.stats();
  }
}
