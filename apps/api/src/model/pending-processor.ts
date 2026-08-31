import type { CreatePendingItemInput, PendingItemsIndex } from '../index/pending-items-index.js';
import type { ListsIndex } from '../index/lists-index.js';
import type { MetricsIndex } from '../index/metrics-index.js';
import type { OpinionStatementsIndex } from '../index/opinion-statements-index.js';
import type { QuestionsIndex } from '../index/questions-index.js';
import type { ReviewsIndex } from '../index/reviews-index.js';
import type { TodosIndex } from '../index/todos-index.js';
import { ulid } from '../record/id.js';
import { nowTimestamp } from '../record/time.js';
import type { Confidence } from './confidence.js';
import type { Extractor } from './extractor.js';
import type { ListsExtractor } from './lists-extractor.js';
import type { OpinionsExtractor } from './opinions-extractor.js';
import type { QuestionsExtractor } from './questions-extractor.js';
import type { ReviewsExtractor } from './reviews-extractor.js';
import type { TodosExtractor } from './todos-extractor.js';

export interface LivePendingProcessing {
  processEntry(entry: { id: string; created: string; body: string }): Promise<{ pendingItemCount: number; processRunId: string }>;
}

/**
 * The live, one-entry counterpart to `npm run reprocess` (`plan.md` M15,
 * M18) — every structure type, one candidate-only call each, for one entry,
 * triggered by an explicit Process click. Replaces `EntryProcessor`
 * entirely (deleted at M18): where that class called each extractor's
 * committing `extractEntry`, this one calls the same extractors'
 * non-committing `extractCandidates`, diffs the result against what is
 * already live, and writes `pending_extraction_items` rows for a human to
 * approve — nothing here ever calls `replaceUntouchedForEntry`,
 * `proposeUpdate`, `resolve`, or `completeFromExtraction` directly. This is
 * the actual mechanism behind `requirements.md` §6.1's rewrite: extraction
 * candidates exist, but nothing becomes a real record without approval
 * (`model/pending-item-applier.ts`).
 *
 * Deliberately **not** what `reprocessAll` is, same as `EntryProcessor`
 * before it: this never claims to be a from-scratch pass, and for
 * questions/todos it is only reliably correct for the entry that is
 * currently the newest one (`QuestionsExtractor`/`TodosExtractor`'s own
 * comments on `extractCandidates`/`extractEntry`).
 *
 * Sequential, not parallel — the same "predictable cost, no burst" posture
 * `Extractor.reprocessAll` takes, applied to six calls instead of one.
 */
export class LivePendingProcessor implements LivePendingProcessing {
  constructor(
    private readonly pendingItems: PendingItemsIndex,
    private readonly metricsIndex: MetricsIndex,
    private readonly extractor: Extractor,
    private readonly reviewsIndex: ReviewsIndex,
    private readonly reviewsExtractor: ReviewsExtractor,
    private readonly listsIndex: ListsIndex,
    private readonly listsExtractor: ListsExtractor,
    private readonly opinionStatementsIndex: OpinionStatementsIndex,
    private readonly opinionsExtractor: OpinionsExtractor,
    private readonly questionsIndex: QuestionsIndex,
    private readonly questionsExtractor: QuestionsExtractor,
    private readonly todosIndex: TodosIndex,
    private readonly todosExtractor: TodosExtractor,
  ) {}

