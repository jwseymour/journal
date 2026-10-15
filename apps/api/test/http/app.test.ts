import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  AddAttachmentResponse,
  ApiError,
  ApproveBatchResponse,
  CategoriesResponse,
  ChatMessage,
  ChatResponse,
  CreateDocumentResponse,
  CreateEntryResponse,
  Document,
  DocumentPage,
  Entry,
  EntryMediaResponse,
  EntryPage,
  EntryStatusResponse,
  HealthResponse,
  ListItem,
  ListItemsResponse,
  ListsSummaryResponse,
  MediaPage,
  MetricsResponse,
  MetricsSummaryResponse,
  MetricUpdateSuggestionsResponse,
  OpinionStatementsResponse,
  OpinionSubjectSummariesResponse,
  OpinionSummariesResponse,
  OpenQuestion,
  PendingItemsResponse,
  ProcessEntryResponse,
  PublishQueueResponse,
  QuestionsResponse,
  QuestionsSummaryResponse,
  Layout,
  LayoutsResponse,
  RawLayoutSpec,
  ResolvedLayout,
  Review,
  ReviewsResponse,
  ReviewsSummaryResponse,
  SearchHit,
  SearchResponse,
  StructureType,
  SuggestionsResponse,
  TemporalMetric,
  Todo,
  TodoCompletionSuggestionsResponse,
  TodosResponse,
  TodosSummaryResponse,
  TodoUpdateSuggestionsResponse,
  TranscribeResponse,
  UpdateDocumentResponse,
  UpdateEntryResponse,
  UploadMediaResponse,
  VisibilityDefaultsResponse,
} from '@journal/contract';
import type { Config } from '../../src/config.js';
import { chatFailed, extractionFailed, layoutCompileFailed, transcriptionFailed } from '../../src/errors.js';
import { TouchedMirror, type DurableBlobStore } from '../../src/durable/touched-mirror.js';
import { createApp } from '../../src/http/app.js';
import type { CategoriesReader, CategorySuggestion, SuggestionStatus } from '../../src/index/categories-index.js';
import type { EntryProcessingStatusReader, EntryProcessingStatusRow } from '../../src/index/entry-processing-status-index.js';
import type {
  ListItemRecord,
  ListItemsOptions,
  ListItemsReader,
  ListItemUpdateSuggestion,
  ListTypeSummary,
  UpdateListItemInput,
} from '../../src/index/lists-index.js';
import type {
  MetricFieldDefinition,
  MetricFieldSuggestion,
  MetricFieldsReader,
  UpdateFieldInput,
} from '../../src/index/metric-fields-index.js';
import type {
  ListMetricsOptions,
  MetricFieldSummary,
  MetricsReader,
  MetricSummary,
  MetricUpdateSuggestion,
  TemporalMetricRecord,
  UpdateMetricInput,
} from '../../src/index/metrics-index.js';
import type {
  ListOpinionStatementsOptions,
  OpinionStatementRecord,
  OpinionStatementsReader,
  OpinionStatementUpdateSuggestion,
  OpinionSubjectSummary,
  UpdateOpinionStatementInput,
} from '../../src/index/opinion-statements-index.js';
import type { OpinionSummariesReader, OpinionSummaryPartRecord } from '../../src/index/opinion-summaries-index.js';
import type {
  ListQuestionsOptions,
  QuestionRecord,
  QuestionsReader,
  QuestionsSummary,
  QuestionUpdateSuggestion,
  UpdateQuestionInput,
} from '../../src/index/questions-index.js';
import type {
  ListReviewsOptions,
  ReviewMediumHistogram,
  ReviewMediumSummary,
  ReviewRatingBucket,
  ReviewRecord,
  ReviewsReader,
  ReviewUpdateSuggestion,
  UpdateReviewInput,
} from '../../src/index/reviews-index.js';
import type {
  CreateDirectTodoInput,
  ListTodosOptions,
  TodoCompletionSuggestion,
  TodoRecord,
  TodosReader,
  TodosSummary,
  TodoUpdateSuggestion,
  UpdateTodoInput,
} from '../../src/index/todos-index.js';
import { DocumentsIndex } from '../../src/index/documents-index.js';
import { MediaIndex } from '../../src/index/media-index.js';
import type {
  CreatePendingItemInput,
  ListPendingItemsOptions,
  PendingExtractionItem,
  PendingItemsReader,
} from '../../src/index/pending-items-index.js';
import { PublicSearchIndex } from '../../src/index/public-search-index.js';
import { PublishedIndex } from '../../src/index/published-index.js';
import { SqliteIndex } from '../../src/index/sqlite-index.js';
import { VisibilityDefaultsIndex } from '../../src/index/visibility-defaults-index.js';
import { LayoutsIndex } from '../../src/index/layouts-index.js';
import { DurableLayoutStore, type LayoutBlobStore } from '../../src/store/layout-store.js';
import type { LayoutCompiling } from '../../src/layout/compile.js';
import type { ChatAnswerer } from '../../src/model/chat-orchestrator.js';
import type { PendingItemApplying } from '../../src/model/pending-item-applier.js';
import type { LivePendingProcessing } from '../../src/model/pending-processor.js';
import { createPublisher } from '../../src/publish/create-publisher.js';
import type { Searcher } from '../../src/search/searcher.js';
import { FsDocumentStore } from '../../src/store/fs-document-store.js';
import { FsEntryStore } from '../../src/store/fs-entry-store.js';
import { FsMediaStore } from '../../src/store/fs-media-store.js';
import type { Transcriber } from '../../src/transcribe/transcriber.js';

/**
 * A `Transcriber` that never loads a real model — HTTP tests exercise the
 * endpoint's own contract (validation, error shapes, wiring), not whether the
 * local speech-to-text model is accurate. The real implementation is verified
 * separately, live, against real synthetic speech — see the M4 write-up.
 *
 * On failure this throws the same `AppError` shape the real
 * `LocalTranscriber` throws, not a bare `Error` — the endpoint itself does no
 * error translation, so a fake that threw a plain `Error` here would only
 * prove the generic `internal` handler works, not this endpoint's own
 * `transcription_failed` mapping.
 */
class FakeTranscriber implements Transcriber {
  calls: Array<{ samples: Float32Array; sampleRate: number }> = [];
  result: string | 'FAIL' = 'fake transcript';

  async transcribe(samples: Float32Array, sampleRate: number): Promise<string> {
    this.calls.push({ samples, sampleRate });
    if (this.result === 'FAIL') throw transcriptionFailed('model exploded');
    return this.result;
  }
}

/**
 * Same reasoning as `FakeTranscriber`: HTTP tests exercise `/search`'s own
 * contract (validation, limit clamping, response shape), not whether BM25
 * and vector fusion actually rank well — that is `search-index.test.ts` and
 * `searcher.test.ts`'s job.
 */
class FakeSearcher implements Searcher {
  calls: Array<{ query: string; limit: number }> = [];
  hits: SearchHit[] = [];

  async search(query: string, limit: number): Promise<SearchHit[]> {
    this.calls.push({ query, limit });
    return this.hits;
  }
}

/**
 * Same reasoning again: HTTP tests exercise `/metrics`'s own contract, not
 * extraction quality or the real gateway — that is `extractor.test.ts` and
 * a live drill's job (`plan.md` M7).
 */
class FakeMetricsReader implements MetricsReader {
  listCalls: ListMetricsOptions[] = [];
  removeCalls: string[] = [];
  summarizeCalls: Array<{ approvedNames: readonly string[]; windowDays: number }> = [];
  summaries: MetricSummary[] = [];
  records: TemporalMetricRecord[] = [];

  list(options: ListMetricsOptions): TemporalMetricRecord[] {
    this.listCalls.push(options);
    const filtered = options.metric ? this.records.filter((r) => r.metric === options.metric) : this.records;
    return filtered.slice(0, options.limit);
  }

  remove(id: string): void {
    this.removeCalls.push(id);
    this.records = this.records.filter((r) => r.id !== id);
  }

  getById(id: string): TemporalMetricRecord | null {
    return this.records.find((r) => r.id === id) ?? null;
  }

  allByMetric(metric: string): TemporalMetricRecord[] {
    return this.records.filter((r) => r.metric === metric);
  }

  summarize(approvedNames: readonly string[], windowDays: number): MetricSummary[] {
    this.summarizeCalls.push({ approvedNames, windowDays });
    return this.summaries;
  }

  sumByFieldCalls: Array<{ metric: string; fieldKey: string; windowDays: number; filter?: { field: string; value: string } }> = [];
  fieldSummary: MetricFieldSummary = { total: 0, average: 0, count: 0, days: [] };

  sumByField(
    metric: string,
    fieldKey: string,
    windowDays: number,
    filter?: { field: string; value: string },
  ): MetricFieldSummary {
    this.sumByFieldCalls.push({ metric, fieldKey, windowDays, ...(filter ? { filter } : {}) });
    return this.fieldSummary;
  }

  updateSuggestions: MetricUpdateSuggestion[] = [];

  update(id: string, input: UpdateMetricInput): TemporalMetricRecord | null {
    const existing = this.records.find((r) => r.id === id);
    if (!existing) return null;
    const updated: TemporalMetricRecord = {
      ...existing,
      ...(input.detail !== undefined ? { detail: input.detail } : {}),
      ...(input.fields !== undefined ? { fields: input.fields } : {}),
      ...(input.eventTime !== undefined ? { eventTime: input.eventTime } : {}),
      ...(input.eventTimeExplicit !== undefined ? { eventTimeExplicit: input.eventTimeExplicit } : {}),
      touched: true,
    };
    this.records = this.records.map((r) => (r.id === id ? updated : r));
    return updated;
  }

  liveForEntry(entryId: string): TemporalMetricRecord[] {
    return this.records.filter((r) => r.entryId === entryId);
  }

  insertApproved(record: TemporalMetricRecord): void {
    this.records = [...this.records, record];
  }

  validate(id: string): void {
    this.records = this.records.map((r) => (r.id === id ? { ...r, touched: true } : r));
  }

  untouch(id: string): void {
    this.records = this.records.map((r) => (r.id === id ? { ...r, touched: false } : r));
  }

  listUpdateSuggestions(options: { status?: MetricUpdateSuggestion['status'] } = {}): MetricUpdateSuggestion[] {
    return this.updateSuggestions.filter((s) => !options.status || s.status === options.status);
  }

  decideUpdate(id: string, decision: 'approved' | 'rejected'): void {
    this.updateSuggestions = this.updateSuggestions.map((s) => (s.id === id ? { ...s, status: decision } : s));
  }

  /** The `restoreTouched` half of `durable/touched-mirror.ts`'s `Backing<T>`
   * — an upsert, matching the real `MetricsIndex.restoreTouched`. */
  restoreTouched(record: TemporalMetricRecord): void {
    this.records = this.records.some((r) => r.id === record.id)
      ? this.records.map((r) => (r.id === record.id ? record : r))
      : [...this.records, record];
  }
}

/** Same reasoning again, for `/metrics/fields`. */
class FakeMetricFieldsReader implements MetricFieldsReader {
  listForMetricCalls: string[] = [];
  listSuggestionsCalls: Array<{ metric?: string; status?: string }> = [];
  defineCalls: Array<{ id: string; metric: string; fieldKey: string; now: string }> = [];
  removeCalls: string[] = [];
  decideCalls: Array<{ id: string; decision: 'approved' | 'rejected' }> = [];
  fields: MetricFieldDefinition[] = [];
  suggestions: MetricFieldSuggestion[] = [];

  listForMetric(metric: string): MetricFieldDefinition[] {
    this.listForMetricCalls.push(metric);
    return this.fields.filter((f) => f.metric === metric);
  }

  listAll(): MetricFieldDefinition[] {
    return this.fields;
  }

  get(id: string): MetricFieldDefinition | null {
    return this.fields.find((f) => f.id === id) ?? null;
  }

  define(input: { id: string; metric: string; fieldKey: string; label: string; fieldType: MetricFieldDefinition['fieldType']; unit: string | null; scoreMin: number | null; scoreMax: number | null; description: string; now: string }): void {
    this.defineCalls.push({ id: input.id, metric: input.metric, fieldKey: input.fieldKey, now: input.now });
    if (!this.fields.some((f) => f.metric === input.metric && f.fieldKey === input.fieldKey)) {
      this.fields.push({
        id: input.id,
        metric: input.metric,
        fieldKey: input.fieldKey,
        label: input.label,
        fieldType: input.fieldType,
        unit: input.unit,
        scoreMin: input.scoreMin,
        scoreMax: input.scoreMax,
        description: input.description,
        createdAt: input.now,
      });
    }
  }

  update(id: string, input: UpdateFieldInput): MetricFieldDefinition | null {
    const existing = this.fields.find((f) => f.id === id);
    if (!existing) return null;
    const updated: MetricFieldDefinition = {
      ...existing,
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.unit !== undefined ? { unit: input.unit } : {}),
      ...(input.scoreMin !== undefined ? { scoreMin: input.scoreMin } : {}),
      ...(input.scoreMax !== undefined ? { scoreMax: input.scoreMax } : {}),
    };
    this.fields = this.fields.map((f) => (f.id === id ? updated : f));
    return updated;
  }

  remove(id: string): void {
    this.removeCalls.push(id);
    this.fields = this.fields.filter((f) => f.id !== id);
  }

  listSuggestions(options: { metric?: string; status?: MetricFieldSuggestion['status'] } = {}): MetricFieldSuggestion[] {
    this.listSuggestionsCalls.push(options);
    return this.suggestions.filter(
      (s) => (!options.metric || s.metric === options.metric) && (!options.status || s.status === options.status),
    );
  }

  decide(id: string, decision: 'approved' | 'rejected'): void {
    this.decideCalls.push({ id, decision });
    this.suggestions = this.suggestions.map((s) => (s.id === id ? { ...s, status: decision } : s));
  }
}

/** Same reasoning again, for `/reviews`. */
class FakeReviewsReader implements ReviewsReader {
  listCalls: ListReviewsOptions[] = [];
  removeCalls: string[] = [];
  summarizeCalls: Array<readonly string[]> = [];
  summaries: ReviewMediumSummary[] = [];
  records: ReviewRecord[] = [];

  list(options: ListReviewsOptions): ReviewRecord[] {
    this.listCalls.push(options);
    const filtered = options.medium ? this.records.filter((r) => r.medium === options.medium) : this.records;
    return filtered.slice(0, options.limit);
  }

  remove(id: string): void {
    this.removeCalls.push(id);
    this.records = this.records.filter((r) => r.id !== id);
  }

  getById(id: string): ReviewRecord | null {
    return this.records.find((r) => r.id === id) ?? null;
  }

  allByMedium(medium: string): ReviewRecord[] {
    return this.records.filter((r) => r.medium === medium);
  }

  summarize(approvedMedia: readonly string[]): ReviewMediumSummary[] {
    this.summarizeCalls.push(approvedMedia);
    return this.summaries;
  }

  histogramCalls: Array<readonly string[]> = [];
  histogramResult: { overall: ReviewRatingBucket[]; byMedium: ReviewMediumHistogram[] } = { overall: [], byMedium: [] };

  histogram(approvedMedia: readonly string[]): { overall: ReviewRatingBucket[]; byMedium: ReviewMediumHistogram[] } {
    this.histogramCalls.push(approvedMedia);
    return this.histogramResult;
  }

  updateSuggestions: ReviewUpdateSuggestion[] = [];

  update(id: string, input: UpdateReviewInput): ReviewRecord | null {
    const existing = this.records.find((r) => r.id === id);
    if (!existing) return null;
    const updated: ReviewRecord = {
      ...existing,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.rating !== undefined ? { rating: input.rating } : {}),
      ...(input.progress !== undefined ? { progress: input.progress } : {}),
      ...(input.opinion !== undefined ? { opinion: input.opinion } : {}),
      ...(input.eventTime !== undefined ? { eventTime: input.eventTime } : {}),
      ...(input.eventTimeExplicit !== undefined ? { eventTimeExplicit: input.eventTimeExplicit } : {}),
      touched: true,
    };
    this.records = this.records.map((r) => (r.id === id ? updated : r));
    return updated;
  }

  liveForEntry(entryId: string): ReviewRecord[] {
    return this.records.filter((r) => r.entryId === entryId);
  }

  insertApproved(record: ReviewRecord): void {
    this.records = [...this.records, record];
  }

  validate(id: string): void {
    this.records = this.records.map((r) => (r.id === id ? { ...r, touched: true } : r));
  }

  untouch(id: string): void {
    this.records = this.records.map((r) => (r.id === id ? { ...r, touched: false } : r));
  }

  listUpdateSuggestions(options: { status?: ReviewUpdateSuggestion['status'] } = {}): ReviewUpdateSuggestion[] {
    return this.updateSuggestions.filter((s) => !options.status || s.status === options.status);
  }

  decideUpdate(id: string, decision: 'approved' | 'rejected'): void {
    this.updateSuggestions = this.updateSuggestions.map((s) => (s.id === id ? { ...s, status: decision } : s));
  }

  /** See `FakeMetricsReader.restoreTouched`. */
  restoreTouched(record: ReviewRecord): void {
    this.records = this.records.some((r) => r.id === record.id)
      ? this.records.map((r) => (r.id === record.id ? record : r))
      : [...this.records, record];
  }
}

/** Same reasoning again, for `/lists`. */
class FakeListItemsReader implements ListItemsReader {
  listCalls: ListItemsOptions[] = [];
  removeCalls: string[] = [];
  summarizeCalls: Array<readonly string[]> = [];
  summaries: ListTypeSummary[] = [];
  records: ListItemRecord[] = [];

  list(options: ListItemsOptions): ListItemRecord[] {
    this.listCalls.push(options);
    const filtered = options.listType ? this.records.filter((r) => r.listType === options.listType) : this.records;
    return filtered.slice(0, options.limit);
  }

  remove(id: string): void {
    this.removeCalls.push(id);
    this.records = this.records.filter((r) => r.id !== id);
  }

  getById(id: string): ListItemRecord | null {
    return this.records.find((r) => r.id === id) ?? null;
  }

  allByListType(listType: string): ListItemRecord[] {
    return this.records.filter((r) => r.listType === listType);
  }

  summarize(approvedTypes: readonly string[]): ListTypeSummary[] {
    this.summarizeCalls.push(approvedTypes);
    return this.summaries;
  }

  updateSuggestions: ListItemUpdateSuggestion[] = [];

  update(id: string, input: UpdateListItemInput): ListItemRecord | null {
    const existing = this.records.find((r) => r.id === id);
    if (!existing) return null;
    const updated: ListItemRecord = {
      ...existing,
      ...(input.text !== undefined ? { text: input.text } : {}),
      ...(input.context !== undefined ? { context: input.context } : {}),
      ...(input.importance !== undefined ? { importance: input.importance } : {}),
      ...(input.eventTime !== undefined ? { eventTime: input.eventTime } : {}),
      ...(input.eventTimeExplicit !== undefined ? { eventTimeExplicit: input.eventTimeExplicit } : {}),
      touched: true,
    };
    this.records = this.records.map((r) => (r.id === id ? updated : r));
    return updated;
  }

  liveForEntry(entryId: string): ListItemRecord[] {
    return this.records.filter((r) => r.entryId === entryId);
  }

  insertApproved(record: ListItemRecord): void {
    this.records = [...this.records, record];
  }

  validate(id: string): void {
    this.records = this.records.map((r) => (r.id === id ? { ...r, touched: true } : r));
  }

  untouch(id: string): void {
    this.records = this.records.map((r) => (r.id === id ? { ...r, touched: false } : r));
  }

  listUpdateSuggestions(options: { status?: ListItemUpdateSuggestion['status'] } = {}): ListItemUpdateSuggestion[] {
    return this.updateSuggestions.filter((s) => !options.status || s.status === options.status);
  }

