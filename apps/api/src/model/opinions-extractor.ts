import type { CategoriesIndex } from '../index/categories-index.js';
import type { OpinionStatementRecord, OpinionStatementsIndex } from '../index/opinion-statements-index.js';
import { ulid } from '../record/id.js';
import { nowTimestamp } from '../record/time.js';
import type { EntryStore } from '../store/entry-store.js';
import type { Confidence } from './confidence.js';
import { resolveEventTime } from './event-time.js';
import type { ModelClient } from './model-client.js';
import { buildExtractionPrompt, buildOpinionExtractionRequest, type OpinionExtractionResult } from './opinions.js';

const PAGE_SIZE = 100;

/** One opinion-statement candidate from a live Process run (`plan.md` M18)
 * — see `MetricCandidate` in `extractor.ts` for the full reasoning. */
export interface OpinionStatementCandidate {
  id: string;
  subject: string;
  statement: string;
  kind: 'note' | 'question';
  eventTime: string;
  eventEpochMs: number;
  eventTimeExplicit: boolean;
  extractedAt: string;
  confidence: Confidence;
  confidenceReason: string | null;
}

/** This entry appears to answer an already-open `kind: 'question'`
 * statement — the per-person conversation-topics mechanism, mirroring
 * `QuestionResolutionCandidate` exactly. `statementId` has already been
 * checked against the real open set; a hallucinated id never reaches here. */
export interface OpinionResolutionCandidate {
  statementId: string;
  resolution: string;
  confidence: Confidence;
  confidenceReason: string | null;
}

export interface OpinionExtractionCandidates {
  extractedAt: string;
  candidates: OpinionStatementCandidate[];
  resolutions: OpinionResolutionCandidate[];
  suggestedCategory: OpinionExtractionResult['suggestedCategory'];
}

/**
 * Turns one entry's body into opinion-statement candidates via
 * `ModelClient` — layer 1 of the opinion model (`plan.md` M8). Same shape as
 * `Extractor`, `ReviewsExtractor`, and `ListsExtractor` — its own class
 * rather than a shared generic, for the reasons `ReviewsExtractor`'s comment
 * gives. `extractCandidates`/`extractEntry` split the same way as
 * `Extractor`'s (`plan.md` M18).
 *
 * Deliberately does not touch summaries: regenerating the cited per-subject
 * summary is `OpinionSummarizer`'s job. For `reprocessAll`, that still runs
 * as its own pass after every entry has been (re-)extracted (`reprocess.ts`,
 * unchanged). For the live path, it now runs only once a statement is
 * actually *approved* (`model/pending-item-applier.ts`) — summarizing a
 * still-pending, possibly-about-to-be-rejected statement would risk a
 * summary citing something never actually committed, which the "actually
 * expressed" constraint (`requirements.md` §5.2) does not allow. This is why
 * `extractCandidates` below no longer needs to return which subjects were
 * touched, unlike this file's pre-M18 `extractEntry` — the applier already
 * knows a candidate's subject from its `category` field.
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

  async extractCandidates(entry: { id: string; created: string; body: string }): Promise<OpinionExtractionCandidates> {
    const approvedSubjects = this.#categoriesIndex.approvedNames('opinion_subject');
    const openQuestions = this.#statementsIndex.listOpenQuestions();
    const { schema, system } = buildOpinionExtractionRequest(
      approvedSubjects,
      openQuestions.map((q) => ({ id: q.id, subject: q.subject, statement: q.statement })),
    );
    const result = await this.#modelClient.extract({ schema, system, prompt: buildExtractionPrompt(entry) });

    const extractedAt = nowTimestamp().canonical;
    const candidates: OpinionStatementCandidate[] = result.statements.map((statement) => {
      const resolved = resolveEventTime(statement.eventTime, statement.eventTimeExplicit, entry.created);
      return {
        id: ulid(Date.now()),
        subject: statement.subject,
        statement: statement.statement,
        kind: statement.kind,
        ...resolved,
        extractedAt,
        confidence: statement.confidence,
        confidenceReason: statement.confidenceReason,
      };
    });

    // Never trust a matched id blindly (`requirements.md` §5.2's
    // no-extrapolation constraint applied to resolutions too) — the same
    // filter `QuestionsExtractor.extractCandidates` applies before a
    // resolution candidate is allowed to exist at all.
    const openIds = new Set(openQuestions.map((q) => q.id));
    const resolutions: OpinionResolutionCandidate[] = result.resolutions
      .filter((r) => openIds.has(r.statementId))
      .map((r) => ({
        statementId: r.statementId,
        resolution: r.resolution,
        confidence: r.confidence,
        confidenceReason: r.confidenceReason,
      }));

    return { extractedAt, candidates, resolutions, suggestedCategory: result.suggestedCategory };
  }

  /** Returns the distinct subjects this entry produced a statement for (or
   * proposed an update against) — what `reprocessAll` needs to know which
   * subjects' summaries (`OpinionSummarizer`) are now stale, without
   * re-summarizing every subject in the corpus. */
  async extractEntry(entry: { id: string; created: string; body: string }): Promise<{ statementCount: number; subjects: string[] }> {
    const { extractedAt, candidates, resolutions, suggestedCategory } = await this.extractCandidates(entry);
    const records: Omit<
      OpinionStatementRecord,
      'entryId' | 'status' | 'resolvedEntryId' | 'resolution' | 'resolvedAt'
    >[] = candidates.map((candidate) => ({
      id: candidate.id,
      subject: candidate.subject,
      statement: candidate.statement,
      kind: candidate.kind,
      eventTime: candidate.eventTime,
      eventEpochMs: candidate.eventEpochMs,
      eventTimeExplicit: candidate.eventTimeExplicit,
      extractedAt: candidate.extractedAt,
      touched: false,
    }));
    const result = { suggestedCategory };

    // The pre-M18 direct-commit path (`reprocessAll` only) — see
    // `QuestionsExtractor.extractEntry`'s equivalent. Guarded by `resolve`
    // itself: never overwrites an already-touched question.
    for (const resolution of resolutions) {
      this.#statementsIndex.resolve(resolution.statementId, {
        resolvedEntryId: entry.id,
        resolution: resolution.resolution,
        resolvedAt: extractedAt,
      });
    }

    // See `Extractor.extractEntry` for the full reasoning (`plan.md` M10).
    const touched = this.#statementsIndex.touchedForEntry(entry.id);
    let untouchedRecords = records;
    if (touched.length > 0 && touched.length === records.length) {
      for (let i = 0; i < touched.length; i += 1) {
        const before = touched[i];
        const after = records[i];
        if (!before || !after) continue;
        if (before.statement !== after.statement || before.eventTime !== after.eventTime) {
          this.#statementsIndex.proposeUpdate({
            id: ulid(Date.now()),
            recordId: before.id,
            entryId: entry.id,
            statement: after.statement,
            eventTime: after.eventTime,
            eventEpochMs: after.eventEpochMs,
            eventTimeExplicit: after.eventTimeExplicit,
            reason: 'Reprocessing this entry now extracts different content.',
            now: extractedAt,
          });
        }
      }
      untouchedRecords = [];
    }
    this.#statementsIndex.replaceUntouchedForEntry(entry.id, untouchedRecords);

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

    return { statementCount: records.length, subjects: [...new Set(records.map((r) => r.subject))] };
  }

  removeEntry(entryId: string): void {
    this.#statementsIndex.removeEntry(entryId);
  }

  async reprocessAll(store: EntryStore): Promise<{ entryCount: number; statementCount: number }> {
    this.#statementsIndex.clearUntouched();
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