  async processEntry(entry: { id: string; created: string; body: string }): Promise<{ pendingItemCount: number; processRunId: string }> {
    const processRunId = ulid(Date.now());
    const now = nowTimestamp().canonical;

    // A fresh run supersedes any still-undecided leftovers from an earlier
    // run on this same entry (`plan.md` M18) — already-approved/rejected
    // rows are untouched by this, only pending ones from a *different* run.
    this.pendingItems.supersedePendingForEntry(entry.id, processRunId, now);

    const items: CreatePendingItemInput[] = [];

    // --- Metrics -----------------------------------------------------
    const metricResult = await this.extractor.extractCandidates(entry);
    const metricLive = this.metricsIndex.liveForEntry(entry.id);
    items.push(
      ...buildItemsForSimpleStructure({
        entryId: entry.id,
        processRunId,
        now,
        structureType: 'metric',
        candidates: metricResult.candidates,
        live: metricLive,
        differs: (before, after) =>
          before.detail !== after.detail ||
          JSON.stringify(before.fields) !== JSON.stringify(after.fields) ||
          before.eventTime !== after.eventTime,
        category: (c) => c.metric,
        payload: (c) => ({ metric: c.metric, eventTime: c.eventTime, eventTimeExplicit: c.eventTimeExplicit, detail: c.detail, fields: c.fields }),
      }),
    );

    // --- Reviews -------------------------------------------------------
    const reviewResult = await this.reviewsExtractor.extractCandidates(entry);
    const reviewLive = this.reviewsIndex.liveForEntry(entry.id);
    items.push(
      ...buildItemsForSimpleStructure({
        entryId: entry.id,
        processRunId,
        now,
        structureType: 'review',
        candidates: reviewResult.candidates,
        live: reviewLive,
        differs: (before, after) =>
          before.title !== after.title ||
          before.rating !== after.rating ||
          before.progress !== after.progress ||
          before.opinion !== after.opinion ||
          before.eventTime !== after.eventTime,
        category: (c) => c.medium,
        payload: (c) => ({
          title: c.title,
          medium: c.medium,
          rating: c.rating,
          progress: c.progress,
          opinion: c.opinion,
          eventTime: c.eventTime,
          eventTimeExplicit: c.eventTimeExplicit,
        }),
      }),
    );

    // --- List items ------------------------------------------------------
    const listResult = await this.listsExtractor.extractCandidates(entry);
    const listLive = this.listsIndex.liveForEntry(entry.id);
    items.push(
      ...buildItemsForSimpleStructure({
        entryId: entry.id,
        processRunId,
        now,
        structureType: 'list_item',
        candidates: listResult.candidates,
        live: listLive,
        differs: (before, after) =>
          before.text !== after.text || before.context !== after.context || before.importance !== after.importance || before.eventTime !== after.eventTime,
        category: (c) => c.listType,
        payload: (c) => ({ listType: c.listType, text: c.text, context: c.context, importance: c.importance, eventTime: c.eventTime, eventTimeExplicit: c.eventTimeExplicit }),
      }),
    );

    // --- Opinion statements ----------------------------------------------
    const opinionResult = await this.opinionsExtractor.extractCandidates(entry);
    const opinionLive = this.opinionStatementsIndex.liveForEntry(entry.id);
    items.push(
      ...buildItemsForSimpleStructure({
        entryId: entry.id,
        processRunId,
        now,
        structureType: 'opinion_statement',
        candidates: opinionResult.candidates,
        live: opinionLive,
        differs: (before, after) => before.statement !== after.statement || before.eventTime !== after.eventTime,
        category: (c) => c.subject,
        payload: (c) => ({ subject: c.subject, statement: c.statement, kind: c.kind, eventTime: c.eventTime, eventTimeExplicit: c.eventTimeExplicit }),
      }),
    );
    // The conversation-topics extension (`requirements.md` §11, resolved
    // 2026-08-30) — no diffing step, same as a question's resolution:
    // `opinionsExtractor` has already checked `statementId` against the
    // real open set, so every entry here is a real candidate.
    for (const resolution of opinionResult.resolutions) {
      items.push(
        pendingItem({
          entryId: entry.id,
          processRunId,
          now,
          structureType: 'opinion_statement',
          kind: 'resolution',
          targetRecordId: resolution.statementId,
          category: null,
          payload: { resolution: resolution.resolution },
          confidence: resolution.confidence,
          reason: resolution.confidenceReason,
        }),
      );
    }

    // --- Questions ---------------------------------------------------------
    const questionResult = await this.questionsExtractor.extractCandidates(entry);
    const questionLive = this.questionsIndex.openRaisedBy(entry.id);
    const { newCandidates: newQuestions, updates: questionUpdates } = diffCandidates(
      questionResult.newQuestions,
      questionLive.filter((r) => r.touched),
      questionLive.filter((r) => !r.touched),
      (l) => l.id,
      (before, after) => before.question !== after.question || before.eventTime !== after.eventTime,
    );
    for (const candidate of newQuestions) {
      items.push(
        pendingItem({
          entryId: entry.id,
          processRunId,
          now,
          structureType: 'question',
          kind: 'new',
          targetRecordId: null,
          category: null,
          payload: { question: candidate.question, eventTime: candidate.eventTime, eventTimeExplicit: candidate.eventTimeExplicit },
          confidence: candidate.confidence,
          reason: candidate.confidenceReason,
        }),
      );
    }
    for (const { targetId, candidate } of questionUpdates) {
      items.push(
        pendingItem({
          entryId: entry.id,
          processRunId,
          now,
          structureType: 'question',
          kind: 'update',
          targetRecordId: targetId,
          category: null,
          payload: { question: candidate.question, eventTime: candidate.eventTime, eventTimeExplicit: candidate.eventTimeExplicit },
          confidence: candidate.confidence,
          reason: candidate.confidenceReason,
        }),
      );
    }
    for (const resolution of questionResult.resolutions) {
      items.push(
        pendingItem({
          entryId: entry.id,
          processRunId,
          now,
          structureType: 'question',
          kind: 'resolution',
          targetRecordId: resolution.questionId,
          category: null,
          payload: { resolution: resolution.resolution },
          confidence: resolution.confidence,
          reason: resolution.confidenceReason,
        }),
      );
    }

    // --- Todos ---------------------------------------------------------
    const todoResult = await this.todosExtractor.extractCandidates(entry);
    const todoLive = this.todosIndex.openRaisedBy(entry.id);
    const { newCandidates: newTodos, updates: todoUpdates } = diffCandidates(
      todoResult.newTodos,
      todoLive.filter((r) => r.touched),
      todoLive.filter((r) => !r.touched),
      (l) => l.id,
      (before, after) => before.text !== after.text || before.eventTime !== after.eventTime,
    );
    for (const candidate of newTodos) {
      items.push(
        pendingItem({
          entryId: entry.id,
          processRunId,
          now,
          structureType: 'todo',
          kind: 'new',
          targetRecordId: null,
          category: null,
          payload: { text: candidate.text, eventTime: candidate.eventTime, eventTimeExplicit: candidate.eventTimeExplicit },
          confidence: candidate.confidence,
          reason: candidate.confidenceReason,
        }),
      );
    }
    for (const { targetId, candidate } of todoUpdates) {
      items.push(
        pendingItem({
          entryId: entry.id,
          processRunId,
          now,
          structureType: 'todo',
          kind: 'update',
          targetRecordId: targetId,
          category: null,
          payload: { text: candidate.text, eventTime: candidate.eventTime, eventTimeExplicit: candidate.eventTimeExplicit },
          confidence: candidate.confidence,
          reason: candidate.confidenceReason,
        }),
      );
    }
    for (const completion of todoResult.completions) {
      items.push(
        pendingItem({
          entryId: entry.id,
          processRunId,
          now,
          structureType: 'todo',
          kind: 'completion',
          targetRecordId: completion.todoId,
          category: null,
          payload: { resolution: completion.resolution },
          confidence: completion.confidence,
          reason: completion.confidenceReason,
        }),
      );
    }

    // "low" confidence never reaches review at all (`requirements.md` §6.1,
    // rewritten again here) — a candidate the model itself is genuinely
    // unsure of is dropped before it becomes a pending item, rather than
    // adding one more row someone has to look at and reject. "medium" and
    // "high" are unaffected: everything past this filter still surfaces,
    // confidence only ordering it from there.
    const surfaced = items.filter((item) => item.confidence !== 'low');

    this.pendingItems.insertBatch(surfaced);

    return { pendingItemCount: surfaced.length, processRunId };
  }
}