  decideUpdate(id: string, decision: 'approved' | 'rejected'): void {
    this.updateSuggestions = this.updateSuggestions.map((s) => (s.id === id ? { ...s, status: decision } : s));
  }

  /** See `FakeMetricsReader.restoreTouched`. */
  restoreTouched(record: ListItemRecord): void {
    this.records = this.records.some((r) => r.id === record.id)
      ? this.records.map((r) => (r.id === record.id ? record : r))
      : [...this.records, record];
  }
}

/** Same reasoning again, for `/categories`. */
class FakeCategoriesReader implements CategoriesReader {
  approved: Partial<Record<StructureType, string[]>> = { metric: [], review_medium: [], list_type: [], opinion_subject: [] };
  suggestions: CategorySuggestion[] = [];
  approveCalls: Array<{ structureType: StructureType; name: string }> = [];
  decideCalls: Array<{ id: string; decision: 'approved' | 'rejected' }> = [];

  approvedNames(structureType: StructureType): string[] {
    return this.approved[structureType] ?? [];
  }

  approveDirectly(structureType: StructureType, name: string): void {
    this.approveCalls.push({ structureType, name });
    const current = this.approved[structureType] ?? [];
    if (!current.includes(name)) this.approved[structureType] = [...current, name];
  }

  listSuggestions(options: { structureType?: StructureType; status?: SuggestionStatus } = {}): CategorySuggestion[] {
    return this.suggestions.filter(
      (s) =>
        (!options.structureType || s.structureType === options.structureType) &&
        (!options.status || s.status === options.status),
    );
  }

  decide(id: string, decision: 'approved' | 'rejected'): void {
    this.decideCalls.push({ id, decision });
    this.suggestions = this.suggestions.map((s) => (s.id === id ? { ...s, status: decision } : s));
  }
}

/** Same reasoning again, for `/opinions/statements`. */
class FakeOpinionStatementsReader implements OpinionStatementsReader {
  listCalls: ListOpinionStatementsOptions[] = [];
  removeCalls: string[] = [];
  records: OpinionStatementRecord[] = [];

  list(options: ListOpinionStatementsOptions): OpinionStatementRecord[] {
    this.listCalls.push(options);
    const filtered = options.subject ? this.records.filter((r) => r.subject === options.subject) : this.records;
    return filtered.slice(0, options.limit);
  }

  remove(id: string): void {
    this.removeCalls.push(id);
    this.records = this.records.filter((r) => r.id !== id);
  }

  getById(id: string): OpinionStatementRecord | null {
    return this.records.find((r) => r.id === id) ?? null;
  }

  bySubject(subject: string): OpinionStatementRecord[] {
    return this.records.filter((r) => r.subject === subject);
  }

  listOpenQuestions(): OpinionStatementRecord[] {
    return this.records.filter((r) => r.kind === 'question' && r.status === 'open');
  }

  resolveCalls: Array<{ id: string; resolvedEntryId: string; resolution: string; resolvedAt: string }> = [];

  resolve(id: string, input: { resolvedEntryId: string; resolution: string; resolvedAt: string }): void {
    this.resolveCalls.push({ id, ...input });
    this.records = this.records.map((r) =>
      r.id === id && r.kind === 'question' && r.status === 'open' && !r.touched
        ? { ...r, status: 'resolved', resolvedEntryId: input.resolvedEntryId, resolution: input.resolution, resolvedAt: input.resolvedAt }
        : r,
    );
  }

  resolveApprovedCalls: Array<{ id: string; resolvedEntryId: string; resolution: string; resolvedAt: string }> = [];

  resolveApproved(id: string, input: { resolvedEntryId: string; resolution: string; resolvedAt: string }): void {
    this.resolveApprovedCalls.push({ id, ...input });
    this.records = this.records.map((r) =>
      r.id === id && r.kind === 'question' && r.status === 'open'
        ? { ...r, status: 'resolved', resolvedEntryId: input.resolvedEntryId, resolution: input.resolution, resolvedAt: input.resolvedAt, touched: true }
        : r,
    );
  }

  reopenCalls: string[] = [];

  reopen(id: string): void {
    this.reopenCalls.push(id);
    this.records = this.records.map((r) =>
      r.id === id && r.kind === 'question' && r.status === 'resolved'
        ? { ...r, status: 'open', resolvedEntryId: null, resolution: null, resolvedAt: null, touched: true }
        : r,
    );
  }

  summarizeCalls: Array<readonly string[]> = [];
  summaries: OpinionSubjectSummary[] = [];

  summarize(approvedSubjects: readonly string[]): OpinionSubjectSummary[] {
    this.summarizeCalls.push(approvedSubjects);
    return this.summaries;
  }

  updateSuggestions: OpinionStatementUpdateSuggestion[] = [];

  update(id: string, input: UpdateOpinionStatementInput): OpinionStatementRecord | null {
    const existing = this.records.find((r) => r.id === id);
    if (!existing) return null;
    const updated: OpinionStatementRecord = {
      ...existing,
      ...(input.statement !== undefined ? { statement: input.statement } : {}),
      ...(input.eventTime !== undefined ? { eventTime: input.eventTime } : {}),
      ...(input.eventTimeExplicit !== undefined ? { eventTimeExplicit: input.eventTimeExplicit } : {}),
      touched: true,
    };
    this.records = this.records.map((r) => (r.id === id ? updated : r));
    return updated;
  }

  liveForEntry(entryId: string): OpinionStatementRecord[] {
    return this.records.filter((r) => r.entryId === entryId);
  }

  insertApproved(record: OpinionStatementRecord): void {
    this.records = [...this.records, record];
  }

  validate(id: string): void {
    this.records = this.records.map((r) => (r.id === id ? { ...r, touched: true } : r));
  }

  untouch(id: string): void {
    this.records = this.records.map((r) => (r.id === id ? { ...r, touched: false } : r));
  }

  listUpdateSuggestions(
    options: { status?: OpinionStatementUpdateSuggestion['status'] } = {},
  ): OpinionStatementUpdateSuggestion[] {
    return this.updateSuggestions.filter((s) => !options.status || s.status === options.status);
  }

  decideUpdate(id: string, decision: 'approved' | 'rejected'): void {
    this.updateSuggestions = this.updateSuggestions.map((s) => (s.id === id ? { ...s, status: decision } : s));
  }

  /** See `FakeMetricsReader.restoreTouched`. */
  restoreTouched(record: OpinionStatementRecord): void {
    this.records = this.records.some((r) => r.id === record.id)
      ? this.records.map((r) => (r.id === record.id ? record : r))
      : [...this.records, record];
  }
}

/** Same reasoning again, for `/opinions/summaries`. */
class FakeOpinionSummariesReader implements OpinionSummariesReader {
  listCalls: Array<string | undefined> = [];
  parts: OpinionSummaryPartRecord[] = [];

  list(subject?: string): OpinionSummaryPartRecord[] {
    this.listCalls.push(subject);
    return subject ? this.parts.filter((p) => p.subject === subject) : this.parts;
  }

  subjects(): string[] {
    return [...new Set(this.parts.map((p) => p.subject))];
  }
}

/** Same reasoning again, for `/questions`. */
class FakeQuestionsReader implements QuestionsReader {
  listCalls: ListQuestionsOptions[] = [];
  removeCalls: string[] = [];
  reopenCalls: string[] = [];
  summary: QuestionsSummary = { openCount: 0, resolvedCount: 0 };
  records: QuestionRecord[] = [];

  list(options: ListQuestionsOptions): QuestionRecord[] {
    this.listCalls.push(options);
    const filtered = options.status ? this.records.filter((r) => r.status === options.status) : this.records;
    return filtered.slice(0, options.limit);
  }

  remove(id: string): void {
    this.removeCalls.push(id);
    this.records = this.records.filter((r) => r.id !== id);
  }

  getById(id: string): QuestionRecord | null {
    return this.records.find((r) => r.id === id) ?? null;
  }

  reopen(id: string): void {
    this.reopenCalls.push(id);
    this.records = this.records.map((r) =>
      r.id === id ? { ...r, status: 'open', resolvedEntryId: null, resolution: null, resolvedAt: null } : r,
    );
  }

  summarize(): QuestionsSummary {
    return this.summary;
  }

  updateSuggestions: QuestionUpdateSuggestion[] = [];

  update(id: string, input: UpdateQuestionInput): QuestionRecord | null {
    const existing = this.records.find((r) => r.id === id);
    if (!existing) return null;
    const updated: QuestionRecord = {
      ...existing,
      ...(input.question !== undefined ? { question: input.question } : {}),
      ...(input.eventTime !== undefined ? { eventTime: input.eventTime } : {}),
      ...(input.eventTimeExplicit !== undefined ? { eventTimeExplicit: input.eventTimeExplicit } : {}),
      touched: true,
    };
    this.records = this.records.map((r) => (r.id === id ? updated : r));
    return updated;
  }

  validate(id: string): void {
    this.records = this.records.map((r) => (r.id === id ? { ...r, touched: true } : r));
  }

  untouch(id: string): void {
    this.records = this.records.map((r) => (r.id === id ? { ...r, touched: false } : r));
  }

  listUpdateSuggestions(options: { status?: QuestionUpdateSuggestion['status'] } = {}): QuestionUpdateSuggestion[] {
    return this.updateSuggestions.filter((s) => !options.status || s.status === options.status);
  }

  decideUpdate(id: string, decision: 'approved' | 'rejected'): void {
    this.updateSuggestions = this.updateSuggestions.map((s) => (s.id === id ? { ...s, status: decision } : s));
  }

  /** See `FakeMetricsReader.restoreTouched`. */
  restoreTouched(record: QuestionRecord): void {
    this.records = this.records.some((r) => r.id === record.id)
      ? this.records.map((r) => (r.id === record.id ? record : r))
      : [...this.records, record];
  }

  openRaisedBy(entryId: string): QuestionRecord[] {
    return this.records.filter((r) => r.entryId === entryId && r.status === 'open');
  }

  insertApproved(record: QuestionRecord): void {
    this.records = [...this.records, record];
  }

  resolveApprovedCalls: Array<{ id: string; resolvedEntryId: string; resolution: string; resolvedAt: string }> = [];

  resolveApproved(id: string, resolution: { resolvedEntryId: string; resolution: string; resolvedAt: string }): void {
    this.resolveApprovedCalls.push({ id, ...resolution });
    this.records = this.records.map((r) =>
      r.id === id && r.status === 'open'
        ? { ...r, status: 'resolved', resolvedEntryId: resolution.resolvedEntryId, resolution: resolution.resolution, resolvedAt: resolution.resolvedAt, touched: true }
        : r,
    );
  }
}

/** Same reasoning again, for `/todos`. Closest to `FakeQuestionsReader`,
 * plus fakes for the two genuinely new mechanisms (`plan.md` M15):
 * `createDirect` and `completeDirect`. `untouch` mirrors the real
 * `TodosIndex`'s new guard — a no-op for an `origin: 'user'` record. */
class FakeTodosReader implements TodosReader {
  listCalls: ListTodosOptions[] = [];
  removeCalls: string[] = [];
  reopenCalls: string[] = [];
  completeDirectCalls: string[] = [];
  createDirectCalls: CreateDirectTodoInput[] = [];
  summary: TodosSummary = { openCount: 0, doneCount: 0 };
  records: TodoRecord[] = [];

  list(options: ListTodosOptions): TodoRecord[] {
    this.listCalls.push(options);
    const filtered = options.status ? this.records.filter((r) => r.status === options.status) : this.records;
    return filtered.slice(0, options.limit);
  }

  getById(id: string): TodoRecord | null {
    return this.records.find((r) => r.id === id) ?? null;
  }

  createDirect(input: CreateDirectTodoInput): TodoRecord {
    this.createDirectCalls.push(input);
    const record: TodoRecord = {
      id: input.id,
      entryId: null,
      text: input.text,
      eventTime: input.now,
      eventEpochMs: Date.parse(input.now),
      eventTimeExplicit: false,
      extractedAt: input.now,
      status: 'open',
      doneEntryId: null,
      resolution: null,
      doneAt: null,
      origin: 'user',
      touched: true,
    };
    this.records = [...this.records, record];
    return record;
  }

  remove(id: string): void {
    this.removeCalls.push(id);
    this.records = this.records.filter((r) => r.id !== id);
  }

  reopen(id: string): void {
    this.reopenCalls.push(id);
    this.records = this.records.map((r) =>
      r.id === id ? { ...r, status: 'open', doneEntryId: null, resolution: null, doneAt: null } : r,
    );
  }

  completeDirect(id: string): void {
    this.completeDirectCalls.push(id);
    this.records = this.records.map((r) =>
      r.id === id ? { ...r, status: 'done', doneEntryId: null, resolution: null, touched: true } : r,
    );
  }

  summarize(): TodosSummary {
    return this.summary;
  }

  updateSuggestions: TodoUpdateSuggestion[] = [];
  completionSuggestions: TodoCompletionSuggestion[] = [];

  update(id: string, input: UpdateTodoInput): TodoRecord | null {
    const existing = this.records.find((r) => r.id === id);
    if (!existing) return null;
    const updated: TodoRecord = {
      ...existing,
      ...(input.text !== undefined ? { text: input.text } : {}),
      ...(input.eventTime !== undefined ? { eventTime: input.eventTime } : {}),
      ...(input.eventTimeExplicit !== undefined ? { eventTimeExplicit: input.eventTimeExplicit } : {}),
      touched: true,
    };
    this.records = this.records.map((r) => (r.id === id ? updated : r));
    return updated;
  }

  validate(id: string): void {
    this.records = this.records.map((r) => (r.id === id ? { ...r, touched: true } : r));
  }

  /** Mirrors the real `TodosIndex.untouch`'s new guard. */
  untouch(id: string): void {
    this.records = this.records.map((r) => (r.id === id && r.origin === 'extracted' ? { ...r, touched: false } : r));
  }

  listUpdateSuggestions(options: { status?: TodoUpdateSuggestion['status'] } = {}): TodoUpdateSuggestion[] {
    return this.updateSuggestions.filter((s) => !options.status || s.status === options.status);
  }

  decideUpdate(id: string, decision: 'approved' | 'rejected'): void {
    this.updateSuggestions = this.updateSuggestions.map((s) => (s.id === id ? { ...s, status: decision } : s));
  }

  listCompletionSuggestions(options: { status?: TodoCompletionSuggestion['status'] } = {}): TodoCompletionSuggestion[] {
    return this.completionSuggestions.filter((s) => !options.status || s.status === options.status);
  }

  decideCompletion(id: string, decision: 'approved' | 'rejected'): void {
    this.completionSuggestions = this.completionSuggestions.map((s) => (s.id === id ? { ...s, status: decision } : s));
  }

  /** See `FakeMetricsReader.restoreTouched`. */
  restoreTouched(record: TodoRecord): void {
    this.records = this.records.some((r) => r.id === record.id)
      ? this.records.map((r) => (r.id === record.id ? record : r))
      : [...this.records, record];
  }

  openRaisedBy(entryId: string): TodoRecord[] {
    return this.records.filter((r) => r.entryId === entryId && r.status === 'open');
  }

  insertApproved(record: TodoRecord): void {
    this.records = [...this.records, record];
  }

  completeApprovedCalls: Array<{ id: string; doneEntryId: string; resolution: string; doneAt: string }> = [];

  completeApproved(id: string, completion: { doneEntryId: string; resolution: string; doneAt: string }): void {
    this.completeApprovedCalls.push({ id, ...completion });
    this.records = this.records.map((r) =>
      r.id === id && r.status === 'open'
        ? { ...r, status: 'done', doneEntryId: completion.doneEntryId, resolution: completion.resolution, doneAt: completion.doneAt, touched: true }
        : r,
    );
  }
}

/** The same fake-the-seam approach `publisher.test.ts`'s `FakeBlobStore`
 * takes for `PublicBlobStore` — an in-memory stand-in for
 * `durable/touched-mirror.ts`'s `DurableBlobStore`, exercising real
 * `TouchedMirror.sync` calls against the fake readers above without a real
 * filesystem or S3 involved. */
class FakeDurableBlobStore implements DurableBlobStore {
  files = new Map<string, string>();

  async put(key: string, json: string): Promise<void> {
    this.files.set(key, json);
  }

  async delete(key: string): Promise<void> {
    this.files.delete(key);
  }

  async list(prefix: string): Promise<{ key: string; json: string }[]> {
    return [...this.files.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, json]) => ({ key, json }));
  }
}

/** In-memory `LayoutBlobStore` — the `derived/layouts/` durable store with no
 * real filesystem, so the `/layouts` routes run against a real
 * `DurableLayoutStore` + `:memory:` `LayoutsIndex`. */
class FakeLayoutBlobStore implements LayoutBlobStore {
  files = new Map<string, string>();

  async put(key: string, body: string): Promise<void> {
    this.files.set(key, body);
  }

  async get(key: string): Promise<string | null> {
    return this.files.get(key) ?? null;
  }

  async delete(key: string): Promise<void> {
    this.files.delete(key);
  }

  async listKeys(prefix: string): Promise<string[]> {
    return [...this.files.keys()].filter((key) => key.startsWith(prefix));
  }
}

/** Records calls and returns a canned response — these tests exercise the
 * route's own contract (validation, status codes, passthrough), never the
 * model's judgement (that is `chat-orchestrator.test.ts`'s job). */
class FakeChatAnswerer implements ChatAnswerer {
  calls: ChatMessage[][] = [];
  response: ChatResponse | 'FAIL' = { answer: '', charts: [], citedEntryIds: [] };

  async answer(messages: ChatMessage[]): Promise<ChatResponse> {
    this.calls.push(messages);
    if (this.response === 'FAIL') throw chatFailed('the gateway is not configured');
    return this.response;
  }
}

/** The `/layouts/compile` route's contract only — the model's judgement is
 * not exercised here. */
class FakeLayoutCompiler implements LayoutCompiling {
  calls: Array<{ prose: string; name: string; currentSyntax?: string }> = [];
  result: { syntax: string; spec: RawLayoutSpec; unresolved: string[] } | 'FAIL' = {
    syntax: 'layout "Compiled"\n\nsection "S"\n  panel todos\n',
    spec: {
      version: 1,
      surface: 'analysis',
      name: 'Compiled',
      window: null,
      sections: [{ title: 'S', panels: [{ view: 'todos', options: {} }] }],
    },
    unresolved: [],
  };

  async compile(prose: string, _catalog: unknown, name: string, currentSyntax?: string) {
    this.calls.push({ prose, name, ...(currentSyntax !== undefined ? { currentSyntax } : {}) });
    if (this.result === 'FAIL') throw layoutCompileFailed('gateway unconfigured');
    return this.result;
  }
}

/** Records which entries were processed and returns a canned response —
 * these tests exercise the route's own contract, never real extraction
 * (that is each extractor's own test file's job, and `pending-processor.test.ts`'s). */
class FakePendingProcessor implements LivePendingProcessing {
  calls: { id: string; created: string; body: string }[] = [];
  response: ProcessEntryResponse | 'FAIL' = { pendingItemCount: 0, processRunId: 'run-1' };

  async processEntry(entry: { id: string; created: string; body: string }): Promise<ProcessEntryResponse> {
    this.calls.push(entry);
    if (this.response === 'FAIL') throw extractionFailed('AI_GATEWAY_API_KEY is not set.');
    return this.response;
  }
}

/** A plain in-memory stand-in for `PendingItemsIndex` — real filtering
 * logic (not just canned responses), since several route tests exercise
 * `entryId`/`structureType`/`status` query filtering directly. */
class FakePendingItemsReader implements PendingItemsReader {
  items: PendingExtractionItem[] = [];
  decideCalls: Array<{ id: string; decision: 'approved' | 'rejected' }> = [];

  list(options: ListPendingItemsOptions = {}): PendingExtractionItem[] {
    return this.items.filter(
      (i) =>
        (options.entryId === undefined || i.entryId === options.entryId) &&
        (options.structureType === undefined || i.structureType === options.structureType) &&
        (options.status === undefined || i.status === options.status),
    );
  }

