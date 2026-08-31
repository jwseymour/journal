import type { ListsIndex } from '../index/lists-index.js';
import type { MetricsIndex } from '../index/metrics-index.js';
import type { OpinionStatementsIndex } from '../index/opinion-statements-index.js';
import type { PendingExtractionItem } from '../index/pending-items-index.js';
import type { QuestionsIndex } from '../index/questions-index.js';
import type { ReviewsIndex } from '../index/reviews-index.js';
import type { TodosIndex } from '../index/todos-index.js';
import type { TouchedMirror } from '../durable/touched-mirror.js';
import { ulid } from '../record/id.js';
import type { OpinionSummarizer } from './opinion-summarizer.js';

/** The seam `http/app.ts` depends on — same shape as `MetricsReader` and
 * every other `*Reader` interface: a plain interface, not the class itself,
 * is what lets an HTTP test fake it. */
export interface PendingItemApplying {
  apply(item: PendingExtractionItem, now: string): Promise<void>;
}

/**
 * Turns one approved `PendingExtractionItem` into a real change to the
 * target structure (`plan.md` M18) — the only place that translates the
 * generic pending table into an actual `MetricsIndex`/`ReviewsIndex`/etc.
 * call. Called by `POST /pending-items/:id/approve` and
 * `POST /pending-items/approve-batch` in `http/app.ts`, after
 * `PendingItemsIndex.decide()` has already flipped the row to `'approved'`
 * — this class never decides anything, only applies a decision already
 * made.
 *
 * `'new'` commits with `touched: false` — approving in a batch means "this
 * is now real," not "I individually verified this fact" (confirmed with the
 * user at M18's planning; see `MetricsIndex.insertApproved`'s own comment).
 * `'update'`/`'resolution'`/`'completion'` target an existing record and
 * force `touched: true`, exactly like today's `decideUpdate`/
 * `decideCompletion` approve branches — approving a change to something
 * that already exists is itself a review act, unchanged reasoning from
 * before M18.
 *
 * Publishing (`default_public` categories publishing immediately on
 * approve, `always_private` refusing even if asked) is **not** this
 * class's job in M18 — that lands in M19 alongside the three-state
 * visibility model. Nothing here calls `Publisher` at all yet.
 */
export class PendingItemApplier implements PendingItemApplying {
  constructor(
    private readonly metricsIndex: MetricsIndex,
    private readonly reviewsIndex: ReviewsIndex,
    private readonly listsIndex: ListsIndex,
    private readonly opinionStatementsIndex: OpinionStatementsIndex,
    private readonly opinionSummarizer: OpinionSummarizer,
    private readonly questionsIndex: QuestionsIndex,
    private readonly todosIndex: TodosIndex,
    private readonly touchedMirror: TouchedMirror,
  ) {}

  async apply(item: PendingExtractionItem, now: string): Promise<void> {
    switch (item.structureType) {
      case 'metric':
        await this.#applyMetric(item, now);
        return;
      case 'review':
        await this.#applyReview(item, now);
        return;
      case 'list_item':
        await this.#applyListItem(item, now);
        return;
      case 'opinion_statement':
        await this.#applyOpinionStatement(item, now);
        return;
      case 'question':
        await this.#applyQuestion(item, now);
        return;
      case 'todo':
        await this.#applyTodo(item, now);
        return;
    }
  }