/** One touched-then-untouched positional pass, generalizing the diff every
 * pre-M18 extractor already did for touched records alone
 * (`Extractor.extractEntry`'s own comment) to the live pending-item model:
 * a fresh candidate can now also correspond to an already-*approved*
 * record that was never individually touched, and that must not be
 * re-proposed as a duplicate `'new'` item either. Two passes, not one
 * combined pool, because touched and untouched carry different meaning —
 * conflating them into a single positional match would let an untouched
 * row's position silently shift what a touched row is compared against.
 * Exactly like the pre-M18 logic, a match is only ever attempted when the
 * counts line up cleanly; anything left over becomes a `'new'` candidate
 * rather than a guessed match. */
function diffCandidates<C, L>(
  candidates: readonly C[],
  touchedLive: readonly L[],
  untouchedLive: readonly L[],
  getId: (live: L) => string,
  differs: (before: L, after: C) => boolean,
): { newCandidates: C[]; updates: { targetId: string; candidate: C }[] } {
  let remaining = [...candidates];
  const updates: { targetId: string; candidate: C }[] = [];

  if (touchedLive.length > 0 && touchedLive.length === remaining.length) {
    for (let i = 0; i < touchedLive.length; i += 1) {
      const before = touchedLive[i]!;
      const after = remaining[i]!;
      if (differs(before, after)) updates.push({ targetId: getId(before), candidate: after });
    }
    remaining = [];
  }

  if (remaining.length > 0 && untouchedLive.length > 0 && untouchedLive.length === remaining.length) {
    for (let i = 0; i < untouchedLive.length; i += 1) {
      const before = untouchedLive[i]!;
      const after = remaining[i]!;
      if (differs(before, after)) updates.push({ targetId: getId(before), candidate: after });
    }
    remaining = [];
  }

  return { newCandidates: remaining, updates };
}