  getById(id: string): PendingExtractionItem | null {
    return this.items.find((i) => i.id === id) ?? null;
  }

  insertBatch(items: CreatePendingItemInput[]): void {
    this.items = [...this.items, ...items.map((i) => ({ ...i, status: 'pending' as const, decidedAt: null }))];
  }

  supersedePendingForEntry(entryId: string, runId: string, now: string): void {
    this.items = this.items.map((i) =>
      i.entryId === entryId && i.processRunId !== runId && i.status === 'pending' ? { ...i, status: 'superseded' as const, decidedAt: now } : i,
    );
  }

  decide(id: string, decision: 'approved' | 'rejected', now: string): PendingExtractionItem | null {
    this.decideCalls.push({ id, decision });
    const item = this.items.find((i) => i.id === id && i.status === 'pending');
    if (!item) return null;
    const decided: PendingExtractionItem = { ...item, status: decision, decidedAt: now };
    this.items = this.items.map((i) => (i.id === id ? decided : i));
    return decided;
  }
}

/** Records which items were applied — approving/applying an item's real
 * effect on the target structure is `pending-item-applier.test.ts`'s job,
 * not the HTTP layer's. */
class FakePendingItemApplier implements PendingItemApplying {
  applyCalls: PendingExtractionItem[] = [];

  async apply(item: PendingExtractionItem): Promise<void> {
    this.applyCalls.push(item);
  }
}

class FakeEntryProcessingStatusReader implements EntryProcessingStatusReader {
  rows = new Map<string, EntryProcessingStatusRow>();
  recordProcessedCalls: Array<{ entryId: string; contentHash: string }> = [];

  get(entryId: string): EntryProcessingStatusRow | null {
    return this.rows.get(entryId) ?? null;
  }

  recordProcessed(entryId: string, contentHash: string, now: string): void {
    this.recordProcessedCalls.push({ entryId, contentHash });
    this.rows.set(entryId, { entryId, lastProcessedContentHash: contentHash, lastProcessedAt: now });
  }

  removeEntry(entryId: string): void {
    this.rows.delete(entryId);
  }
}

/**
 * The endpoints, exercised through Hono's own request path so that middleware,
 * status codes and error shapes are all real.
 *
 * `app.request()` sets a `Host` of `localhost`, which is what a browser on this
 * machine would send.
 */

const ORIGIN = 'http://localhost:3000';

let root: string;
let app: ReturnType<typeof createApp>;
let transcriber: FakeTranscriber;
let searcher: FakeSearcher;
let metrics: FakeMetricsReader;
let metricFields: FakeMetricFieldsReader;
let reviews: FakeReviewsReader;
let lists: FakeListItemsReader;
let categories: FakeCategoriesReader;
let opinionStatements: FakeOpinionStatementsReader;
let opinionSummaries: FakeOpinionSummariesReader;
let questions: FakeQuestionsReader;
let todos: FakeTodosReader;
let processor: FakePendingProcessor;
let pendingItems: FakePendingItemsReader;
let pendingItemApplier: FakePendingItemApplier;
let entryProcessingStatus: FakeEntryProcessingStatusReader;
let chat: FakeChatAnswerer;
let index: SqliteIndex;
let documentsIndex: DocumentsIndex;
let mediaIndex: MediaIndex;
let publishedIndex: PublishedIndex;
let visibilityDefaultsIndex: VisibilityDefaultsIndex;
let layoutsIndex: LayoutsIndex;
let layoutStore: DurableLayoutStore;
let layoutCompiler: FakeLayoutCompiler;

const config = (journalDir: string): Config => ({
  journalDir,
  host: '127.0.0.1',
  port: 4319,
  allowedOrigins: [ORIGIN],
  publicUrl: undefined,
  whisperModel: 'Xenova/whisper-tiny.en',
  whisperCacheDir: join(journalDir, '.whisper-cache-unused-in-tests'),
  indexDbPath: ':memory:',
  embeddingModel: 'Xenova/all-MiniLM-L6-v2',
  embeddingDimensions: 384,
  embeddingCacheDir: join(journalDir, '.embedding-cache-unused-in-tests'),
  aiGatewayApiKey: undefined,
  extractionModel: 'anthropic/claude-sonnet-5',
  chatModel: 'anthropic/claude-sonnet-5',
  storageBackend: 'fs',
  s3Bucket: undefined,
  awsRegion: undefined,
  awsAccessKeyId: undefined,
  awsSecretAccessKey: undefined,
  s3AssumeRoleArn: undefined,
  authorizedEmail: 'you@example.com',
  googleClientId: undefined,
  googleClientSecret: undefined,
  authPasswordHash: undefined,
  // `undefined` — auth stays off for this whole suite, exactly as before
  // `plan.md` M11 (see `entry-store-contract.test.ts` / a future
  // `auth.test.ts` for the auth-enabled behaviour).
  sessionSecret: undefined,
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'journal-http-'));
  transcriber = new FakeTranscriber();
  searcher = new FakeSearcher();
  metrics = new FakeMetricsReader();
  metricFields = new FakeMetricFieldsReader();
  reviews = new FakeReviewsReader();
  lists = new FakeListItemsReader();
  categories = new FakeCategoriesReader();
  opinionStatements = new FakeOpinionStatementsReader();
  opinionSummaries = new FakeOpinionSummariesReader();
  questions = new FakeQuestionsReader();
  todos = new FakeTodosReader();
  processor = new FakePendingProcessor();
  pendingItems = new FakePendingItemsReader();
  pendingItemApplier = new FakePendingItemApplier();
  entryProcessingStatus = new FakeEntryProcessingStatusReader();
  chat = new FakeChatAnswerer();
  index = new SqliteIndex(':memory:');
  documentsIndex = new DocumentsIndex(':memory:');
  mediaIndex = new MediaIndex(':memory:');
  publishedIndex = new PublishedIndex(':memory:');
  visibilityDefaultsIndex = new VisibilityDefaultsIndex(':memory:');
  layoutsIndex = new LayoutsIndex(':memory:');
  layoutStore = new DurableLayoutStore(new FakeLayoutBlobStore(), layoutsIndex);
  layoutCompiler = new FakeLayoutCompiler();
  const entryStore = new FsEntryStore(root, index);
  const documentStore = new FsDocumentStore(root, documentsIndex);
  const mediaStore = new FsMediaStore(root, mediaIndex);
  const publisher = createPublisher(
    config(root),
    publishedIndex,
    entryStore,
    documentStore,
    metrics,
    reviews,
    lists,
    opinionStatements,
    questions,
    new PublicSearchIndex(':memory:'),
  );
  const touchedMirror = new TouchedMirror(
    new FakeDurableBlobStore(),
    metrics,
    reviews,
    lists,
    opinionStatements,
    questions,
    todos,
  );
  app = createApp(
    entryStore,
    documentStore,
    mediaStore,
    config(root),
    transcriber,
    searcher,
    metrics,
    metricFields,
    reviews,
    lists,
    categories,
    opinionStatements,
    opinionSummaries,
    questions,
    todos,
    processor,
    pendingItems,
    pendingItemApplier,
    entryProcessingStatus,
    chat,
    publisher,
    visibilityDefaultsIndex,
    touchedMirror,
    layoutStore,
    layoutsIndex,
    layoutCompiler,
  );
});

afterEach(async () => {
  index.close();
  documentsIndex.close();
  mediaIndex.close();
  publishedIndex.close();
  visibilityDefaultsIndex.close();
  layoutsIndex.close();
  await rm(root, { recursive: true, force: true });
});

function post(body: unknown, headers: Record<string, string> = {}) {
  return app.request('/entries', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

const errorOf = async (response: Response) => ((await response.json()) as ApiError).error;

describe('GET /health', () => {
  it('reports which journal is being served', async () => {
    const response = await app.request('/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual<HealthResponse>({
      status: 'ok',
      journalDir: root,
      entryCount: 0,
      unreadableCount: 0,
    });
  });

  it('counts unreadable files so damage is visible rather than silent', async () => {
    await mkdir(join(root, 'journal'), { recursive: true });
    await writeFile(join(root, 'journal/broken.md'), 'no frontmatter here\n');
    const health = (await (await app.request('/health')).json()) as HealthResponse;
    expect(health).toMatchObject({ entryCount: 0, unreadableCount: 1 });
  });
});

describe('POST /entries', () => {
  it('creates an entry and reports where it landed', async () => {
    const response = await post({
      body: 'Written over HTTP.',
      created: '2026-07-26T22:55:13+01:00',
      location: { lat: 51.5072, lon: -0.1276 },
    });

    expect(response.status).toBe(201);
    const created = (await response.json()) as CreateEntryResponse;
    expect(created.created).toBe('2026-07-26T22:55:13+01:00');
    expect(created.path).toMatch(/^journal\/2026\/07\/2026-07-26-2255-[0-9a-z]{6}\.md$/);

    // The file really is there, and it really is clean markdown.
    expect(await readFile(join(root, created.path), 'utf8')).toBe(
      `---\nid: ${created.id}\ncreated: 2026-07-26T22:55:13+01:00\n` +
        `location: { lat: 51.5072, lon: -0.1276 }\n---\nWritten over HTTP.\n`,
    );
  });

  it('works without created or location, so curl is usable', async () => {
    expect((await post({ body: 'Bare.' })).status).toBe(201);
  });

  it('rejects a body that is not valid JSON', async () => {
    const response = await app.request('/entries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ not json',
    });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('invalid_request');
  });

  it('rejects fields the format does not have', async () => {
    // `format.md` §3: three fields and no others. A title arriving here means a
    // client has invented one, and failing loudly is how that gets noticed.
    const response = await post({ body: 'x', title: 'My day' });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('invalid_request');
  });

  it('rejects a missing body, a non-string body, and impossible coordinates', async () => {
    for (const payload of [
      {},
      { body: 42 },
      { body: 'x', location: { lat: 91, lon: 0 } },
      { body: 'x', location: { lat: 0, lon: 181 } },
      { body: 'x', location: { lat: 0 } },
      { body: 'x', created: 'sometime yesterday' },
    ]) {
      const response = await post(payload);
      expect(response.status, JSON.stringify(payload)).toBe(400);
      expect((await errorOf(response)).code).toBe('invalid_request');
    }
  });

  it('declines to commit an entry that was never written', async () => {
    const response = await post({ body: '   \n  ' });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('invalid_request');
  });
});

describe('GET /entries', () => {
  const write = (created: string, body: string) => post({ body, created });

  it('is an empty page, not an error, on an empty journal', async () => {
    const response = await app.request('/entries');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual<EntryPage>({ entries: [], nextCursor: null });
  });

  it('returns newest first with excerpts already cut', async () => {
    await write('2026-07-01T09:00:00+01:00', 'The first one.');
    await write('2026-07-02T09:00:00+01:00', `${'long '.repeat(300)}`);

    const page = (await (await app.request('/entries')).json()) as EntryPage;
    expect(page.entries).toHaveLength(2);
    expect(page.entries[0]!.excerpt).toMatch(/…$/);
    expect(page.entries[1]!.excerpt).toBe('The first one.');
    // The frontend receives a string and is told nothing about how it was cut.
    expect(page.entries[0]).not.toHaveProperty('body');
    expect(page.entries[0]).not.toHaveProperty('path');
  });

  it('pages with an opaque cursor', async () => {
    for (let i = 1; i <= 5; i += 1) {
      await write(`2026-07-0${i}T09:00:00Z`, `Entry ${i}`);
    }
    const first = (await (await app.request('/entries?limit=2')).json()) as EntryPage;
    expect(first.entries.map((e) => e.excerpt)).toEqual(['Entry 5', 'Entry 4']);
    expect(first.nextCursor).toBeTruthy();

    const second = (await (
      await app.request(`/entries?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`)
    ).json()) as EntryPage;
    expect(second.entries.map((e) => e.excerpt)).toEqual(['Entry 3', 'Entry 2']);
  });

  it('rejects a cursor it did not issue', async () => {
    const response = await app.request('/entries?cursor=fabricated');
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('invalid_cursor');
  });

  it('rejects an unusable limit', async () => {
    for (const limit of ['0', '-1', '201', 'ten', '1.5']) {
      const response = await app.request(`/entries?limit=${limit}`);
      expect(response.status, limit).toBe(400);
      expect((await errorOf(response)).code).toBe('invalid_request');
    }
  });

  it('restricts to one calendar month when year and month are both given', async () => {
    await write('2026-06-15T09:00:00Z', 'June');
    await write('2026-07-01T09:00:00Z', 'July first');
    await write('2026-07-26T09:00:00Z', 'July last');

    const page = (await (await app.request('/entries?year=2026&month=7')).json()) as EntryPage;
    expect(page.entries.map((e) => e.excerpt)).toEqual(['July last', 'July first']);
  });

  it('rejects year or month given without the other', async () => {
    for (const query of ['year=2026', 'month=7']) {
      const response = await app.request(`/entries?${query}`);
      expect(response.status, query).toBe(400);
      expect((await errorOf(response)).code).toBe('invalid_request');
    }
  });

  it('rejects a month outside 1-12', async () => {
    for (const month of ['0', '13', 'july']) {
      const response = await app.request(`/entries?year=2026&month=${month}`);
      expect(response.status, month).toBe(400);
      expect((await errorOf(response)).code).toBe('invalid_request');
    }
  });
});

describe('GET /entries/periods', () => {
  const write = (created: string, body: string) => post({ body, created });

  it('is an empty list, not an error, on an empty journal', async () => {
    const response = await app.request('/entries/periods');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ periods: [] });
  });

  it('lists each distinct year-month once, newest first, with no count', async () => {
    await write('2026-06-15T09:00:00Z', 'June');
    await write('2026-07-01T09:00:00Z', 'July first');
    await write('2026-07-26T09:00:00Z', 'July second');

    const response = await app.request('/entries/periods');
    expect(await response.json()).toEqual({
      periods: [
        { year: 2026, month: 7 },
        { year: 2026, month: 6 },
      ],
    });
  });

  it('is never shadowed by GET /entries/:id', async () => {
    // "periods" is not a ulid, so if this route were absent or mis-registered
    // the :id handler would answer with entry_not_found instead of a period list.
    const response = await app.request('/entries/periods');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty('periods');
    expect(body).not.toHaveProperty('error');
  });
});

describe('GET /entries/:id', () => {
  it('returns the metadata and the full body', async () => {
    const created = (await (
      await post({ body: 'Line one\n\nLine two\n', created: '2026-07-26T22:55:13+01:00' })
    ).json()) as CreateEntryResponse;

    const response = await app.request(`/entries/${created.id}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual<Entry>({
      id: created.id,
      created: '2026-07-26T22:55:13+01:00',
      body: 'Line one\n\nLine two\n',
      contentHash: created.contentHash,
      published: false,
    });
  });

  it('reports a missing entry as not found, including for a malformed id', async () => {
    for (const id of ['01ARZ3NDEKTSV4RRFFQ69G5FAV', 'nonsense', '../../etc/passwd']) {
      const response = await app.request(`/entries/${encodeURIComponent(id)}`);
      expect(response.status, id).toBe(404);
      expect((await errorOf(response)).code).toBe('entry_not_found');
    }
  });
});

describe('PUT /entries/:id', () => {
  function put(id: string, body: unknown) {
    return app.request(`/entries/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('changes the body and returns the entry with a new contentHash', async () => {
    const created = (await (
      await post({ body: 'First draft.', created: '2026-07-26T22:55:13+01:00' })
    ).json()) as CreateEntryResponse;

    const response = await put(created.id, { body: 'Revised.', contentHash: created.contentHash });
    expect(response.status).toBe(200);
    const updated = (await response.json()) as UpdateEntryResponse;
    expect(updated).toEqual<Entry>({
      id: created.id,
      created: created.created,
      body: 'Revised.\n',
      contentHash: updated.contentHash,
      published: false,
    });
    expect(updated.contentHash).not.toBe(created.contentHash);

    // And it is really on disk, readable through GET.
    const reread = (await (await app.request(`/entries/${created.id}`)).json()) as Entry;
    expect(reread.body).toBe('Revised.\n');
  });

  it('rejects a stale contentHash with a 409 and does not touch the file', async () => {
    const created = (await (
      await post({ body: 'Original.', created: '2026-07-26T22:55:13+01:00' })
    ).json()) as CreateEntryResponse;
    await put(created.id, { body: 'First edit.', contentHash: created.contentHash });

    // Retrying with the now-stale hash from the original creation.
    const response = await put(created.id, { body: 'Conflicting edit.', contentHash: created.contentHash });
    expect(response.status).toBe(409);
    expect((await errorOf(response)).code).toBe('edit_conflict');

    const reread = (await (await app.request(`/entries/${created.id}`)).json()) as Entry;
    expect(reread.body).toBe('First edit.\n');
  });

  it('reports a missing entry as not found', async () => {
    const response = await put('01ARZ3NDEKTSV4RRFFQ69G5FAV', { body: 'x', contentHash: 'whatever' });
    expect(response.status).toBe(404);
    expect((await errorOf(response)).code).toBe('entry_not_found');
  });

  it('rejects a missing contentHash and a missing body', async () => {
    const created = (await (await post({ body: 'x' })).json()) as CreateEntryResponse;
    for (const payload of [{ body: 'y' }, { contentHash: created.contentHash }, {}]) {
      const response = await put(created.id, payload);
      expect(response.status, JSON.stringify(payload)).toBe(400);
      expect((await errorOf(response)).code).toBe('invalid_request');
    }
  });

  it('rejects fields the format does not have', async () => {
    const created = (await (await post({ body: 'x' })).json()) as CreateEntryResponse;
    const response = await put(created.id, {
      body: 'y',
      contentHash: created.contentHash,
      title: 'Nope',
    });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('invalid_request');
  });
});

describe('POST /entries/:id/publish, /unpublish', () => {
  it('flips published on GET /entries/:id and is idempotent', async () => {
    const created = (await (await post({ body: 'A public thought.' })).json()) as CreateEntryResponse;

    const before = (await (await app.request(`/entries/${created.id}`)).json()) as Entry;
    expect(before.published).toBe(false);

    const publishResponse = await app.request(`/entries/${created.id}/publish`, { method: 'POST' });
    expect(publishResponse.status).toBe(204);
    const afterPublish = (await (await app.request(`/entries/${created.id}`)).json()) as Entry;
    expect(afterPublish.published).toBe(true);

    // Publishing again is a no-op, not an error.
    expect((await app.request(`/entries/${created.id}/publish`, { method: 'POST' })).status).toBe(204);

    const unpublishResponse = await app.request(`/entries/${created.id}/unpublish`, { method: 'POST' });
    expect(unpublishResponse.status).toBe(204);
    const afterUnpublish = (await (await app.request(`/entries/${created.id}`)).json()) as Entry;
    expect(afterUnpublish.published).toBe(false);
  });

  it('tolerates a malformed or missing id rather than erroring', async () => {
    for (const id of ['01ARZ3NDEKTSV4RRFFQ69G5FAV', 'nonsense']) {
      expect((await app.request(`/entries/${id}/publish`, { method: 'POST' })).status).toBe(204);
      expect((await app.request(`/entries/${id}/unpublish`, { method: 'POST' })).status).toBe(204);
    }
  });

  it('keeps the published mirror in sync after an edit', async () => {
    const created = (await (await post({ body: 'Original.' })).json()) as CreateEntryResponse;
    await app.request(`/entries/${created.id}/publish`, { method: 'POST' });

    const updateResponse = await app.request(`/entries/${created.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'Revised.', contentHash: created.contentHash }),
    });
    const updated = (await updateResponse.json()) as UpdateEntryResponse;
    // Still published — an edit to a published entry never silently
    // unpublishes it (`plan.md` M15's resync-on-update behavior).
    expect(updated.published).toBe(true);
  });
});

describe('DELETE /entries/:id', () => {
  function del(id: string) {
    return app.request(`/entries/${id}`, { method: 'DELETE' });
  }

  it('discards a whitespace-only entry', async () => {
    const created = (await (await post({ body: 'placeholder' })).json()) as CreateEntryResponse;
    await app.request(`/entries/${created.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: '   ', contentHash: created.contentHash }),
    });

    const response = await del(created.id);
    expect(response.status).toBe(204);

    expect((await app.request(`/entries/${created.id}`)).status).toBe(404);
  });

  it('refuses to discard an entry with real content, and leaves it readable', async () => {
    const created = (await (await post({ body: 'Real writing.' })).json()) as CreateEntryResponse;

    const response = await del(created.id);
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('invalid_request');

    expect((await app.request(`/entries/${created.id}`)).status).toBe(200);
  });

  it('is idempotent — deleting an already-gone or never-existed entry still succeeds quietly', async () => {
    expect((await del('01ARZ3NDEKTSV4RRFFQ69G5FAV')).status).toBe(204);
  });
});

describe('POST /entries/:id/attachments', () => {
  function upload(id: string, filename: string, data: Uint8Array | string, type = 'application/octet-stream') {
    const form = new FormData();
    form.set('file', new File([data], filename, { type }));
    // No explicit Content-Type header: FormData needs to set its own boundary.
    return app.request(`/entries/${id}/attachments`, { method: 'POST', body: form });
  }

  it('stores the file and returns the relative link for the body', async () => {
    const created = (await (await post({ body: 'A photo from today.' })).json()) as CreateEntryResponse;
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);

    const response = await upload(created.id, 'photo.jpg', bytes, 'image/jpeg');
    expect(response.status).toBe(201);
    const body = (await response.json()) as AddAttachmentResponse;
    expect(body.relativeLink).toMatch(/^[0-9a-z-]+\/photo\.jpg$/);
    expect(body.relativeLink).not.toContain('journal/');
  });

  it('reports a missing entry as not found', async () => {
    const response = await upload('01ARZ3NDEKTSV4RRFFQ69G5FAV', 'x.jpg', 'x');
    expect(response.status).toBe(404);
    expect((await errorOf(response)).code).toBe('entry_not_found');
  });

  it('rejects a request with no file field', async () => {
    const created = (await (await post({ body: 'x' })).json()) as CreateEntryResponse;
    const form = new FormData();
    form.set('notFile', 'nope');
    const response = await app.request(`/entries/${created.id}/attachments`, { method: 'POST', body: form });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('invalid_request');
  });

  it('rejects a second attachment with the same filename', async () => {
    const created = (await (await post({ body: 'x' })).json()) as CreateEntryResponse;
    expect((await upload(created.id, 'voice.m4a', 'first')).status).toBe(201);

    const response = await upload(created.id, 'voice.m4a', 'second');
    expect(response.status).toBe(409);
    expect((await errorOf(response)).code).toBe('attachment_conflict');
  });

  it('rejects a filename that is a path traversal attempt', async () => {
    const created = (await (await post({ body: 'x' })).json()) as CreateEntryResponse;
    const response = await upload(created.id, '../../etc/passwd', 'x');
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('invalid_request');
  });
});