  async #applyMetric(item: PendingExtractionItem, now: string): Promise<void> {
    const payload = item.payload as {
      metric: string;
      eventTime: string;
      eventTimeExplicit: boolean;
      detail: string;
      fields: Record<string, string | number | null>;
    };
    if (item.kind === 'new') {
      this.metricsIndex.insertApproved({
        id: ulid(Date.now()),
        entryId: item.entryId,
        metric: payload.metric,
        eventTime: payload.eventTime,
        eventEpochMs: Date.parse(payload.eventTime),
        eventTimeExplicit: payload.eventTimeExplicit,
        detail: payload.detail,
        fields: payload.fields,
        extractedAt: now,
        touched: false,
      });
      return;
    }
    // 'update' — the only other kind a metric candidate ever produces.
    this.metricsIndex.update(
      item.targetRecordId!,
      { detail: payload.detail, fields: payload.fields, eventTime: payload.eventTime, eventTimeExplicit: payload.eventTimeExplicit },
      now,
    );
    await this.touchedMirror.sync('metric', item.targetRecordId!);
  }

  async #applyReview(item: PendingExtractionItem, now: string): Promise<void> {
    const payload = item.payload as {
      title: string;
      medium: string;
      rating: number | null;
      progress: number | null;
      opinion: string;
      eventTime: string;
      eventTimeExplicit: boolean;
    };
    if (item.kind === 'new') {
      this.reviewsIndex.insertApproved({
        id: ulid(Date.now()),
        entryId: item.entryId,
        title: payload.title,
        medium: payload.medium,
        rating: payload.rating,
        progress: payload.progress,
        opinion: payload.opinion,
        eventTime: payload.eventTime,
        eventEpochMs: Date.parse(payload.eventTime),
        eventTimeExplicit: payload.eventTimeExplicit,
        extractedAt: now,
        touched: false,
      });
      return;
    }
    this.reviewsIndex.update(
      item.targetRecordId!,
      {
        title: payload.title,
        rating: payload.rating,
        progress: payload.progress,
        opinion: payload.opinion,
        eventTime: payload.eventTime,
        eventTimeExplicit: payload.eventTimeExplicit,
      },
      now,
    );
    await this.touchedMirror.sync('review', item.targetRecordId!);
  }

  async #applyListItem(item: PendingExtractionItem, now: string): Promise<void> {
    const payload = item.payload as {
      listType: string;
      text: string;
      context: string;
      importance: number | null;
      eventTime: string;
      eventTimeExplicit: boolean;
    };
    if (item.kind === 'new') {
      this.listsIndex.insertApproved({
        id: ulid(Date.now()),
        entryId: item.entryId,
        listType: payload.listType,
        text: payload.text,
        context: payload.context,
        importance: payload.importance,
        eventTime: payload.eventTime,
        eventEpochMs: Date.parse(payload.eventTime),
        eventTimeExplicit: payload.eventTimeExplicit,
        extractedAt: now,
        touched: false,
      });
      return;
    }
    this.listsIndex.update(
      item.targetRecordId!,
      { text: payload.text, context: payload.context, importance: payload.importance, eventTime: payload.eventTime, eventTimeExplicit: payload.eventTimeExplicit },
      now,
    );
    await this.touchedMirror.sync('list_item', item.targetRecordId!);
  }

  async #applyOpinionStatement(item: PendingExtractionItem, now: string): Promise<void> {
    if (item.kind === 'resolution') {
      // The conversation-topics extension (`requirements.md` §11, resolved
      // 2026-08-30) — same shape as `#applyQuestion`'s 'resolution' branch.
      const payload = item.payload as { resolution: string };
      this.opinionStatementsIndex.resolveApproved(item.targetRecordId!, {
        resolvedEntryId: item.entryId,
        resolution: payload.resolution,
        resolvedAt: now,
      });
      await this.touchedMirror.sync('opinion_statement', item.targetRecordId!);
      // The resolved record's own subject — a 'resolution' item's payload
      // carries no `subject` of its own (unlike 'new'/'update'), so this is
      // read back off the row just written to, the same as `#applyQuestion`
      // has no equivalent need to (questions have no subject to re-summarize).
      const resolved = this.opinionStatementsIndex.getById(item.targetRecordId!);
      if (resolved) await this.opinionSummarizer.summarizeSubject(resolved.subject);
      return;
    }

    const payload = item.payload as {
      subject: string;
      statement: string;
      kind: 'note' | 'question';
      eventTime: string;
      eventTimeExplicit: boolean;
    };
    if (item.kind === 'new') {
      this.opinionStatementsIndex.insertApproved({
        id: ulid(Date.now()),
        entryId: item.entryId,
        subject: payload.subject,
        statement: payload.statement,
        kind: payload.kind,
        status: payload.kind === 'question' ? 'open' : null,
        resolvedEntryId: null,
        resolution: null,
        resolvedAt: null,
        eventTime: payload.eventTime,
        eventEpochMs: Date.parse(payload.eventTime),
        eventTimeExplicit: payload.eventTimeExplicit,
        extractedAt: now,
        touched: false,
      });
    } else {
      this.opinionStatementsIndex.update(
        item.targetRecordId!,
        { statement: payload.statement, eventTime: payload.eventTime, eventTimeExplicit: payload.eventTimeExplicit },
        now,
      );
      await this.touchedMirror.sync('opinion_statement', item.targetRecordId!);
    }
    // A statement only ever exists in service of its subject's cited
    // summary (`opinion-statements-index.ts`'s own doc comment) — an
    // approved statement, new or updated, makes that summary stale.
    // Regenerating here, only for the one subject just approved, is what
    // keeps a summary from ever citing a still-pending, possibly-rejected
    // statement (`requirements.md` §5.2's "actually expressed" constraint) —
    // see `opinions-extractor.ts`'s own comment on why this moved out of
    // extraction time.
    await this.opinionSummarizer.summarizeSubject(payload.subject);
  }

  async #applyQuestion(item: PendingExtractionItem, now: string): Promise<void> {
    if (item.kind === 'new') {
      const payload = item.payload as { question: string; eventTime: string; eventTimeExplicit: boolean };
      this.questionsIndex.insertApproved({
        id: ulid(Date.now()),
        entryId: item.entryId,
        question: payload.question,
        eventTime: payload.eventTime,
        eventEpochMs: Date.parse(payload.eventTime),
        eventTimeExplicit: payload.eventTimeExplicit,
        extractedAt: now,
        status: 'open',
        resolvedEntryId: null,
        resolution: null,
        resolvedAt: null,
        touched: false,
      });
      return;
    }
    if (item.kind === 'update') {
      const payload = item.payload as { question: string; eventTime: string; eventTimeExplicit: boolean };
      this.questionsIndex.update(item.targetRecordId!, { question: payload.question, eventTime: payload.eventTime, eventTimeExplicit: payload.eventTimeExplicit }, now);
      await this.touchedMirror.sync('question', item.targetRecordId!);
      return;
    }
    // 'resolution' — the only remaining kind a question candidate produces.
    const payload = item.payload as { resolution: string };
    this.questionsIndex.resolveApproved(item.targetRecordId!, { resolvedEntryId: item.entryId, resolution: payload.resolution, resolvedAt: now });
    await this.touchedMirror.sync('question', item.targetRecordId!);
  }

  async #applyTodo(item: PendingExtractionItem, now: string): Promise<void> {
    if (item.kind === 'new') {
      const payload = item.payload as { text: string; eventTime: string; eventTimeExplicit: boolean };
      this.todosIndex.insertApproved({
        id: ulid(Date.now()),
        entryId: item.entryId,
        text: payload.text,
        eventTime: payload.eventTime,
        eventEpochMs: Date.parse(payload.eventTime),
        eventTimeExplicit: payload.eventTimeExplicit,
        extractedAt: now,
        status: 'open',
        doneEntryId: null,
        resolution: null,
        doneAt: null,
        origin: 'extracted',
        touched: false,
      });
      return;
    }
    if (item.kind === 'update') {
      const payload = item.payload as { text: string; eventTime: string; eventTimeExplicit: boolean };
      this.todosIndex.update(item.targetRecordId!, { text: payload.text, eventTime: payload.eventTime, eventTimeExplicit: payload.eventTimeExplicit }, now);
      await this.touchedMirror.sync('todo', item.targetRecordId!);
      return;
    }
    // 'completion' — the only remaining kind a todo candidate produces.
    const payload = item.payload as { resolution: string };
    this.todosIndex.completeApproved(item.targetRecordId!, { doneEntryId: item.entryId, resolution: payload.resolution, doneAt: now });
    await this.touchedMirror.sync('todo', item.targetRecordId!);
  }
}