interface LiveRecordLike {
  id: string;
  touched: boolean;
}

/** The four structure types whose diff is a single flat list of candidates
 * against a single flat list of live records (metric, review, list item,
 * opinion statement) — questions and todos build their pending items by
 * hand above, since they also carry `resolution`/`completion` candidates
 * with no positional-diff step at all. */
function buildItemsForSimpleStructure<C extends { confidence: Confidence; confidenceReason: string | null }, L extends LiveRecordLike>(args: {
  entryId: string;
  processRunId: string;
  now: string;
  structureType: CreatePendingItemInput['structureType'];
  candidates: readonly C[];
  live: readonly L[];
  differs: (before: L, after: C) => boolean;
  category: (candidate: C) => string;
  payload: (candidate: C) => Record<string, unknown>;
}): CreatePendingItemInput[] {
  const { newCandidates, updates } = diffCandidates(
    args.candidates,
    args.live.filter((r) => r.touched),
    args.live.filter((r) => !r.touched),
    (l) => l.id,
    args.differs,
  );

  const items: CreatePendingItemInput[] = [];
  for (const candidate of newCandidates) {
    items.push(
      pendingItem({
        entryId: args.entryId,
        processRunId: args.processRunId,
        now: args.now,
        structureType: args.structureType,
        kind: 'new',
        targetRecordId: null,
        category: args.category(candidate),
        payload: args.payload(candidate),
        confidence: candidate.confidence,
        reason: candidate.confidenceReason,
      }),
    );
  }
  for (const { targetId, candidate } of updates) {
    items.push(
      pendingItem({
        entryId: args.entryId,
        processRunId: args.processRunId,
        now: args.now,
        structureType: args.structureType,
        kind: 'update',
        targetRecordId: targetId,
        category: args.category(candidate),
        payload: args.payload(candidate),
        confidence: candidate.confidence,
        reason: candidate.confidenceReason,
      }),
    );
  }
  return items;
}

function pendingItem(args: {
  entryId: string;
  processRunId: string;
  now: string;
  structureType: CreatePendingItemInput['structureType'];
  kind: CreatePendingItemInput['kind'];
  targetRecordId: string | null;
  category: string | null;
  payload: Record<string, unknown>;
  confidence: Confidence;
  reason: string | null;
}): CreatePendingItemInput {
  return {
    id: ulid(Date.now()),
    entryId: args.entryId,
    processRunId: args.processRunId,
    structureType: args.structureType,
    kind: args.kind,
    targetRecordId: args.targetRecordId,
    category: args.category,
    payload: args.payload,
    confidence: args.confidence,
    reason: args.reason,
    createdAt: args.now,
  };
}