describe('GET /entries/:id/attachments/:filename', () => {
  it("serves an attachment's raw bytes with a content type inferred from its extension", async () => {
    const created = (await (await post({ body: 'A photo from today.' })).json()) as CreateEntryResponse;
    const form = new FormData();
    form.set('file', new File([new Uint8Array([1, 2, 3])], 'photo.jpg', { type: 'image/jpeg' }));
    await app.request(`/entries/${created.id}/attachments`, { method: 'POST', body: form });

    const response = await app.request(`/entries/${created.id}/attachments/photo.jpg`);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/jpeg');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('reports a missing entry as not found', async () => {
    const response = await app.request('/entries/01ARZ3NDEKTSV4RRFFQ69G5FAV/attachments/photo.jpg');
    expect(response.status).toBe(404);
    expect((await errorOf(response)).code).toBe('entry_not_found');
  });

  it('reports a filename that was never attached as not found', async () => {
    const created = (await (await post({ body: 'x' })).json()) as CreateEntryResponse;
    const response = await app.request(`/entries/${created.id}/attachments/missing.jpg`);
    expect(response.status).toBe(404);
    expect((await errorOf(response)).code).toBe('record_not_found');
  });
});

describe('POST /entries/:id/attachments/from-media', () => {
  async function uploadToLibrary(filename = 'photo.jpg', type = 'image/jpeg'): Promise<UploadMediaResponse> {
    const form = new FormData();
    form.set('file', new File([new Uint8Array([9, 9, 9])], filename, { type }));
    const response = await app.request('/media', { method: 'POST', body: form });
    return (await response.json()) as UploadMediaResponse;
  }

  function attachFromMedia(entryId: string, mediaId: string) {
    return app.request(`/entries/${entryId}/attachments/from-media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mediaId }),
    });
  }

  it("copies the library item's bytes into the entry's own attachment directory", async () => {
    const created = (await (await post({ body: 'A photo from today.' })).json()) as CreateEntryResponse;
    const media = await uploadToLibrary();

    const response = await attachFromMedia(created.id, media.id);
    expect(response.status).toBe(201);
    const body = (await response.json()) as AddAttachmentResponse;
    expect(body.relativeLink).toMatch(new RegExp(`^[0-9a-z-]+/${media.id}\\.jpg$`));

    const served = await app.request(`/entries/${created.id}/attachments/${media.id}.jpg`);
    expect(served.status).toBe(200);
    expect(served.headers.get('Content-Type')).toBe('image/jpeg');
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(new Uint8Array([9, 9, 9]));
  });

  it('reports a missing entry as not found', async () => {
    const media = await uploadToLibrary();
    const response = await attachFromMedia('01ARZ3NDEKTSV4RRFFQ69G5FAV', media.id);
    expect(response.status).toBe(404);
    expect((await errorOf(response)).code).toBe('entry_not_found');
  });

  it('reports a missing media item as not found', async () => {
    const created = (await (await post({ body: 'x' })).json()) as CreateEntryResponse;
    const response = await attachFromMedia(created.id, '01ARZ3NDEKTSV4RRFFQ69G5FAV');
    expect(response.status).toBe(404);
    expect((await errorOf(response)).code).toBe('record_not_found');
  });

  it('rejects a request with no mediaId', async () => {
    const created = (await (await post({ body: 'x' })).json()) as CreateEntryResponse;
    const response = await app.request(`/entries/${created.id}/attachments/from-media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('invalid_request');
  });

  it('rejects attaching the same media item to the same entry twice', async () => {
    const created = (await (await post({ body: 'x' })).json()) as CreateEntryResponse;
    const media = await uploadToLibrary();
    expect((await attachFromMedia(created.id, media.id)).status).toBe(201);

    const response = await attachFromMedia(created.id, media.id);
    expect(response.status).toBe(409);
    expect((await errorOf(response)).code).toBe('attachment_conflict');
  });
});

/** A minimal, well-formed MP4 `moov/mvhd` box tree — the same fixture shape
 * `video-metadata.test.ts` and `media-store-contract.test.ts` verify — so
 * media routes can be exercised with a file that has real, extractable
 * `capturedAt` metadata. */
function mediaFixture(captured: Date): Uint8Array {
  const box = (type: string, body: Uint8Array): Uint8Array => {
    const out = new Uint8Array(8 + body.length);
    new DataView(out.buffer).setUint32(0, 8 + body.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(body, 8);
    return out;
  };
  const macSeconds = Math.floor(captured.getTime() / 1000) + 2_082_844_800;
  const mvhdBody = new Uint8Array(20);
  new DataView(mvhdBody.buffer).setUint32(4, macSeconds);
  const ftyp = box('ftyp', new TextEncoder().encode('isommp42'));
  const moov = box('moov', box('mvhd', mvhdBody));
  return new Uint8Array([...ftyp, ...moov]);
}

const MEDIA_CAPTURED = new Date(Date.UTC(2026, 6, 20, 15, 30, 0));
const MEDIA_FIXTURE = mediaFixture(MEDIA_CAPTURED);

describe('POST /media', () => {
  function upload(filename: string, data: Uint8Array | string, type = 'video/mp4') {
    const form = new FormData();
    form.set('file', new File([data], filename, { type }));
    return app.request('/media', { method: 'POST', body: form });
  }

  it('stores the item and returns it, with metadata extracted from its own bytes', async () => {
    const response = await upload('IMG_0001.mp4', MEDIA_FIXTURE);
    expect(response.status).toBe(201);
    const body = (await response.json()) as UploadMediaResponse;
    expect(body.kind).toBe('video');
    expect(body.contentType).toBe('video/mp4');
    expect(body.originalFilename).toBe('IMG_0001.mp4');
    expect(body.capturedAt).toBe('2026-07-20T15:30:00');
  });

  it('rejects a request with no file field', async () => {
    const form = new FormData();
    form.set('notFile', 'nope');
    const response = await app.request('/media', { method: 'POST', body: form });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('invalid_request');
  });

  it('rejects an unsupported content type', async () => {
    const response = await upload('voice.mp3', 'x', 'audio/mpeg');
    expect(response.status).toBe(415);
    expect((await errorOf(response)).code).toBe('unsupported_media_type');
  });
});

describe('GET /media and GET /media/:id', () => {
  async function uploadOne(filename = 'a.mp4'): Promise<UploadMediaResponse> {
    const form = new FormData();
    form.set('file', new File([MEDIA_FIXTURE], filename, { type: 'video/mp4' }));
    const response = await app.request('/media', { method: 'POST', body: form });
    return (await response.json()) as UploadMediaResponse;
  }

  it('lists every uploaded item', async () => {
    const first = await uploadOne('first.mp4');
    const second = await uploadOne('second.mp4');

    const response = await app.request('/media');
    const page = (await response.json()) as MediaPage;
    expect(new Set(page.media.map((m) => m.id))).toEqual(new Set([first.id, second.id]));
  });

  it('fetches one item by id', async () => {
    const uploaded = await uploadOne();
    const response = await app.request(`/media/${uploaded.id}`);
    expect(response.status).toBe(200);
    expect(((await response.json()) as UploadMediaResponse).id).toBe(uploaded.id);
  });

  it('reports a missing item as not found', async () => {
    const response = await app.request('/media/01ARZ3NDEKTSV4RRFFQ69G5FAV');
    expect(response.status).toBe(404);
    expect((await errorOf(response)).code).toBe('record_not_found');
  });
});

describe('GET /media/:id/file', () => {
  it('serves the raw bytes with the stored content type', async () => {
    const form = new FormData();
    form.set('file', new File([MEDIA_FIXTURE], 'a.mp4', { type: 'video/mp4' }));
    const uploaded = (await (await app.request('/media', { method: 'POST', body: form })).json()) as UploadMediaResponse;

    const response = await app.request(`/media/${uploaded.id}/file`);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('video/mp4');
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes).toEqual(MEDIA_FIXTURE);
  });

  it('reports a missing item as not found', async () => {
    const response = await app.request('/media/01ARZ3NDEKTSV4RRFFQ69G5FAV/file');
    expect(response.status).toBe(404);
  });
});

describe('DELETE /media/:id', () => {
  it('removes the item', async () => {
    const form = new FormData();
    form.set('file', new File([MEDIA_FIXTURE], 'a.mp4', { type: 'video/mp4' }));
    const uploaded = (await (await app.request('/media', { method: 'POST', body: form })).json()) as UploadMediaResponse;

    const response = await app.request(`/media/${uploaded.id}`, { method: 'DELETE' });
    expect(response.status).toBe(204);
    expect((await app.request(`/media/${uploaded.id}`)).status).toBe(404);
  });

  it('is a tolerant no-op on an id that does not exist', async () => {
    const response = await app.request('/media/01ARZ3NDEKTSV4RRFFQ69G5FAV', { method: 'DELETE' });
    expect(response.status).toBe(204);
  });
});

describe('GET /entries/:id/media', () => {
  it("returns media captured on the entry's own local calendar day", async () => {
    const created = (await (
      await post({ body: 'A day out.', created: '2026-07-20T09:00:00+01:00' })
    ).json()) as CreateEntryResponse;

    const form = new FormData();
    form.set('file', new File([MEDIA_FIXTURE], 'a.mp4', { type: 'video/mp4' }));
    await app.request('/media', { method: 'POST', body: form });

    const response = await app.request(`/entries/${created.id}/media`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as EntryMediaResponse;
    expect(body.media).toHaveLength(1);
    expect(body.media[0]?.capturedAt).toBe('2026-07-20T15:30:00');
  });

  it('is empty when nothing was captured that day', async () => {
    const created = (await (
      await post({ body: 'A quiet day.', created: '2020-01-01T09:00:00+01:00' })
    ).json()) as CreateEntryResponse;

    const response = await app.request(`/entries/${created.id}/media`);
    const body = (await response.json()) as EntryMediaResponse;
    expect(body.media).toEqual([]);
  });

  it('reports a missing entry as not found', async () => {
    const response = await app.request('/entries/01ARZ3NDEKTSV4RRFFQ69G5FAV/media');
    expect(response.status).toBe(404);
    expect((await errorOf(response)).code).toBe('entry_not_found');
  });
});

describe('POST /entries/:id/process', () => {
  function process(id: string) {
    return app.request(`/entries/${id}/process`, { method: 'POST' });
  }

  it('runs the live pending processor against the entry and returns its pending-item count', async () => {
    const created = (await (await post({ body: 'Ran 5k. Need to buy milk.' })).json()) as CreateEntryResponse;
    processor.response = { pendingItemCount: 2, processRunId: 'run-abc' };

    const response = await process(created.id);
    expect(response.status).toBe(200);
    const body = (await response.json()) as ProcessEntryResponse;
    expect(body).toEqual(processor.response);
    expect(processor.calls).toHaveLength(1);
    expect(processor.calls[0]!.id).toBe(created.id);
    expect(processor.calls[0]!.body).toBe('Ran 5k. Need to buy milk.\n');
  });

  it('records the entry as processed, at its current content hash, on success', async () => {
    const created = (await (await post({ body: 'x' })).json()) as CreateEntryResponse;
    await process(created.id);

    expect(entryProcessingStatus.recordProcessedCalls).toHaveLength(1);
    expect(entryProcessingStatus.recordProcessedCalls[0]).toMatchObject({ entryId: created.id, contentHash: created.contentHash });
  });

  it('is safe to call again on the same entry — same route, no special-casing', async () => {
    const created = (await (await post({ body: 'Edited later.' })).json()) as CreateEntryResponse;

    expect((await process(created.id)).status).toBe(200);
    expect((await process(created.id)).status).toBe(200);
    expect(processor.calls).toHaveLength(2);
    expect(entryProcessingStatus.recordProcessedCalls).toHaveLength(2);
  });

  it('reports a missing entry as not found, without calling the processor', async () => {
    const response = await process('01ARZ3NDEKTSV4RRFFQ69G5FAV');
    expect(response.status).toBe(404);
    expect((await errorOf(response)).code).toBe('entry_not_found');
    expect(processor.calls).toHaveLength(0);
  });

  it('reports a malformed id as not found', async () => {
    const response = await process('not-a-ulid');
    expect(response.status).toBe(404);
    expect((await errorOf(response)).code).toBe('entry_not_found');
  });

  it('surfaces extraction_failed when the model client is unconfigured, and does not record a processed status', async () => {
    const created = (await (await post({ body: 'x' })).json()) as CreateEntryResponse;
    processor.response = 'FAIL';

    const response = await process(created.id);
    expect(response.status).toBe(503);
    expect((await errorOf(response)).code).toBe('extraction_failed');
    expect(entryProcessingStatus.recordProcessedCalls).toHaveLength(0);
  });
});

describe('GET /entries/:id/status', () => {
  function status(id: string) {
    return app.request(`/entries/${id}/status`);
  }

  it('is never_processed before any Process run', async () => {
    const created = (await (await post({ body: 'x' })).json()) as CreateEntryResponse;
    const response = await status(created.id);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual<EntryStatusResponse>({ state: 'never_processed' });
  });

  it('is up_to_date right after a successful process run', async () => {
    const created = (await (await post({ body: 'x' })).json()) as CreateEntryResponse;
    await app.request(`/entries/${created.id}/process`, { method: 'POST' });

    expect(await (await status(created.id)).json()).toEqual<EntryStatusResponse>({ state: 'up_to_date' });
  });

  it('is stale once the entry is edited after a process run', async () => {
    const created = (await (await post({ body: 'x' })).json()) as CreateEntryResponse;
    await app.request(`/entries/${created.id}/process`, { method: 'POST' });

    await app.request(`/entries/${created.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'x, edited', contentHash: created.contentHash }),
    });

    expect(await (await status(created.id)).json()).toEqual<EntryStatusResponse>({ state: 'stale' });
  });

  it('reports a missing entry as not found', async () => {
    const response = await status('01ARZ3NDEKTSV4RRFFQ69G5FAV');
    expect(response.status).toBe(404);
    expect((await errorOf(response)).code).toBe('entry_not_found');
  });
});

describe('POST /documents', () => {
  function postDocument(body: unknown) {
    return app.request('/documents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('creates a document and reports where it landed', async () => {
    const response = await postDocument({ title: 'The greenhouse project', body: 'Notes so far.' });

    expect(response.status).toBe(201);
    const created = (await response.json()) as CreateDocumentResponse;
    expect(created.path).toBe(`documents/${created.id}.md`);

    expect(await readFile(join(root, created.path), 'utf8')).toBe(
      `---\nid: ${created.id}\ntitle: The greenhouse project\ncreated: ${created.created}\n` +
        `updated: ${created.created}\n---\nNotes so far.\n`,
    );
  });

  it('accepts citedEntries', async () => {
    const entry = (await (await post({ body: 'Referenced entry.' })).json()) as CreateEntryResponse;
    const response = await postDocument({
      title: 'A project',
      body: 'x',
      citedEntries: [entry.id],
    });
    expect(response.status).toBe(201);
    const created = (await response.json()) as CreateDocumentResponse;
    const stored = await readFile(join(root, created.path), 'utf8');
    expect(stored).toContain(`citedEntries: [${entry.id}]`);
  });

  it('rejects a missing or empty title', async () => {
    for (const payload of [{ body: 'x' }, { title: '', body: 'x' }]) {
      const response = await postDocument(payload);
      expect(response.status, JSON.stringify(payload)).toBe(400);
      expect((await errorOf(response)).code).toBe('invalid_request');
    }
  });

  it('rejects fields the format does not have', async () => {
    const response = await postDocument({ title: 'x', body: 'x', touched: true });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('invalid_request');
  });
});

describe('GET /documents', () => {
  it('is an empty page, not an error, with no documents', async () => {
    const response = await app.request('/documents');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual<DocumentPage>({ documents: [], nextCursor: null });
  });

  it('returns both documents with excerpts already cut', async () => {
    const first = (await (
      await app.request('/documents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'First', body: `${'long '.repeat(300)}` }),
      })
    ).json()) as CreateDocumentResponse;
    await app.request('/documents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Second', body: 'Second body.' }),
    });

    const page = (await (await app.request('/documents')).json()) as DocumentPage;
    expect(page.documents).toHaveLength(2);
    expect(page.documents.map((d) => d.title).sort()).toEqual(['First', 'Second']);
    const firstSummary = page.documents.find((d) => d.id === first.id)!;
    expect(firstSummary.excerpt).toMatch(/…$/);
    expect(firstSummary).not.toHaveProperty('body');
    expect(firstSummary).not.toHaveProperty('path');
  });

  it('rejects an unusable limit', async () => {
    for (const limit of ['0', '-1', '201', 'ten', '1.5']) {
      const response = await app.request(`/documents?limit=${limit}`);
      expect(response.status, limit).toBe(400);
      expect((await errorOf(response)).code).toBe('invalid_request');
    }
  });
});

describe('GET /documents/:id', () => {
  it('returns the metadata and the full body', async () => {
    const created = (await (
      await app.request('/documents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'A project', body: 'Line one\n\nLine two\n' }),
      })
    ).json()) as CreateDocumentResponse;

    const response = await app.request(`/documents/${created.id}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual<Document>({
      id: created.id,
      title: 'A project',
      created: created.created,
      updated: created.created,
      published: false,
      body: 'Line one\n\nLine two\n',
      contentHash: created.contentHash,
    });
  });

  it('reports a missing document as record_not_found, including for a malformed id', async () => {
    for (const id of ['01ARZ3NDEKTSV4RRFFQ69G5FAV', 'nonsense']) {
      const response = await app.request(`/documents/${encodeURIComponent(id)}`);
      expect(response.status, id).toBe(404);
      expect((await errorOf(response)).code).toBe('record_not_found');
    }
  });
});

describe('PUT /documents/:id', () => {
  function put(id: string, body: unknown) {
    return app.request(`/documents/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
  async function create(title: string, body: string): Promise<CreateDocumentResponse> {
    const response = await app.request('/documents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body }),
    });
    return (await response.json()) as CreateDocumentResponse;
  }

  it('changes the title and body and returns the document with a new contentHash', async () => {
    const created = await create('Draft title', 'First draft.');

    const response = await put(created.id, {
      title: 'Final title',
      body: 'Revised.',
      contentHash: created.contentHash,
    });
    expect(response.status).toBe(200);
    const updated = (await response.json()) as UpdateDocumentResponse;
    expect(updated.title).toBe('Final title');
    expect(updated.body).toBe('Revised.\n');
    expect(updated.created).toBe(created.created);
    // Not asserted: `updated.updated !== created.created` — `updated` is
    // second-precision, so create-then-PUT can legitimately land in the
    // same second on a fast run. `contentHash` changing is what actually
    // proves the file was rewritten (matches the store-level contract
    // test's identical reasoning).
    expect(updated.contentHash).not.toBe(created.contentHash);
  });

  it('rejects a stale contentHash with a 409 and does not touch the file', async () => {
    const created = await create('x', 'Original.');
    await put(created.id, { title: 'x', body: 'First edit.', contentHash: created.contentHash });

    const response = await put(created.id, { title: 'x', body: 'Conflicting edit.', contentHash: created.contentHash });
    expect(response.status).toBe(409);
    expect((await errorOf(response)).code).toBe('edit_conflict');

    const reread = (await (await app.request(`/documents/${created.id}`)).json()) as Document;
    expect(reread.body).toBe('First edit.\n');
  });

  it('reports a missing document as record_not_found', async () => {
    const response = await put('01ARZ3NDEKTSV4RRFFQ69G5FAV', { title: 'x', body: 'x', contentHash: 'whatever' });
    expect(response.status).toBe(404);
    expect((await errorOf(response)).code).toBe('record_not_found');
  });

  it('rejects an empty title', async () => {
    const created = await create('x', 'x');
    const response = await put(created.id, { title: '', body: 'x', contentHash: created.contentHash });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('invalid_request');
  });
});

describe('POST /documents/:id/publish and /unpublish', () => {
  async function create(title: string, body: string): Promise<CreateDocumentResponse> {
    const response = await app.request('/documents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body }),
    });
    return (await response.json()) as CreateDocumentResponse;
  }

  function put(id: string, body: unknown) {
    return app.request(`/documents/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  function publish(id: string) {
    return app.request(`/documents/${id}/publish`, { method: 'POST' });
  }

  function unpublish(id: string) {
    return app.request(`/documents/${id}/unpublish`, { method: 'POST' });
  }

  it('publishes — leaves title/body/contentHash untouched, and marks the document published', async () => {
    const created = await create('x', 'x');

    const response = await publish(created.id);
    expect(response.status).toBe(200);
    const published = (await response.json()) as Document;
    expect(published.published).toBe(true);
    expect(published.title).toBe('x');
    expect(published.body).toBe('x\n');
    expect(published.contentHash).toBe(created.contentHash);
  });

  it('unpublish reverses it', async () => {
    const created = await create('x', 'x');
    await publish(created.id);

    const response = await unpublish(created.id);
    expect(response.status).toBe(200);
    expect(((await response.json()) as Document).published).toBe(false);
  });

  it('an ordinary PUT never changes published status', async () => {
    const created = await create('x', 'x');
    await publish(created.id);

    const response = await put(created.id, { title: 'Renamed', body: 'y', contentHash: created.contentHash });
    expect(((await response.json()) as Document).published).toBe(true);
  });

  it('reports a missing document as record_not_found, including for a malformed id', async () => {
    for (const id of ['01ARZ3NDEKTSV4RRFFQ69G5FAV', 'nonsense']) {
      const response = await publish(id);
      expect(response.status, id).toBe(404);
      expect((await errorOf(response)).code).toBe('record_not_found');
    }
  });
});

describe('GET /analysis/metrics', () => {
  it('passes the currently approved metric names and the window to summarize', async () => {
    categories.approved.metric = ['exercise', 'sleep'];
    await app.request('/analysis/metrics');
    expect(metrics.summarizeCalls).toEqual([{ approvedNames: ['exercise', 'sleep'], windowDays: 30 }]);
  });

  it('returns whatever the MetricsReader produces, plus the window used', async () => {
    const summary: MetricSummary = { metric: 'exercise', totalCount: 3, days: [{ date: '2026-07-20', count: 1 }] };
    metrics.summaries = [summary];
    const response = await app.request('/analysis/metrics');
    expect((await response.json()) as MetricsSummaryResponse).toEqual({ summaries: [summary], windowDays: 30 });
  });

  it('accepts an explicit windowDays, up to a year and beyond — the shared time-window control', async () => {
    await app.request('/analysis/metrics?windowDays=366');
    expect(metrics.summarizeCalls).toEqual([{ approvedNames: [], windowDays: 366 }]);
  });

  it('rejects a windowDays outside the valid range', async () => {
    const response = await app.request('/analysis/metrics?windowDays=0');
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('invalid_request');
  });
});

describe('GET /analysis/metrics/:metric/fields/:fieldKey', () => {
  const numericField = (overrides: Partial<MetricFieldDefinition> = {}): MetricFieldDefinition => ({
    id: 'f1',
    metric: 'exercise',
    fieldKey: 'distance_km',
    label: 'Distance',
    fieldType: 'numeric',
    unit: 'km',
    scoreMin: null,
    scoreMax: null,
    description: 'How far.',
    createdAt: '2026-07-20T09:00:00Z',
    ...overrides,
  });

  it('rejects a field that does not exist', async () => {
    const response = await app.request('/analysis/metrics/exercise/fields/distance_km');
    expect(response.status).toBe(400);
  });

  it('rejects a text or enum field — only numeric or score can be summed', async () => {
    metricFields.fields = [numericField({ fieldType: 'enum', unit: null })];
    const response = await app.request('/analysis/metrics/exercise/fields/distance_km');
    expect(response.status).toBe(400);
  });

  it('passes the metric, fieldKey, and default window to sumByField', async () => {
    metricFields.fields = [numericField()];
    await app.request('/analysis/metrics/exercise/fields/distance_km');
    expect(metrics.sumByFieldCalls).toEqual([{ metric: 'exercise', fieldKey: 'distance_km', windowDays: 30 }]);
  });

  it('parses a filter query param into field and value', async () => {
    metricFields.fields = [numericField()];
    await app.request('/analysis/metrics/exercise/fields/distance_km?filter=sport:rowing');
    expect(metrics.sumByFieldCalls[0]!.filter).toEqual({ field: 'sport', value: 'rowing' });
  });

  it('rejects a malformed filter', async () => {
    metricFields.fields = [numericField()];
    const response = await app.request('/analysis/metrics/exercise/fields/distance_km?filter=nocolon');
    expect(response.status).toBe(400);
  });

  it('respects a custom windowDays', async () => {
    metricFields.fields = [numericField()];
    await app.request('/analysis/metrics/exercise/fields/distance_km?windowDays=90');
    expect(metrics.sumByFieldCalls[0]!.windowDays).toBe(90);
  });

  it('rejects an out-of-range windowDays', async () => {
    metricFields.fields = [numericField()];
    const response = await app.request('/analysis/metrics/exercise/fields/distance_km?windowDays=0');
    expect(response.status).toBe(400);
  });

  it('returns the unit from the field definition and whatever the MetricsReader produces', async () => {
    metricFields.fields = [numericField()];
    metrics.fieldSummary = { total: 20, average: 10, count: 2, days: [{ date: '2026-07-20', value: 8 }] };
    const response = await app.request('/analysis/metrics/exercise/fields/distance_km?filter=sport:rowing&windowDays=90');
    expect(await response.json()).toEqual({
      metric: 'exercise',
      fieldKey: 'distance_km',
      unit: 'km',
      filter: { field: 'sport', value: 'rowing' },
      total: 20,
      average: 10,
      count: 2,
      windowDays: 90,
      days: [{ date: '2026-07-20', value: 8 }],
    });
  });
});

describe('GET /analysis/reviews', () => {
  it('passes the currently approved media to summarize', async () => {
    categories.approved.review_medium = ['film', 'book'];
    await app.request('/analysis/reviews');
    expect(reviews.summarizeCalls).toEqual([['film', 'book']]);
  });

  it('returns whatever the ReviewsReader produces', async () => {
    const summary: ReviewMediumSummary = { medium: 'film', count: 2, averageRating: 4.5 };
    reviews.summaries = [summary];
    const response = await app.request('/analysis/reviews');
    expect((await response.json()) as ReviewsSummaryResponse).toEqual({ summaries: [summary] });
  });
});

describe('GET /analysis/reviews/histogram', () => {
  it('passes the currently approved media to histogram', async () => {
    categories.approved.review_medium = ['film', 'book'];
    await app.request('/analysis/reviews/histogram');
    expect(reviews.histogramCalls).toEqual([['film', 'book']]);
  });

  it('returns whatever the ReviewsReader produces', async () => {
    reviews.histogramResult = { overall: [{ rating: 5, count: 3 }], byMedium: [{ medium: 'film', buckets: [{ rating: 5, count: 3 }] }] };
    const response = await app.request('/analysis/reviews/histogram');
    expect(await response.json()).toEqual(reviews.histogramResult);
  });
});

describe('GET /analysis/lists', () => {
  it('passes the currently approved list types to summarize', async () => {
    categories.approved.list_type = ['quote'];
    await app.request('/analysis/lists');
    expect(lists.summarizeCalls).toEqual([['quote']]);
  });

  it('returns whatever the ListItemsReader produces', async () => {
    const summary: ListTypeSummary = { listType: 'quote', count: 5 };
    lists.summaries = [summary];
    const response = await app.request('/analysis/lists');
    expect((await response.json()) as ListsSummaryResponse).toEqual({ summaries: [summary] });
  });
});

describe('GET /analysis/opinions', () => {
  it('passes the currently approved subjects to summarize', async () => {
    categories.approved.opinion_subject = ['philosophy', 'relationships'];
    await app.request('/analysis/opinions');
    expect(opinionStatements.summarizeCalls).toEqual([['philosophy', 'relationships']]);
  });

  it('returns whatever the OpinionStatementsReader produces', async () => {
    const summary: OpinionSubjectSummary = { subject: 'philosophy', count: 4 };
    opinionStatements.summaries = [summary];
    const response = await app.request('/analysis/opinions');
    expect((await response.json()) as OpinionSubjectSummariesResponse).toEqual({ summaries: [summary] });
  });
});

describe('GET /analysis/questions', () => {
  it('returns whatever the QuestionsReader produces', async () => {
    questions.summary = { openCount: 3, resolvedCount: 2 };
    const response = await app.request('/analysis/questions');
    expect((await response.json()) as QuestionsSummaryResponse).toEqual({ openCount: 3, resolvedCount: 2 });
  });
});

describe('GET /analysis/todos', () => {
  it('returns whatever the TodosReader produces', async () => {
    todos.summary = { openCount: 4, doneCount: 1 };
    const response = await app.request('/analysis/todos');
    expect((await response.json()) as TodosSummaryResponse).toEqual({ openCount: 4, doneCount: 1 });
  });
});

describe('POST /analysis/render', () => {
  const render = (body: unknown) =>
    app.request('/analysis/render', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('renders the built-in default when no layout is named', async () => {
    const response = await render({});
    expect(response.status).toBe(200);
    const layout = (await response.json()) as ResolvedLayout;
    expect(layout.layoutId).toBeNull();
    expect(layout.name).toBe('Analysis');
    expect(layout.window).toEqual({ days: 30 });
    // Its canonical DSL comes back for the (read-only, this milestone) editor.
    expect(layout.syntax).toContain('layout "Analysis"');
    expect(layout.syntax).toContain('panel presence');
    // Every panel is one of the closed vocabulary's variants.
    for (const section of layout.sections) {
      for (const panel of section.panels) {
        expect(typeof panel.view).toBe('string');
        expect(panel).toHaveProperty('title');
      }
    }
  });

  it('threads a windowDays override through to the resolved window and the readers', async () => {
    const response = await render({ windowDays: 90 });
    const layout = (await response.json()) as ResolvedLayout;
    expect(layout.window).toEqual({ days: 90 });
    expect(metrics.summarizeCalls.at(-1)?.windowDays).toBe(90);
  });

  it('renders a caller-supplied inline layout, echoing it back canonicalised', async () => {
    const response = await render({
      syntax: 'layout "Scratch"\n\nsection "Just todos"\n  panel todos\n',
    });
    expect(response.status).toBe(200);
    const layout = (await response.json()) as ResolvedLayout;
    expect(layout.name).toBe('Scratch');
    expect(layout.sections.map((s) => s.title)).toEqual(['Just todos']);
    expect(layout.syntax).toBe('layout "Scratch"\n\nsection "Just todos"\n  panel todos\n');
  });

  it('rejects an inline layout that does not parse with layout_invalid (422)', async () => {
    const response = await render({ syntax: 'layout "Bad"\n\nsection "S"\n  panel nonsense\n' });
    expect(response.status).toBe(422);
    expect((await errorOf(response)).code).toBe('layout_invalid');
  });

  it('degrades a panel naming an unknown metric to an error panel — never a 500', async () => {
    categories.approved.metric = ['sleep'];
    const response = await render({
      syntax: 'layout "A"\n\nsection "S"\n  panel correlation\n    metric: cycling\n',
    });
    expect(response.status).toBe(200);
    const layout = (await response.json()) as ResolvedLayout;
    expect(layout.sections[0]?.panels[0]).toMatchObject({ view: 'error' });
  });

  it('rejects a non-JSON body', async () => {
    const response = await app.request('/analysis/render', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });
    expect(response.status).toBe(400);
  });

  it('rejects an unknown body field', async () => {
    const response = await render({ layoutId: 'x', bogus: true });
    expect(response.status).toBe(400);
  });

  it('renders a stored layout by id, and the surface default when nothing is named', async () => {
    const created = (await (
      await app.request('/layouts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ surface: 'analysis', name: 'Mine', syntax: 'layout "x"\n\nsection "Only"\n  panel todos\n' }),
      })
    ).json()) as Layout;

    const byId = (await (await render({ layoutId: created.id })).json()) as ResolvedLayout;
    expect(byId.layoutId).toBe(created.id);
    expect(byId.sections.map((s) => s.title)).toEqual(['Only']);

    // No layoutId, no syntax → the stored default (the one just created).
    const byDefault = (await (await render({})).json()) as ResolvedLayout;
    expect(byDefault.layoutId).toBe(created.id);
    expect(byDefault.name).toBe('Mine');
  });

  it('reports an unknown layoutId as layout_not_found', async () => {
    const response = await render({ layoutId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' });
    expect(response.status).toBe(404);
    expect((await errorOf(response)).code).toBe('layout_not_found');
  });
});

describe('/layouts CRUD', () => {
  const jsonReq = (path: string, method: string, body: unknown) =>
    app.request(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const create = (body: unknown) => jsonReq('/layouts', 'POST', body);
  const validSyntax = 'layout "x"\n\nsection "S"\n  panel todos\n';

  it('creates a layout, canonicalising the syntax and forcing the request name in', async () => {
    const response = await create({ surface: 'analysis', name: 'Board one', syntax: 'section "S"\n  panel todos\n' });
    expect(response.status).toBe(201);
    const layout = (await response.json()) as Layout;
    expect(layout.name).toBe('Board one');
    expect(layout.syntax).toBe('layout "Board one"\n\nsection "S"\n  panel todos\n');
    expect(layout.isDefault).toBe(true);
  });

  it('rejects a create whose syntax does not parse', async () => {
    const response = await create({ surface: 'analysis', name: 'Bad', syntax: 'section "S"\n  panel nope\n' });
    expect(response.status).toBe(422);
    expect((await errorOf(response)).code).toBe('layout_invalid');
  });

  it('rejects a create carrying prose (compile is a later milestone) and one missing a name', async () => {
    expect((await create({ surface: 'analysis', name: 'P', prose: 'make it nice' })).status).toBe(400);
    expect((await create({ surface: 'analysis', syntax: validSyntax })).status).toBe(400);
  });

  it('lists layouts for a surface with the default pointer; rejects a bad surface', async () => {
    await create({ surface: 'analysis', name: 'one', syntax: validSyntax });
    await create({ surface: 'analysis', name: 'two', syntax: validSyntax });
    const list = (await (await app.request('/layouts?surface=analysis')).json()) as LayoutsResponse;
    expect(list.layouts.map((l) => l.name).sort()).toEqual(['one', 'two']);
    expect(list.defaultId).toBe(list.layouts.find((l) => l.name === 'one')!.id);
    expect((await app.request('/layouts?surface=bogus')).status).toBe(400);
  });

  it('gets one layout, 404s an unknown id', async () => {
    const created = (await (await create({ surface: 'analysis', name: 'g', syntax: validSyntax })).json()) as Layout;
    expect((await (await app.request(`/layouts/${created.id}`)).json()) as Layout).toMatchObject({ id: created.id });
    expect((await app.request('/layouts/01ARZ3NDEKTSV4RRFFQ69G5FAV')).status).toBe(404);
  });

  it('updates via PUT, guards on expectedUpdatedAt, 404s an unknown id', async () => {
    const created = (await (await create({ surface: 'analysis', name: 'u', syntax: validSyntax })).json()) as Layout;

    const stale = await jsonReq(`/layouts/${created.id}`, 'PUT', {
      syntax: 'layout "u2"\n\nsection "S"\n  panel lists\n',
      expectedUpdatedAt: 'wrong',
    });
    expect(stale.status).toBe(409);
    expect((await errorOf(stale)).code).toBe('edit_conflict');

    const ok = await jsonReq(`/layouts/${created.id}`, 'PUT', {
      syntax: 'layout "u2"\n\nsection "S"\n  panel lists\n',
      expectedUpdatedAt: created.updatedAt,
    });
    expect(ok.status).toBe(200);
    expect((await ok.json()) as Layout).toMatchObject({ name: 'u2' });

    expect((await jsonReq('/layouts/01ARZ3NDEKTSV4RRFFQ69G5FAV', 'PUT', { expectedUpdatedAt: 'x' })).status).toBe(404);
  });

  it('rejects a PUT whose new syntax does not parse', async () => {
    const created = (await (await create({ surface: 'analysis', name: 'p', syntax: validSyntax })).json()) as Layout;
    const response = await jsonReq(`/layouts/${created.id}`, 'PUT', {
      syntax: 'layout "p"\n\nsection "S"\n  panel ghost\n',
      expectedUpdatedAt: created.updatedAt,
    });
    expect(response.status).toBe(422);
  });

  it('moves the default pointer with POST /layouts/:id/default', async () => {
    const a = (await (await create({ surface: 'analysis', name: 'a', syntax: validSyntax })).json()) as Layout;
    const b = (await (await create({ surface: 'analysis', name: 'b', syntax: validSyntax })).json()) as Layout;
    const response = await app.request(`/layouts/${b.id}/default`, { method: 'POST' });
    expect(response.status).toBe(200);
    expect((await response.json()) as { defaultId: string }).toEqual({ defaultId: b.id });
    expect(((await (await app.request('/layouts?surface=analysis')).json()) as LayoutsResponse).defaultId).toBe(b.id);
    void a;
  });

  it('deletes a layout (204) and is a tolerant no-op for an unknown id', async () => {
    const created = (await (await create({ surface: 'analysis', name: 'd', syntax: validSyntax })).json()) as Layout;
    expect((await app.request(`/layouts/${created.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await app.request(`/layouts/${created.id}`)).status).toBe(404);
    expect((await app.request('/layouts/01ARZ3NDEKTSV4RRFFQ69G5FAV', { method: 'DELETE' })).status).toBe(204);
  });

  it('POST /layouts/parse validates and canonicalises without saving', async () => {
    const response = await jsonReq('/layouts/parse', 'POST', {
      surface: 'analysis',
      syntax: 'layout   "Draft"\n\n\nsection "S"\n  panel todos\n    show: all\n\n',
    });
    const body = (await response.json()) as { canonicalSyntax: string; diagnostics: unknown[] };
    expect(body.diagnostics).toEqual([]);
    expect(body.canonicalSyntax).toBe('layout "Draft"\n\nsection "S"\n  panel todos\n    show: all\n');
    // Nothing was stored.
    expect(((await (await app.request('/layouts?surface=analysis')).json()) as LayoutsResponse).layouts).toEqual([]);
  });

  it('POST /layouts/import-legacy-prefs stores a default "My layout" from old prefs', async () => {
    const response = await jsonReq('/layouts/import-legacy-prefs', 'POST', {
      prefs: { windowDays: 90, hidden: ['horizon', 'matrix'] },
    });
    expect(response.status).toBe(201);
    const layout = (await response.json()) as Layout;
    expect(layout.name).toBe('My layout');
    expect(layout.isDefault).toBe(true);
    expect(layout.syntax).toContain('window: 90d');
    expect(layout.syntax).not.toContain('panel horizon');
  });

  it('POST /layouts/compile returns the compiler output and never saves', async () => {
    const response = await jsonReq('/layouts/compile', 'POST', {
      surface: 'analysis',
      name: 'Draft',
      prose: 'just the open todos',
      currentSyntax: 'layout "Draft"\n\nsection "Old"\n  panel questions\n',
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { syntax: string; unresolved: string[] };
    expect(body.syntax).toContain('panel todos');
    expect(body.unresolved).toEqual([]);
    expect(layoutCompiler.calls[0]).toMatchObject({ prose: 'just the open todos', name: 'Draft' });
    // Nothing stored.
    expect(((await (await app.request('/layouts?surface=analysis')).json()) as LayoutsResponse).layouts).toEqual([]);
  });

  it('POST /layouts/compile surfaces an unconfigured gateway as layout_compile_failed (503)', async () => {
    layoutCompiler.result = 'FAIL';
    const response = await jsonReq('/layouts/compile', 'POST', { surface: 'analysis', name: 'x', prose: 'anything' });
    expect(response.status).toBe(503);
    expect((await errorOf(response)).code).toBe('layout_compile_failed');
  });

  it('POST /layouts/compile rejects an empty prose', async () => {
    expect((await jsonReq('/layouts/compile', 'POST', { surface: 'analysis', name: 'x', prose: '   ' })).status).toBe(400);
  });
});

describe('POST /chat', () => {
  const post = (body: unknown) =>
    app.request('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('passes the conversation through and returns whatever ChatAnswerer produces', async () => {
    const canned: ChatResponse = {
      answer: 'You logged exercise 4 times this week.',
      charts: [{ type: 'stat_tile', label: 'Exercise', value: 4, unit: null }],
      citedEntryIds: ['01ARZ3NDEKTSV4RRFFQ69G5FAV'],
    };
    chat.response = canned;

    const response = await post({ messages: [{ role: 'user', content: 'How much have I exercised?' }] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(canned);
    expect(chat.calls).toEqual([[{ role: 'user', content: 'How much have I exercised?' }]]);
  });

  it('rejects an empty messages array', async () => {
    const response = await post({ messages: [] });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('invalid_request');
  });

  it('rejects a conversation not ending in a user message', async () => {
    const response = await post({
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ],
    });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('invalid_request');
  });

  it('rejects more than the message cap', async () => {
    const messages: ChatMessage[] = Array.from({ length: 41 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `message ${i}`,
    }));
    const response = await post({ messages });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('invalid_request');
  });

  it('rejects a malformed role', async () => {
    const response = await post({ messages: [{ role: 'system', content: 'hi' }] });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('invalid_request');
  });

  it('surfaces chat_failed via the generic error handling, same as any other AppError', async () => {
    chat.response = 'FAIL';
    const response = await post({ messages: [{ role: 'user', content: 'hi' }] });
    expect(response.status).toBe(503);
    expect((await errorOf(response)).code).toBe('chat_failed');
  });
});

describe('POST /transcribe', () => {
  function transcribe(samples: Float32Array, sampleRate: number | string | undefined) {
    const query = sampleRate === undefined ? '' : `?sampleRate=${sampleRate}`;
    return app.request(`/transcribe${query}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: samples.buffer as ArrayBuffer,
    });
  }

  it('transcribes and hands the samples and rate straight to the Transcriber', async () => {
    transcriber.result = 'hello world';
    const samples = new Float32Array([0.1, -0.2, 0.3, 0]);

    const response = await transcribe(samples, 48_000);
    expect(response.status).toBe(200);
    const body = (await response.json()) as TranscribeResponse;
    expect(body.text).toBe('hello world');

    expect(transcriber.calls).toHaveLength(1);
    expect(transcriber.calls[0]!.sampleRate).toBe(48_000);
    expect(Array.from(transcriber.calls[0]!.samples)).toEqual(Array.from(samples));
  });

  it('rejects a missing or invalid sampleRate', async () => {
    const samples = new Float32Array([0.1, 0.2]);
    for (const rate of [undefined, '0', '-1', 'nope']) {
      const response = await transcribe(samples, rate);
      expect(response.status, String(rate)).toBe(400);
      expect((await errorOf(response)).code).toBe('invalid_request');
    }
  });

  it('rejects a body whose byte length is not a multiple of 4', async () => {
    const response = await app.request('/transcribe?sampleRate=16000', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array([1, 2, 3]),
    });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('invalid_request');
  });

  it('rejects an empty body', async () => {
    const response = await app.request('/transcribe?sampleRate=16000', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array([]),
    });
    expect(response.status).toBe(400);
  });

  it('surfaces a Transcriber failure as transcription_failed', async () => {
    transcriber.result = 'FAIL';
    const response = await transcribe(new Float32Array([0.1]), 16_000);
    expect(response.status).toBe(503);
    expect((await errorOf(response)).code).toBe('transcription_failed');
  });
});

describe('GET /search', () => {
  it('passes the query and default limit straight to the Searcher', async () => {
    const response = await app.request('/search?q=lighthouse');
    expect(response.status).toBe(200);
    const body = (await response.json()) as SearchResponse;
    expect(body).toEqual({ hits: [] });
    expect(searcher.calls).toEqual([{ query: 'lighthouse', limit: 20 }]);
  });

  it('returns whatever hits the Searcher produces, unmodified', async () => {
    const hit: SearchHit = {
      sourceType: 'entry',
      entryId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      created: '2026-07-01T09:00:00Z',
      passage: 'a lighthouse on the point',
    };
    searcher.hits = [hit];

    const response = await app.request('/search?q=lighthouse');
    const body = (await response.json()) as SearchResponse;
    expect(body.hits).toEqual([hit]);
  });

  it('returns a document hit exactly as the Searcher produces it', async () => {
    const hit: SearchHit = {
      sourceType: 'document',
      documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      title: 'A project',
      created: '2026-07-01T09:00:00Z',
      passage: 'a lighthouse on the point',
    };
    searcher.hits = [hit];

    const response = await app.request('/search?q=lighthouse');
    const body = (await response.json()) as SearchResponse;
    expect(body.hits).toEqual([hit]);
  });

  it('respects a custom limit', async () => {
    await app.request('/search?q=x&limit=5');
    expect(searcher.calls[0]!.limit).toBe(5);
  });

  it('rejects a missing q', async () => {
    const response = await app.request('/search');
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('invalid_request');
  });

  it('rejects an empty or whitespace-only q', async () => {
    for (const q of ['', '   ']) {
      const response = await app.request(`/search?q=${encodeURIComponent(q)}`);
      expect(response.status, JSON.stringify(q)).toBe(400);
    }
  });

  it('rejects a limit outside 1..200', async () => {
    for (const limit of ['0', '-1', '201', 'nope']) {
      const response = await app.request(`/search?q=x&limit=${limit}`);
      expect(response.status, limit).toBe(400);
      expect((await errorOf(response)).code).toBe('invalid_request');
    }
  });
});

describe('GET /metrics', () => {
  const record = (overrides: Partial<TemporalMetricRecord> = {}): TemporalMetricRecord => ({
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    entryId: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
    metric: 'exercise',
    eventTime: '2026-07-20T09:00:00+01:00',
    eventEpochMs: Date.parse('2026-07-20T08:00:00Z'),
    eventTimeExplicit: true,
    detail: 'a 5k run',
    fields: {},
    extractedAt: '2026-07-20T10:00:00+01:00',
    touched: false,
    ...overrides,
  });

  it('is empty, not an error, when nothing has been extracted', async () => {
    const response = await app.request('/metrics');
    expect(response.status).toBe(200);
    expect((await response.json()) as MetricsResponse).toEqual({ metrics: [] });
  });

  it('returns whatever the MetricsReader produces, without the internal-only fields', async () => {
    metrics.records = [record({ fields: { distance_km: 5 } })];
    const response = await app.request('/metrics');
    const body = (await response.json()) as MetricsResponse;
    const expected: TemporalMetric = {
      id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      entryId: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
      metric: 'exercise',
      eventTime: '2026-07-20T09:00:00+01:00',
      eventTimeExplicit: true,
      detail: 'a 5k run',
      fields: { distance_km: 5 },
      touched: false,
      published: false,
    };
    expect(body.metrics).toEqual([expected]);
  });

  it('passes a metric filter and the default limit straight to the MetricsReader', async () => {
    await app.request('/metrics?metric=sleep');
    expect(metrics.listCalls).toEqual([{ metric: 'sleep', limit: 30 }]);
  });

  it('respects a custom limit', async () => {
    await app.request('/metrics?limit=5');
    expect(metrics.listCalls[0]).toEqual({ limit: 5 });
  });

  it('rejects a limit outside 1..200', async () => {
    for (const limit of ['0', '-1', '201', 'nope']) {
      const response = await app.request(`/metrics?limit=${limit}`);
      expect(response.status, limit).toBe(400);
      expect((await errorOf(response)).code).toBe('invalid_request');
    }
  });
});

describe('DELETE /metrics/:id', () => {
  it('removes the record', async () => {
    const response = await app.request('/metrics/01ARZ3NDEKTSV4RRFFQ69G5FAV', { method: 'DELETE' });
    expect(response.status).toBe(204);
    expect(metrics.removeCalls).toEqual(['01ARZ3NDEKTSV4RRFFQ69G5FAV']);
  });

  it('is a no-op, not an error, for a malformed id', async () => {
    const response = await app.request('/metrics/not-a-ulid', { method: 'DELETE' });
    expect(response.status).toBe(204);
    expect(metrics.removeCalls).toEqual([]);
  });
});

/** Representative of the identical PUT/validate/untouch/update-suggestions
 * surface repeated across reviews, lists, opinion statements, and questions
 * (`plan.md` M10) — exercised once here in full; the others share the exact
 * same route-handler shape in `http/app.ts`. */
describe('PUT /metrics/:id (`plan.md` M10)', () => {
  const record = (overrides: Partial<TemporalMetricRecord> = {}): TemporalMetricRecord => ({
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    entryId: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
    metric: 'exercise',
    eventTime: '2026-07-20T09:00:00+01:00',
    eventEpochMs: Date.parse('2026-07-20T08:00:00Z'),
    eventTimeExplicit: true,
    detail: 'a 5k run',
    fields: {},
    extractedAt: '2026-07-20T10:00:00+01:00',
    touched: false,
    ...overrides,
  });

  it('edits the record and marks it touched', async () => {
    metrics.records = [record()];
    const response = await app.request('/metrics/01ARZ3NDEKTSV4RRFFQ69G5FAV', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ detail: 'corrected' }),
    });
    expect(response.status).toBe(204);
    expect(metrics.records[0]).toMatchObject({ detail: 'corrected', touched: true });
  });

  it('404s with record_not_found rather than silently dropping the edit', async () => {
    const response = await app.request('/metrics/01ARZ3NDEKTSV4RRFFQ69G5FAV', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ detail: 'corrected' }),
    });
    expect(response.status).toBe(404);
    expect((await errorOf(response)).code).toBe('record_not_found');
  });

  it('rejects an unknown field', async () => {
    metrics.records = [record()];
    const response = await app.request('/metrics/01ARZ3NDEKTSV4RRFFQ69G5FAV', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ metric: 'sleep' }),
    });
    expect(response.status).toBe(400);
  });
});

describe('POST /metrics/:id/validate and /untouch (`plan.md` M10)', () => {
  it('validate marks touched with no content change; untouch reverts it', async () => {
    metrics.records = [
      {
        id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        entryId: 'e1',
        metric: 'exercise',
        eventTime: '2026-07-20T09:00:00+01:00',
        eventEpochMs: Date.parse('2026-07-20T08:00:00Z'),
        eventTimeExplicit: true,
        detail: 'a 5k run',
        fields: {},
        extractedAt: '2026-07-20T10:00:00+01:00',
        touched: false,
      },
    ];

    const validated = await app.request('/metrics/01ARZ3NDEKTSV4RRFFQ69G5FAV/validate', { method: 'POST' });
    expect(validated.status).toBe(204);
    expect(metrics.records[0]).toMatchObject({ detail: 'a 5k run', touched: true });

    const untouched = await app.request('/metrics/01ARZ3NDEKTSV4RRFFQ69G5FAV/untouch', { method: 'POST' });
    expect(untouched.status).toBe(204);
    expect(metrics.records[0]!.touched).toBe(false);
  });

  it('both are tolerant no-ops for a malformed id, matching every other correction endpoint', async () => {
    const validated = await app.request('/metrics/not-a-ulid/validate', { method: 'POST' });
    const untouched = await app.request('/metrics/not-a-ulid/untouch', { method: 'POST' });
    expect(validated.status).toBe(204);
    expect(untouched.status).toBe(204);
  });
});

describe('GET/POST /metrics/update-suggestions (`plan.md` M10)', () => {
  it('lists pending suggestions and lets the user approve or reject one', async () => {
    metrics.updateSuggestions = [
      {
        id: 's1',
        recordId: 'm1',
        entryId: 'e1',
        detail: 'reprocessed differently',
        fields: {},
        eventTime: '2026-07-20T09:00:00+01:00',
        eventEpochMs: Date.parse('2026-07-20T08:00:00Z'),
        eventTimeExplicit: true,
        reason: 'Reprocessing this entry now extracts different content.',
        status: 'pending',
        suggestedAt: '2026-07-21T00:00:00Z',
        decidedAt: null,
      },
    ];

    const listed = await app.request('/metrics/update-suggestions');
    expect(((await listed.json()) as MetricUpdateSuggestionsResponse).suggestions).toHaveLength(1);

    const approved = await app.request('/metrics/update-suggestions/s1/approve', { method: 'POST' });
    expect(approved.status).toBe(204);
    expect(metrics.updateSuggestions[0]!.status).toBe('approved');
  });

  it('rejects an invalid status filter', async () => {
    const response = await app.request('/metrics/update-suggestions?status=nonsense');
    expect(response.status).toBe(400);
  });
});

describe('GET /metrics/fields', () => {
  const field = (overrides: Partial<MetricFieldDefinition> = {}): MetricFieldDefinition => ({
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    metric: 'exercise',
    fieldKey: 'distance_km',
    label: 'Distance',
    fieldType: 'numeric',
    unit: 'km',
    scoreMin: null,
    scoreMax: null,
    description: 'How far, in km.',
    createdAt: '2026-07-20T09:00:00Z',
    ...overrides,
  });

  it('is empty, not an error, when nothing has been defined', async () => {
    const response = await app.request('/metrics/fields');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ fields: [] });
  });

  it('returns every definition when no metric filter is given', async () => {
    metricFields.fields = [field(), field({ id: 'f2', metric: 'alcohol', fieldKey: 'units', label: 'Units', unit: 'units' })];
    const response = await app.request('/metrics/fields');
    const body = (await response.json()) as { fields: unknown[] };
    expect(body.fields).toHaveLength(2);
  });

  it('filters by metric', async () => {
    metricFields.fields = [field()];
    await app.request('/metrics/fields?metric=exercise');
    expect(metricFields.listForMetricCalls).toEqual(['exercise']);
  });
});

describe('POST /metrics/fields', () => {
  it('defines a field directly, with no suggestion step', async () => {
    const response = await app.request('/metrics/fields', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        metric: 'exercise',
        fieldKey: 'distance_km',
        label: 'Distance',
        fieldType: 'numeric',
        unit: 'km',
        description: 'How far, in km.',
      }),
    });
    expect(response.status).toBe(204);
    expect(metricFields.defineCalls).toHaveLength(1);
    expect(metricFields.defineCalls[0]).toMatchObject({ metric: 'exercise', fieldKey: 'distance_km' });
  });

  it('rejects an unknown fieldType', async () => {
    const response = await app.request('/metrics/fields', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ metric: 'exercise', fieldKey: 'x', label: 'X', fieldType: 'nonsense', description: 'x' }),
    });
    expect(response.status).toBe(400);
  });

  it('rejects a missing description', async () => {
    const response = await app.request('/metrics/fields', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ metric: 'exercise', fieldKey: 'x', label: 'X', fieldType: 'numeric' }),
    });
    expect(response.status).toBe(400);
  });
});

describe('PATCH /metrics/fields/:id', () => {
  const existingField: MetricFieldDefinition = {
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    metric: 'exercise',
    fieldKey: 'distance_km',
    label: 'Distance',
    fieldType: 'numeric',
    unit: 'km',
    scoreMin: null,
    scoreMax: null,
    description: 'How far, in km.',
    createdAt: '2026-07-20T09:00:00Z',
  };

  it('edits the field and returns the updated definition', async () => {
    metricFields.fields = [existingField];
    const response = await app.request('/metrics/fields/01ARZ3NDEKTSV4RRFFQ69G5FAV', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'Distance (updated)', unit: 'mi' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ label: 'Distance (updated)', unit: 'mi' });
  });

  it('can explicitly clear a nullable field to null', async () => {
    metricFields.fields = [{ ...existingField, fieldType: 'score', scoreMin: 1, scoreMax: 5, unit: null }];
    const response = await app.request('/metrics/fields/01ARZ3NDEKTSV4RRFFQ69G5FAV', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scoreMin: null, scoreMax: null }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ scoreMin: null, scoreMax: null });
  });

  it('returns record_not_found for an id that does not exist', async () => {
    const response = await app.request('/metrics/fields/01ARZ3NDEKTSV4RRFFQ69G5FAV', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'X' }),
    });
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('record_not_found');
  });

  it('rejects an attempt to change metric, fieldKey, or fieldType — not accepted fields', async () => {
    metricFields.fields = [existingField];
    const response = await app.request('/metrics/fields/01ARZ3NDEKTSV4RRFFQ69G5FAV', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fieldType: 'text' }),
    });
    expect(response.status).toBe(400);
  });
});

describe('DELETE /metrics/fields/:id', () => {
  it('removes the definition', async () => {
    const response = await app.request('/metrics/fields/01ARZ3NDEKTSV4RRFFQ69G5FAV', { method: 'DELETE' });
    expect(response.status).toBe(204);
    expect(metricFields.removeCalls).toEqual(['01ARZ3NDEKTSV4RRFFQ69G5FAV']);
  });

  it('is a no-op, not an error, for a malformed id', async () => {
    const response = await app.request('/metrics/fields/not-a-ulid', { method: 'DELETE' });
    expect(response.status).toBe(204);
    expect(metricFields.removeCalls).toEqual([]);
  });
});

describe('GET /metrics/fields/suggestions', () => {
  const suggestion = (overrides: Partial<MetricFieldSuggestion> = {}): MetricFieldSuggestion => ({
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    metric: 'exercise',
    fieldKey: 'pace_min_per_km',
    label: 'Pace',
    fieldType: 'numeric',
    unit: 'min/km',
    scoreMin: null,
    scoreMax: null,
    description: 'How fast.',
    reason: 'pace mentioned repeatedly',
    entryId: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
    status: 'pending',
    suggestedAt: '2026-07-20T09:00:00Z',
    decidedAt: null,
    ...overrides,
  });

  it('is empty, not an error, when nothing has been suggested', async () => {
    const response = await app.request('/metrics/fields/suggestions');
    expect((await response.json()) as { suggestions: unknown[] }).toEqual({ suggestions: [] });
  });

  it('returns whatever the MetricFieldsReader produces', async () => {
    metricFields.suggestions = [suggestion()];
    const response = await app.request('/metrics/fields/suggestions');
    expect((await response.json()) as { suggestions: unknown[] }).toEqual({ suggestions: [suggestion()] });
  });

  it('rejects an unknown status filter', async () => {
    const response = await app.request('/metrics/fields/suggestions?status=nonsense');
    expect(response.status).toBe(400);
  });
});

describe('POST /metrics/fields/suggestions/:id/approve and /reject', () => {
  it('approve calls decide with "approved"', async () => {
    const response = await app.request('/metrics/fields/suggestions/s1/approve', { method: 'POST' });
    expect(response.status).toBe(204);
    expect(metricFields.decideCalls).toEqual([{ id: 's1', decision: 'approved' }]);
  });

  it('reject calls decide with "rejected"', async () => {
    const response = await app.request('/metrics/fields/suggestions/s1/reject', { method: 'POST' });
    expect(response.status).toBe(204);
    expect(metricFields.decideCalls).toEqual([{ id: 's1', decision: 'rejected' }]);
  });
});

describe('GET /metrics/fields/:id/values', () => {
  it('delegates to CategoriesIndex under the metric_field structure type', async () => {
    metricFields.fields = [
      {
        id: 'f1',
        metric: 'exercise',
        fieldKey: 'sport',
        label: 'Sport',
        fieldType: 'enum',
        unit: null,
        scoreMin: null,
        scoreMax: null,
        description: 'Which sport.',
        createdAt: '2026-07-20T09:00:00Z',
      },
    ];
    categories.approved['metric_field:exercise:sport'] = ['rowing', 'running'];

    const response = await app.request('/metrics/fields/f1/values');
    expect((await response.json()) as { values: string[] }).toEqual({ values: ['rowing', 'running'] });
  });

  it('is empty, not an error, for a field that does not exist', async () => {
    const response = await app.request('/metrics/fields/never-existed/values');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ values: [] });
  });
});

describe('POST /metrics/fields/:id/values', () => {
  it('approves a value directly for an enum field', async () => {
    metricFields.fields = [
      {
        id: 'f1',
        metric: 'exercise',
        fieldKey: 'sport',
        label: 'Sport',
        fieldType: 'enum',
        unit: null,
        scoreMin: null,
        scoreMax: null,
        description: 'Which sport.',
        createdAt: '2026-07-20T09:00:00Z',
      },
    ];

    const response = await app.request('/metrics/fields/f1/values', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'rowing' }),
    });
    expect(response.status).toBe(204);
    expect(categories.approveCalls).toEqual([{ structureType: 'metric_field:exercise:sport', name: 'rowing' }]);
  });

  it('rejects a value for a non-enum field', async () => {
    metricFields.fields = [
      {
        id: 'f1',
        metric: 'exercise',
        fieldKey: 'distance_km',
        label: 'Distance',
        fieldType: 'numeric',
        unit: 'km',
        scoreMin: null,
        scoreMax: null,
        description: 'How far.',
        createdAt: '2026-07-20T09:00:00Z',
      },
    ];
    const response = await app.request('/metrics/fields/f1/values', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'rowing' }),
    });
    expect(response.status).toBe(400);
  });

  it('rejects a field that does not exist', async () => {
    const response = await app.request('/metrics/fields/never-existed/values', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'rowing' }),
    });
    expect(response.status).toBe(400);
  });
});

describe('GET /metrics/fields/:id/values/suggestions', () => {
  it('delegates to CategoriesIndex under the metric_field structure type', async () => {
    metricFields.fields = [
      {
        id: 'f1',
        metric: 'exercise',
        fieldKey: 'sport',
        label: 'Sport',
        fieldType: 'enum',
        unit: null,
        scoreMin: null,
        scoreMax: null,
        description: 'Which sport.',
        createdAt: '2026-07-20T09:00:00Z',
      },
    ];
    categories.suggestions = [
      {
        id: 's1',
        structureType: 'metric_field:exercise:sport',
        name: 'climbing',
        reason: 'first time mentioned',
        entryId: 'e1',
        status: 'pending',
        decidedAt: null,
        suggestedAt: '2026-07-20T09:00:00Z',
      },
    ];

    const response = await app.request('/metrics/fields/f1/values/suggestions');
    const body = (await response.json()) as { suggestions: CategorySuggestion[] };
    expect(body.suggestions.map((s) => s.name)).toEqual(['climbing']);
  });

  it('is empty, not an error, for a field that does not exist', async () => {
    const response = await app.request('/metrics/fields/never-existed/values/suggestions');
    expect(await response.json()).toEqual({ suggestions: [] });
  });
});

describe('GET /reviews', () => {
  const record = (): ReviewRecord => ({
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    entryId: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
    title: 'Some Film',
    medium: 'film',
    rating: 4,
    progress: 100,
    opinion: 'Really enjoyed it.',
    eventTime: '2026-07-20T20:00:00+01:00',
    eventEpochMs: Date.parse('2026-07-20T19:00:00Z'),
    eventTimeExplicit: true,
    extractedAt: '2026-07-20T21:00:00+01:00',
    touched: false,
  });

  it('is empty, not an error, when nothing has been extracted', async () => {
    const response = await app.request('/reviews');
    expect(response.status).toBe(200);
    expect((await response.json()) as ReviewsResponse).toEqual({ reviews: [] });
  });

  it('returns whatever the ReviewsReader produces, without the internal-only fields', async () => {
    reviews.records = [record()];
    const response = await app.request('/reviews');
    const body = (await response.json()) as ReviewsResponse;
    const expected: Review = {
      id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      entryId: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
      title: 'Some Film',
      medium: 'film',
      rating: 4,
      progress: 100,
      opinion: 'Really enjoyed it.',
      eventTime: '2026-07-20T20:00:00+01:00',
      eventTimeExplicit: true,
      touched: false,
      published: false,
    };
    expect(body.reviews).toEqual([expected]);
  });

  it('passes a medium filter and the default limit straight to the ReviewsReader', async () => {
    await app.request('/reviews?medium=book');
    expect(reviews.listCalls).toEqual([{ medium: 'book', limit: 30 }]);
  });

  it('rejects a limit outside 1..200', async () => {
    const response = await app.request('/reviews?limit=201');
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('invalid_request');
  });
});

describe('DELETE /reviews/:id', () => {
  it('removes the record', async () => {
    const response = await app.request('/reviews/01ARZ3NDEKTSV4RRFFQ69G5FAV', { method: 'DELETE' });
    expect(response.status).toBe(204);
    expect(reviews.removeCalls).toEqual(['01ARZ3NDEKTSV4RRFFQ69G5FAV']);
  });

  it('is a no-op, not an error, for a malformed id', async () => {
    const response = await app.request('/reviews/not-a-ulid', { method: 'DELETE' });
    expect(response.status).toBe(204);
    expect(reviews.removeCalls).toEqual([]);
  });
});

describe('GET /lists', () => {
  const record = (): ListItemRecord => ({
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    entryId: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
    listType: 'quote',
    text: '"The unexamined life is not worth living."',
    context: 'Socrates',
    importance: 4,
    eventTime: '2026-07-20T20:00:00+01:00',
    eventEpochMs: Date.parse('2026-07-20T19:00:00Z'),
    eventTimeExplicit: true,
    extractedAt: '2026-07-20T21:00:00+01:00',
    touched: false,
  });

  it('is empty, not an error, when nothing has been extracted', async () => {
    const response = await app.request('/lists');
    expect(response.status).toBe(200);
    expect((await response.json()) as ListItemsResponse).toEqual({ items: [] });
  });

  it('returns whatever the ListItemsReader produces, without the internal-only fields', async () => {
    lists.records = [record()];
    const response = await app.request('/lists');
    const body = (await response.json()) as ListItemsResponse;
    const expected: ListItem = {
      id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      entryId: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
      listType: 'quote',
      text: '"The unexamined life is not worth living."',
      context: 'Socrates',
      importance: 4,
      eventTime: '2026-07-20T20:00:00+01:00',
      eventTimeExplicit: true,
      touched: false,
      published: false,
    };
    expect(body.items).toEqual([expected]);
  });

  it('passes a listType filter straight to the ListItemsReader', async () => {
    await app.request('/lists?listType=quote');
    expect(lists.listCalls).toEqual([{ listType: 'quote', limit: 30 }]);
  });

  it('passes orderBy=importance straight to the ListItemsReader', async () => {
    await app.request('/lists?orderBy=importance');
    expect(lists.listCalls).toEqual([{ limit: 30, orderBy: 'importance' }]);
  });

  it('rejects an orderBy value that is neither recent nor importance', async () => {
    const response = await app.request('/lists?orderBy=whenever');
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('invalid_request');
  });
});

describe('DELETE /lists/:id', () => {
  it('removes the record', async () => {
    const response = await app.request('/lists/01ARZ3NDEKTSV4RRFFQ69G5FAV', { method: 'DELETE' });
    expect(response.status).toBe(204);
    expect(lists.removeCalls).toEqual(['01ARZ3NDEKTSV4RRFFQ69G5FAV']);
  });
});

describe('GET /opinions/statements', () => {
  const record = (overrides: Partial<OpinionStatementRecord> = {}): OpinionStatementRecord => ({
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    entryId: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
    subject: 'philosophy',
    statement: 'Believes in living deliberately.',
    eventTime: '2026-07-20T20:00:00+01:00',
    eventEpochMs: Date.parse('2026-07-20T19:00:00Z'),
    eventTimeExplicit: true,
    extractedAt: '2026-07-20T21:00:00+01:00',
    kind: 'note',
    status: null,
    resolvedEntryId: null,
    resolution: null,
    resolvedAt: null,
    touched: false,
    ...overrides,
  });

  it('is empty, not an error, when nothing has been extracted', async () => {
    const response = await app.request('/opinions/statements');
    expect(response.status).toBe(200);
    expect((await response.json()) as OpinionStatementsResponse).toEqual({ statements: [] });
  });

  it('returns whatever the OpinionStatementsReader produces, without the internal-only fields', async () => {
    opinionStatements.records = [record()];
    const response = await app.request('/opinions/statements');
    const body = (await response.json()) as OpinionStatementsResponse;
    expect(body.statements).toEqual([
      {
        id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        entryId: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
        subject: 'philosophy',
        statement: 'Believes in living deliberately.',
        eventTime: '2026-07-20T20:00:00+01:00',
        eventTimeExplicit: true,
        kind: 'note',
        status: null,
        resolvedEntryId: null,
        resolution: null,
        touched: false,
        published: false,
      },
    ]);
  });

  it('passes a subject filter and the default limit straight to the OpinionStatementsReader', async () => {
    await app.request('/opinions/statements?subject=future');
    expect(opinionStatements.listCalls).toEqual([{ subject: 'future', limit: 30 }]);
  });

  it('respects a custom limit', async () => {
    await app.request('/opinions/statements?limit=5');
    expect(opinionStatements.listCalls[0]).toEqual({ limit: 5 });
  });

  it('rejects a limit outside 1..200', async () => {
    for (const limit of ['0', '-1', '201', 'nope']) {
      const response = await app.request(`/opinions/statements?limit=${limit}`);
      expect(response.status, limit).toBe(400);
      expect((await errorOf(response)).code).toBe('invalid_request');
    }
  });
});

describe('DELETE /opinions/statements/:id', () => {
  it('removes the record', async () => {
    const response = await app.request('/opinions/statements/01ARZ3NDEKTSV4RRFFQ69G5FAV', { method: 'DELETE' });
    expect(response.status).toBe(204);
    expect(opinionStatements.removeCalls).toEqual(['01ARZ3NDEKTSV4RRFFQ69G5FAV']);
  });

  it('is a no-op, not an error, for a malformed id', async () => {
    const response = await app.request('/opinions/statements/not-a-ulid', { method: 'DELETE' });
    expect(response.status).toBe(204);
    expect(opinionStatements.removeCalls).toEqual([]);
  });
});

describe('POST /opinions/statements/:id/reopen', () => {
  it('reopens the record and mirrors it', async () => {
    const response = await app.request('/opinions/statements/01ARZ3NDEKTSV4RRFFQ69G5FAV/reopen', { method: 'POST' });
    expect(response.status).toBe(204);
    expect(opinionStatements.reopenCalls).toEqual(['01ARZ3NDEKTSV4RRFFQ69G5FAV']);
  });

  it('is a no-op, not an error, for a malformed id', async () => {
    const response = await app.request('/opinions/statements/not-a-ulid/reopen', { method: 'POST' });
    expect(response.status).toBe(204);
    expect(opinionStatements.reopenCalls).toEqual([]);
  });
});

describe('GET /opinions/summaries', () => {
  const part = (overrides: Partial<OpinionSummaryPartRecord> = {}): OpinionSummaryPartRecord => ({
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    subject: 'philosophy',
    partIndex: 0,
    text: 'Believes in living deliberately.',
    sourceStatementIds: ['01ARZ3NDEKTSV4RRFFQ69G5FAW'],
    sourceEntryIds: ['01ARZ3NDEKTSV4RRFFQ69G5FAX'],
    generatedAt: '2026-07-20T21:00:00+01:00',
    ...overrides,
  });

  it('is empty, not an error, when nothing has been generated', async () => {
    const response = await app.request('/opinions/summaries');
    expect(response.status).toBe(200);
    expect((await response.json()) as OpinionSummariesResponse).toEqual({ summaries: [] });
  });

  it('groups parts by subject, in generation order, without the internal-only fields', async () => {
    opinionSummaries.parts = [
      part({ id: '1', subject: 'philosophy', partIndex: 0, text: 'Part one.' }),
      part({ id: '2', subject: 'philosophy', partIndex: 1, text: 'Part two.' }),
      part({ id: '3', subject: 'future', partIndex: 0, text: 'A future part.' }),
    ];
    const response = await app.request('/opinions/summaries');
    const body = (await response.json()) as OpinionSummariesResponse;
    expect(body.summaries).toEqual([
      {
        subject: 'philosophy',
        generatedAt: '2026-07-20T21:00:00+01:00',
        parts: [
          {
            text: 'Part one.',
            sourceStatementIds: ['01ARZ3NDEKTSV4RRFFQ69G5FAW'],
            sourceEntryIds: ['01ARZ3NDEKTSV4RRFFQ69G5FAX'],
          },
          {
            text: 'Part two.',
            sourceStatementIds: ['01ARZ3NDEKTSV4RRFFQ69G5FAW'],
            sourceEntryIds: ['01ARZ3NDEKTSV4RRFFQ69G5FAX'],
          },
        ],
      },
      {
        subject: 'future',
        generatedAt: '2026-07-20T21:00:00+01:00',
        parts: [
          {
            text: 'A future part.',
            sourceStatementIds: ['01ARZ3NDEKTSV4RRFFQ69G5FAW'],
            sourceEntryIds: ['01ARZ3NDEKTSV4RRFFQ69G5FAX'],
          },
        ],
      },
    ]);
  });

  it('passes a subject filter straight to the OpinionSummariesReader', async () => {
    await app.request('/opinions/summaries?subject=philosophy');
    expect(opinionSummaries.listCalls).toEqual(['philosophy']);
  });
});

describe('GET /questions', () => {
  const record = (overrides: Partial<QuestionRecord> = {}): QuestionRecord => ({
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    entryId: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
    question: 'Should I stay in this job?',
    eventTime: '2026-07-20T20:00:00+01:00',
    eventEpochMs: Date.parse('2026-07-20T19:00:00Z'),
    eventTimeExplicit: true,
    extractedAt: '2026-07-20T21:00:00+01:00',
    status: 'open',
    resolvedEntryId: null,
    resolution: null,
    resolvedAt: null,
    touched: false,
    ...overrides,
  });

  it('is empty, not an error, when nothing has been extracted', async () => {
    const response = await app.request('/questions');
    expect(response.status).toBe(200);
    expect((await response.json()) as QuestionsResponse).toEqual({ questions: [] });
  });

  it('returns whatever the QuestionsReader produces, without the internal-only fields', async () => {
    questions.records = [record()];
    const response = await app.request('/questions');
    const body = (await response.json()) as QuestionsResponse;
    const expected: OpenQuestion = {
      id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      entryId: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
      question: 'Should I stay in this job?',
      eventTime: '2026-07-20T20:00:00+01:00',
      eventTimeExplicit: true,
      status: 'open',
      resolvedEntryId: null,
      resolution: null,
      touched: false,
      published: false,
    };
    expect(body.questions).toEqual([expected]);
  });

  it('includes resolution fields for a resolved question', async () => {
    questions.records = [
      record({ status: 'resolved', resolvedEntryId: '01ARZ3NDEKTSV4RRFFQ69G5FAX', resolution: 'Decided to leave.' }),
    ];
    const response = await app.request('/questions');
    const body = (await response.json()) as QuestionsResponse;
    expect(body.questions[0]).toMatchObject({
      status: 'resolved',
      resolvedEntryId: '01ARZ3NDEKTSV4RRFFQ69G5FAX',
      resolution: 'Decided to leave.',
    });
  });

  it('passes a status filter and the default limit straight to the QuestionsReader', async () => {
    await app.request('/questions?status=resolved');
    expect(questions.listCalls).toEqual([{ status: 'resolved', limit: 30 }]);
  });

  it('rejects a status value that is neither open nor resolved', async () => {
    const response = await app.request('/questions?status=whenever');
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('invalid_request');
  });

  it('rejects a limit outside 1..200', async () => {
    const response = await app.request('/questions?limit=201');
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('invalid_request');
  });
});

describe('DELETE /questions/:id', () => {
  it('removes the record', async () => {
    const response = await app.request('/questions/01ARZ3NDEKTSV4RRFFQ69G5FAV', { method: 'DELETE' });
    expect(response.status).toBe(204);
    expect(questions.removeCalls).toEqual(['01ARZ3NDEKTSV4RRFFQ69G5FAV']);
  });

  it('is a no-op, not an error, for a malformed id', async () => {
    const response = await app.request('/questions/not-a-ulid', { method: 'DELETE' });
    expect(response.status).toBe(204);
    expect(questions.removeCalls).toEqual([]);
  });
});

describe('POST /questions/:id/reopen', () => {
  it('reopens the record', async () => {
    const response = await app.request('/questions/01ARZ3NDEKTSV4RRFFQ69G5FAV/reopen', { method: 'POST' });
    expect(response.status).toBe(204);
    expect(questions.reopenCalls).toEqual(['01ARZ3NDEKTSV4RRFFQ69G5FAV']);
  });

  it('is a no-op, not an error, for a malformed id', async () => {
    const response = await app.request('/questions/not-a-ulid/reopen', { method: 'POST' });
    expect(response.status).toBe(204);
    expect(questions.reopenCalls).toEqual([]);
  });
});

describe('GET /todos', () => {
  const record = (overrides: Partial<TodoRecord> = {}): TodoRecord => ({
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    entryId: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
    text: 'Call the dentist',
    eventTime: '2026-07-20T20:00:00+01:00',
    eventEpochMs: Date.parse('2026-07-20T19:00:00Z'),
    eventTimeExplicit: true,
    extractedAt: '2026-07-20T21:00:00+01:00',
    status: 'open',
    doneEntryId: null,
    resolution: null,
    doneAt: null,
    origin: 'extracted',
    touched: false,
    ...overrides,
  });

  it('is empty, not an error, when nothing has been extracted', async () => {
    const response = await app.request('/todos');
    expect(response.status).toBe(200);
    expect((await response.json()) as TodosResponse).toEqual({ todos: [] });
  });

  it('returns whatever the TodosReader produces, without the internal-only fields', async () => {
    todos.records = [record()];
    const response = await app.request('/todos');
    const body = (await response.json()) as TodosResponse;
    const expected: Todo = {
      id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      entryId: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
      text: 'Call the dentist',
      eventTime: '2026-07-20T20:00:00+01:00',
      eventTimeExplicit: true,
      status: 'open',
      doneEntryId: null,
      resolution: null,
      origin: 'extracted',
      touched: false,
    };
    expect(body.todos).toEqual([expected]);
  });

  it('returns entryId: null and origin: "user" for a directly created to-do', async () => {
    todos.records = [record({ entryId: null, origin: 'user', touched: true })];
    const response = await app.request('/todos');
    const body = (await response.json()) as TodosResponse;
    expect(body.todos[0]).toMatchObject({ entryId: null, origin: 'user', touched: true });
  });

  it('passes a status filter and the default limit straight to the TodosReader', async () => {
    await app.request('/todos?status=done');
    expect(todos.listCalls).toEqual([{ status: 'done', limit: 30 }]);
  });

  it('rejects a status value that is neither open nor done', async () => {
    const response = await app.request('/todos?status=whenever');
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('invalid_request');
  });

  it('rejects a limit outside 1..200', async () => {
    const response = await app.request('/todos?limit=201');
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('invalid_request');
  });
});

/** The one structure type where creation isn't AI-only — the deliberate
 * exception to "origination is always automatic" (`requirements.md` §2,
 * §11, `plan.md` M15). Closest real precedent is `POST /documents`. */
describe('POST /todos', () => {
  it('creates a to-do directly, with no source entry, already touched and user-origin', async () => {
    const response = await app.request('/todos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Water the plants' }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as Todo;
    expect(body).toMatchObject({ entryId: null, text: 'Water the plants', status: 'open', origin: 'user', touched: true });

    // Immediately visible through a follow-up GET, exactly as created.
    const listed = await app.request('/todos');
    const listedBody = (await listed.json()) as TodosResponse;
    expect(listedBody.todos).toEqual([body]);
  });

  it('rejects an empty text', async () => {
    const response = await app.request('/todos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '' }),
    });
    expect(response.status).toBe(400);
  });

  it('rejects an unknown field', async () => {
    const response = await app.request('/todos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'x', dueDate: '2026-08-01' }),
    });
    expect(response.status).toBe(400);
  });
});

describe('DELETE /todos/:id', () => {
  it('removes the record', async () => {
    const response = await app.request('/todos/01ARZ3NDEKTSV4RRFFQ69G5FAV', { method: 'DELETE' });
    expect(response.status).toBe(204);
    expect(todos.removeCalls).toEqual(['01ARZ3NDEKTSV4RRFFQ69G5FAV']);
  });

  it('is a no-op, not an error, for a malformed id', async () => {
    const response = await app.request('/todos/not-a-ulid', { method: 'DELETE' });
    expect(response.status).toBe(204);
    expect(todos.removeCalls).toEqual([]);
  });
});

describe('POST /todos/:id/reopen', () => {
  it('reopens the record', async () => {
    const response = await app.request('/todos/01ARZ3NDEKTSV4RRFFQ69G5FAV/reopen', { method: 'POST' });
    expect(response.status).toBe(204);
    expect(todos.reopenCalls).toEqual(['01ARZ3NDEKTSV4RRFFQ69G5FAV']);
  });

  it('is a no-op, not an error, for a malformed id', async () => {
    const response = await app.request('/todos/not-a-ulid/reopen', { method: 'POST' });
    expect(response.status).toBe(204);
    expect(todos.reopenCalls).toEqual([]);
  });
});

/** The user checking a to-do off directly, any record, any time
 * (`requirements.md` §11) — new, not shared with any other structure. */
describe('POST /todos/:id/complete', () => {
  it('marks the record done directly, with no entry involved', async () => {
    const response = await app.request('/todos/01ARZ3NDEKTSV4RRFFQ69G5FAV/complete', { method: 'POST' });
    expect(response.status).toBe(204);
    expect(todos.completeDirectCalls).toEqual(['01ARZ3NDEKTSV4RRFFQ69G5FAV']);
  });

  it('is a no-op, not an error, for a malformed id', async () => {
    const response = await app.request('/todos/not-a-ulid/complete', { method: 'POST' });
    expect(response.status).toBe(204);
    expect(todos.completeDirectCalls).toEqual([]);
  });
});

/** `untouch` carries a new guard todos-only: a no-op on an `origin: 'user'`
 * record (`plan.md` M15) — see `TodosIndex.untouch`'s own doc comment for
 * why. Exercised at the HTTP level, not just the index level, since the
 * route itself must not special-case anything — the guard has to hold
 * entirely inside the reader. */
describe('POST /todos/:id/untouch', () => {
  it('reverts an extracted record to untouched', async () => {
    todos.records = [
      {
        id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        entryId: 'e1',
        text: 'Call the dentist',
        eventTime: '2026-07-20T20:00:00+01:00',
        eventEpochMs: Date.parse('2026-07-20T19:00:00Z'),
        eventTimeExplicit: true,
        extractedAt: '2026-07-20T21:00:00+01:00',
        status: 'open',
        doneEntryId: null,
        resolution: null,
        doneAt: null,
        origin: 'extracted',
        touched: true,
      },
    ];
    const response = await app.request('/todos/01ARZ3NDEKTSV4RRFFQ69G5FAV/untouch', { method: 'POST' });
    expect(response.status).toBe(204);
    expect(todos.records[0]!.touched).toBe(false);
  });

  it('is a true no-op on a user-origin record — touched stays true', async () => {
    const created = await app.request('/todos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Water the plants' }),
    });
    const { id } = (await created.json()) as Todo;

    const response = await app.request(`/todos/${id}/untouch`, { method: 'POST' });
    expect(response.status).toBe(204);

    const listed = await app.request('/todos');
    const body = (await listed.json()) as TodosResponse;
    expect(body.todos[0]).toMatchObject({ origin: 'user', touched: true });
  });
});

describe('GET/POST /todos/update-suggestions', () => {
  it('lists pending suggestions and lets the user approve or reject one', async () => {
    todos.updateSuggestions = [
      {
        id: 's1',
        recordId: 'm1',
        entryId: 'e1',
        text: 'reprocessed text',
        eventTime: '2026-07-20T20:00:00+01:00',
        eventEpochMs: Date.parse('2026-07-20T19:00:00Z'),
        eventTimeExplicit: true,
        reason: 'Reprocessing this entry now extracts different content.',
        status: 'pending',
        suggestedAt: '2026-07-21T00:00:00Z',
        decidedAt: null,
      },
    ];

    const listed = await app.request('/todos/update-suggestions');
    expect(((await listed.json()) as TodoUpdateSuggestionsResponse).suggestions).toHaveLength(1);

    const approved = await app.request('/todos/update-suggestions/s1/approve', { method: 'POST' });
    expect(approved.status).toBe(204);
    expect(todos.updateSuggestions[0]!.status).toBe('approved');
  });

  it('rejects an invalid status filter', async () => {
    const response = await app.request('/todos/update-suggestions?status=nonsense');
    expect(response.status).toBe(400);
  });
});

/** A separate suggestion mechanism from `update-suggestions` — closing a
 * touched to-do because a later entry says so, never applied silently
 * (`requirements.md` §11, `plan.md` M15). New, no representative coverage
 * elsewhere. */
describe('GET/POST /todos/completion-suggestions', () => {
  it('lists pending suggestions and lets the user approve or reject one', async () => {
    todos.completionSuggestions = [
      {
        id: 's1',
        recordId: 'm1',
        entryId: 'e2',
        resolution: 'Called and rescheduled.',
        reason: 'Reprocessing found this entry marks it done.',
        status: 'pending',
        suggestedAt: '2026-07-21T00:00:00Z',
        decidedAt: null,
      },
    ];

    const listed = await app.request('/todos/completion-suggestions');
    expect(((await listed.json()) as TodoCompletionSuggestionsResponse).suggestions).toHaveLength(1);

    const rejected = await app.request('/todos/completion-suggestions/s1/reject', { method: 'POST' });
    expect(rejected.status).toBe(204);
    expect(todos.completionSuggestions[0]!.status).toBe('rejected');
  });

  it('rejects an invalid status filter', async () => {
    const response = await app.request('/todos/completion-suggestions?status=nonsense');
    expect(response.status).toBe(400);
  });
});

describe('GET /categories', () => {
  it('returns the approved names for every structure type', async () => {
    categories.approved = {
      metric: ['exercise'],
      review_medium: ['film'],
      list_type: ['quote'],
      opinion_subject: ['philosophy'],
    };
    const response = await app.request('/categories');
    expect((await response.json()) as CategoriesResponse).toEqual({
      metric: ['exercise'],
      review_medium: ['film'],
      list_type: ['quote'],
      opinion_subject: ['philosophy'],
    });
  });
});

describe('POST /categories', () => {
  it('approves a category directly, with no suggestion step', async () => {
    const response = await app.request('/categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ structureType: 'metric', name: 'meditation' }),
    });
    expect(response.status).toBe(204);
    expect(categories.approveCalls).toEqual([{ structureType: 'metric', name: 'meditation' }]);
  });

  it('accepts opinion_subject — a real gap this closed: it was missing from the validation enum', async () => {
    const response = await app.request('/categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ structureType: 'opinion_subject', name: 'career' }),
    });
    expect(response.status).toBe(204);
    expect(categories.approveCalls).toEqual([{ structureType: 'opinion_subject', name: 'career' }]);
  });

  it('rejects an unknown structureType', async () => {
    const response = await app.request('/categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ structureType: 'nonsense', name: 'x' }),
    });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('invalid_request');
  });

  it('rejects a missing name', async () => {
    const response = await app.request('/categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ structureType: 'metric' }),
    });
    expect(response.status).toBe(400);
  });
});

describe('GET /categories/suggestions', () => {
  const suggestion = (overrides: Partial<CategorySuggestion> = {}): CategorySuggestion => ({
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    structureType: 'metric',
    name: 'meditation',
    reason: 'mentioned meditating',
    entryId: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
    status: 'pending',
    suggestedAt: '2026-07-20T09:00:00Z',
    decidedAt: null,
    ...overrides,
  });

  it('is empty, not an error, when nothing has been suggested', async () => {
    const response = await app.request('/categories/suggestions');
    expect((await response.json()) as SuggestionsResponse).toEqual({ suggestions: [] });
  });

  it('returns whatever the CategoriesReader produces', async () => {
    categories.suggestions = [suggestion()];
    const response = await app.request('/categories/suggestions');
    expect((await response.json()) as SuggestionsResponse).toEqual({ suggestions: [suggestion()] });
  });

  it('excludes metric-field enum-value suggestions from the unfiltered listing — they belong to /metrics/fields/:id/values/suggestions', async () => {
    categories.suggestions = [
      suggestion(),
      suggestion({ id: 's2', structureType: 'metric_field:exercise:sport', name: 'rowing' }),
    ];
    const response = await app.request('/categories/suggestions');
    const body = (await response.json()) as SuggestionsResponse;
    expect(body.suggestions.map((s) => s.id)).toEqual(['01ARZ3NDEKTSV4RRFFQ69G5FAV']);
  });

  it('rejects an unknown structureType filter', async () => {
    const response = await app.request('/categories/suggestions?structureType=nonsense');
    expect(response.status).toBe(400);
  });

  it('rejects an unknown status filter', async () => {
    const response = await app.request('/categories/suggestions?status=nonsense');
    expect(response.status).toBe(400);
  });
});

describe('POST /categories/suggestions/:id/approve and /reject', () => {
  it('approve calls decide with "approved"', async () => {
    const response = await app.request('/categories/suggestions/s1/approve', { method: 'POST' });
    expect(response.status).toBe(204);
    expect(categories.decideCalls).toEqual([{ id: 's1', decision: 'approved' }]);
  });

  it('reject calls decide with "rejected"', async () => {
    const response = await app.request('/categories/suggestions/s1/reject', { method: 'POST' });
    expect(response.status).toBe(204);
    expect(categories.decideCalls).toEqual([{ id: 's1', decision: 'rejected' }]);
  });
});

/** One structure's publish/unpublish routes are exercised in full;
 * `/reviews`, `/lists`, `/opinions/statements/`, `/questions` repeat the
 * identical shape (`plan.md` M16, same reasoning as M10's own tests). */
describe('POST /metrics/:id/publish and /unpublish', () => {
  const METRIC_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

  beforeEach(() => {
    metrics.records = [
      {
        id: METRIC_ID,
        entryId: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
        metric: 'exercise',
        eventTime: '2026-07-20T09:00:00+01:00',
        eventEpochMs: Date.parse('2026-07-20T08:00:00Z'),
        eventTimeExplicit: true,
        detail: 'a 5k run',
        fields: {},
        extractedAt: '2026-07-20T10:00:00+01:00',
        touched: false,
      },
    ];
  });

  it('publish makes it show as published; unpublish reverts that', async () => {
    const publish = await app.request(`/metrics/${METRIC_ID}/publish`, { method: 'POST' });
    expect(publish.status).toBe(204);

    const afterPublish = (await (await app.request('/metrics')).json()) as MetricsResponse;
    expect(afterPublish.metrics[0]?.published).toBe(true);

    const unpublish = await app.request(`/metrics/${METRIC_ID}/unpublish`, { method: 'POST' });
    expect(unpublish.status).toBe(204);

    const afterUnpublish = (await (await app.request('/metrics')).json()) as MetricsResponse;
    expect(afterUnpublish.metrics[0]?.published).toBe(false);
  });

  it('is a tolerant no-op for a malformed id', async () => {
    const response = await app.request('/metrics/not-a-ulid/publish', { method: 'POST' });
    expect(response.status).toBe(204);
  });
});

describe('GET/PUT /visibility-defaults', () => {
  it('is empty with nothing set', async () => {
    const response = await app.request('/visibility-defaults');
    expect((await response.json()) as VisibilityDefaultsResponse).toEqual({ defaults: [] });
  });

  it('PUT sets a default, reflected by GET', async () => {
    const put = await app.request('/visibility-defaults', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ structureType: 'review_medium', category: 'film', defaultPublic: true }),
    });
    expect(put.status).toBe(204);

    const response = await app.request('/visibility-defaults');
    expect((await response.json()) as VisibilityDefaultsResponse).toEqual({
      defaults: [{ structureType: 'review_medium', category: 'film', defaultPublic: true }],
    });
  });

  it('rejects a structure type outside the four core categories', async () => {
    const response = await app.request('/visibility-defaults', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ structureType: 'question', category: 'x', defaultPublic: true }),
    });
    expect(response.status).toBe(400);
  });
});

describe('GET /publish-queue', () => {
  const review = (id: string) => ({
    id,
    entryId: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
    title: 'Some Film',
    medium: 'film',
    rating: 4,
    progress: 100,
    opinion: 'Really enjoyed it.',
    eventTime: '2026-07-20T20:00:00+01:00',
    eventEpochMs: Date.parse('2026-07-20T19:00:00Z'),
    eventTimeExplicit: true,
    extractedAt: '2026-07-20T21:00:00+01:00',
    touched: false,
  });

  it('is empty with no defaults set, even with unpublished records present', async () => {
    reviews.records = [review('01ARZ3NDEKTSV4RRFFQ69G5FAV')];
    const response = await app.request('/publish-queue');
    expect((await response.json()) as PublishQueueResponse).toEqual({ items: [] });
  });

  it('surfaces a record once its category defaults to public, and drops it once published', async () => {
    reviews.records = [review('01ARZ3NDEKTSV4RRFFQ69G5FAV')];
    await app.request('/visibility-defaults', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ structureType: 'review_medium', category: 'film', defaultPublic: true }),
    });

    const queued = (await (await app.request('/publish-queue')).json()) as PublishQueueResponse;
    expect(queued.items).toEqual([
      {
        structureType: 'review_medium',
        category: 'film',
        id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        preview: 'Some Film',
        eventTime: '2026-07-20T20:00:00+01:00',
      },
    ]);

    await app.request('/reviews/01ARZ3NDEKTSV4RRFFQ69G5FAV/publish', { method: 'POST' });

    const afterPublish = (await (await app.request('/publish-queue')).json()) as PublishQueueResponse;
    expect(afterPublish.items).toEqual([]);
  });

  it('stops surfacing new unpublished records once the default is turned back off', async () => {
    reviews.records = [review('01ARZ3NDEKTSV4RRFFQ69G5FAV')];
    await app.request('/visibility-defaults', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ structureType: 'review_medium', category: 'film', defaultPublic: true }),
    });
    await app.request('/visibility-defaults', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ structureType: 'review_medium', category: 'film', defaultPublic: false }),
    });

    const response = (await (await app.request('/publish-queue')).json()) as PublishQueueResponse;
    expect(response.items).toEqual([]);
  });
});

describe('the boundary', () => {
  it('allows an allowlisted browser origin, and says so in the response', async () => {
    const response = await app.request('/entries', { headers: { Origin: ORIGIN } });
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN);
  });

  it('refuses an origin that is not on the allowlist', async () => {
    const response = await app.request('/entries', {
      headers: { Origin: 'http://evil.example' },
    });
    expect(response.status).toBe(403);
    expect((await errorOf(response)).code).toBe('forbidden_origin');
  });

  it('never answers with a wildcard origin', async () => {
    const response = await app.request('/entries', { headers: { Origin: ORIGIN } });
    expect(response.headers.get('access-control-allow-origin')).not.toBe('*');
  });

  it('allows a request with no Origin at all, which is what curl sends', async () => {
    expect((await app.request('/entries')).status).toBe(200);
  });

  it('refuses a host it does not serve, which is what defeats DNS rebinding', async () => {
    // Under rebinding the browser thinks it is same-origin and sends no Origin
    // header, so the allowlist above never sees the request. The Host does.
    const response = await app.request('http://evil.example/entries');
    expect(response.status).toBe(403);
    expect((await errorOf(response)).code).toBe('forbidden_origin');
  });

  it('answers on loopback under either name', async () => {
    expect((await app.request('http://127.0.0.1:4319/entries')).status).toBe(200);
    expect((await app.request('http://localhost:3000/entries')).status).toBe(200);
  });
});

describe('errors', () => {
  it('are structured, with a stable machine-readable code', async () => {
    const response = await app.request('/nowhere');
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
    const body = (await response.json()) as ApiError;
    expect(body.error).toMatchObject({ code: expect.any(String), message: expect.any(String) });
  });
});
