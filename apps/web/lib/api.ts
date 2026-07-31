import type {
  AddAttachmentResponse,
  ApiError,
  ApiErrorCode,
  ApproveCategoryRequest,
  CategoriesResponse,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  CreateEntryRequest,
  CreateEntryResponse,
  Entry,
  EntryPage,
  DefineMetricFieldRequest,
  ListItemsResponse,
  ListsSummaryResponse,
  MetricFieldsResponse,
  MetricFieldSummaryResponse,
  MetricFieldSuggestionsResponse,
  MetricFieldValuesResponse,
  MetricsResponse,
  MetricsSummaryResponse,
  OpinionStatementsResponse,
  OpinionSummariesResponse,
  QuestionsResponse,
  QuestionsSummaryResponse,
  ReviewsResponse,
  ReviewsSummaryResponse,
  SearchResponse,
  StructureType,
  SuggestionsResponse,
  TranscribeResponse,
  UpdateEntryRequest,
  UpdateEntryResponse,
} from '@journal/contract';

/**
 * The only way this frontend reaches anything.
 *
 * Transport and nothing else — no parsing, no aggregation, no decisions about
 * entries. All of that lives behind the API (`requirements.md` §7.1,
 * `design.md` §6.3).
 *
 * It goes over HTTP even though both processes sit on the same machine. That is
 * the point: running locally does not license a shortcut across the boundary,
 * because going online later must be a deployment change rather than a rewrite
 * (`design.md` §6.4, `requirements.md` §7.2).
 */

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://127.0.0.1:4319';

/** A failure that reached us as a structured error, or as no response at all. */
export class ApiRequestError extends Error {
  readonly code: ApiErrorCode | 'unreachable';

  constructor(code: ApiErrorCode | 'unreachable', message: string) {
    super(message);
    this.name = 'ApiRequestError';
    this.code = code;
  }
}

const UNREACHABLE =
  'The journal backend is not answering. Start it with `npm run dev:api` and reload.';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      // Never a cached read. What is on disk is the truth, and a journal must
      // not show a stale copy of it.
      cache: 'no-store',
    });
  } catch {
    throw new ApiRequestError('unreachable', UNREACHABLE);
  }

  if (!response.ok) {
    let code: ApiErrorCode = 'internal';
    let message = `The request failed (${response.status}).`;
    try {
      const body = (await response.json()) as ApiError;
      if (body?.error?.code) {
        code = body.error.code;
        message = body.error.message;
      }
    } catch {
      /* a response with no structured body; the status is all we have */
    }
    throw new ApiRequestError(code, message);
  }

  // 204 No Content — DELETE's response. There is no body to parse.
  if (response.status === 204) return undefined as T;

  return (await response.json()) as T;
}

export function listEntries(options: { cursor?: string; limit?: number } = {}): Promise<EntryPage> {
  const query = new URLSearchParams();
  if (options.cursor) query.set('cursor', options.cursor);
  if (options.limit !== undefined) query.set('limit', String(options.limit));
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return request<EntryPage>(`/entries${suffix}`);
}

/** `null` for an entry that is not there, which is a normal answer, not a failure. */
export async function getEntry(id: string): Promise<Entry | null> {
  try {
    return await request<Entry>(`/entries/${encodeURIComponent(id)}`);
  } catch (error) {
    if (error instanceof ApiRequestError && error.code === 'entry_not_found') return null;
    throw error;
  }
}

export function createEntry(entry: CreateEntryRequest): Promise<CreateEntryResponse> {
  return request<CreateEntryResponse>('/entries', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(entry),
  });
}

/**
 * Change an entry's body. Throws `ApiRequestError` with code `edit_conflict`
 * if `input.contentHash` no longer matches what is on disk — the caller must
 * treat that as "stop and tell the user," never retry with the same hash.
 */
export function updateEntry(id: string, input: UpdateEntryRequest): Promise<UpdateEntryResponse> {
  return request<UpdateEntryResponse>(`/entries/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

/**
 * The one narrow deletion the format allows: discard a draft that turned out
 * to be whitespace-only (`format.md` §5). Never a general-purpose delete —
 * the backend itself refuses to remove anything with real content in it.
 */
export async function discardEntry(id: string): Promise<void> {
  await request<undefined>(`/entries/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/**
 * Store a file alongside an entry (`format.md` §4). Resolves to the relative
 * link fragment — inserting it into the body is the caller's job, the same
 * way any other text lands there.
 */
export function addAttachment(entryId: string, file: Blob, filename: string): Promise<AddAttachmentResponse> {
  const form = new FormData();
  form.set('file', file, filename);
  return request<AddAttachmentResponse>(`/entries/${encodeURIComponent(entryId)}/attachments`, {
    method: 'POST',
    body: form,
  });
}

/**
 * Search by meaning, not only by word (`requirements.md` §8, `plan.md` M6).
 * Each hit is a passage, not merely an entry — the backend has already found
 * the part that matched.
 */
export function search(query: string, limit?: number): Promise<SearchResponse> {
  const params = new URLSearchParams({ q: query });
  if (limit !== undefined) params.set('limit', String(limit));
  return request<SearchResponse>(`/search?${params.toString()}`);
}

/**
 * Extracted temporal metrics (`plan.md` M7, `requirements.md` §5.2) — never
 * live, only whatever a past `npm run reprocess` last wrote.
 */
export function listMetrics(options: { metric?: string; limit?: number } = {}): Promise<MetricsResponse> {
  const query = new URLSearchParams();
  if (options.metric) query.set('metric', options.metric);
  if (options.limit !== undefined) query.set('limit', String(options.limit));
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return request<MetricsResponse>(`/metrics${suffix}`);
}

/** Discard one wrong record (`requirements.md` §6.2) — correction, not a
 * general-purpose edit; the record is simply gone, not revised in place. */
export async function deleteMetric(id: string): Promise<void> {
  await request<undefined>(`/metrics/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/**
 * User-defined structured fields per metric (`plan.md` M9) — grown the same
 * two ways as every other open-ended category: the AI suggesting one during
 * extraction, or the user defining one directly here.
 */
export function listMetricFields(metric?: string): Promise<MetricFieldsResponse> {
  const suffix = metric ? `?metric=${encodeURIComponent(metric)}` : '';
  return request<MetricFieldsResponse>(`/metrics/fields${suffix}`);
}

export async function defineMetricField(field: DefineMetricFieldRequest): Promise<void> {
  await request<undefined>('/metrics/fields', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(field),
  });
}

export async function deleteMetricField(id: string): Promise<void> {
  await request<undefined>(`/metrics/fields/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function listMetricFieldSuggestions(options: { metric?: string; status?: string } = {}): Promise<MetricFieldSuggestionsResponse> {
  const query = new URLSearchParams();
  if (options.metric) query.set('metric', options.metric);
  if (options.status) query.set('status', options.status);
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return request<MetricFieldSuggestionsResponse>(`/metrics/fields/suggestions${suffix}`);
}

export async function approveMetricFieldSuggestion(id: string): Promise<void> {
  await request<undefined>(`/metrics/fields/suggestions/${encodeURIComponent(id)}/approve`, { method: 'POST' });
}

export async function rejectMetricFieldSuggestion(id: string): Promise<void> {
  await request<undefined>(`/metrics/fields/suggestions/${encodeURIComponent(id)}/reject`, { method: 'POST' });
}

/** An enum field's approved values — reuses `CategoriesIndex` behind the
 * scenes, but addressed through this dedicated surface rather than
 * `/categories`, whose `structureType` enum is closed to the four core
 * types. Suggestions here are decided through the same
 * `approveSuggestion`/`rejectSuggestion` as every other category
 * suggestion — the mechanism is identical, only the listing is scoped. */
export function listMetricFieldValues(fieldId: string): Promise<MetricFieldValuesResponse> {
  return request<MetricFieldValuesResponse>(`/metrics/fields/${encodeURIComponent(fieldId)}/values`);
}

export async function approveMetricFieldValue(fieldId: string, value: string): Promise<void> {
  await request<undefined>(`/metrics/fields/${encodeURIComponent(fieldId)}/values`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value }),
  });
}

export function listMetricFieldValueSuggestions(fieldId: string, status?: string): Promise<SuggestionsResponse> {
  const suffix = status ? `?status=${encodeURIComponent(status)}` : '';
  return request<SuggestionsResponse>(`/metrics/fields/${encodeURIComponent(fieldId)}/values/suggestions${suffix}`);
}

/**
 * Extracted reviews (`plan.md` M8, `requirements.md` §5.2) — never live,
 * only whatever a past `npm run reprocess` last wrote.
 */
export function listReviews(options: { medium?: string; limit?: number } = {}): Promise<ReviewsResponse> {
  const query = new URLSearchParams();
  if (options.medium) query.set('medium', options.medium);
  if (options.limit !== undefined) query.set('limit', String(options.limit));
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return request<ReviewsResponse>(`/reviews${suffix}`);
}

export async function deleteReview(id: string): Promise<void> {
  await request<undefined>(`/reviews/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/**
 * Extracted atomic list items (`plan.md` M8, `requirements.md` §5.2) — for
 * example quotes.
 */
export function listListItems(options: { listType?: string; limit?: number } = {}): Promise<ListItemsResponse> {
  const query = new URLSearchParams();
  if (options.listType) query.set('listType', options.listType);
  if (options.limit !== undefined) query.set('limit', String(options.limit));
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return request<ListItemsResponse>(`/lists${suffix}`);
}

export async function deleteListItem(id: string): Promise<void> {
  await request<undefined>(`/lists/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/**
 * Extracted opinion statements — layer 1 of the opinion model (`plan.md`
 * M8, `requirements.md` §5.2) — one per entry per subject, never live, only
 * whatever a past `npm run reprocess` last wrote.
 */
export function listOpinionStatements(options: { subject?: string; limit?: number } = {}): Promise<OpinionStatementsResponse> {
  const query = new URLSearchParams();
  if (options.subject) query.set('subject', options.subject);
  if (options.limit !== undefined) query.set('limit', String(options.limit));
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return request<OpinionStatementsResponse>(`/opinions/statements${suffix}`);
}

export async function deleteOpinionStatement(id: string): Promise<void> {
  await request<undefined>(`/opinions/statements/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/**
 * The regenerated, cited per-subject summaries — layer 2 of the opinion
 * model. Never hand-edited; a wrong part is fixed by discarding the
 * statement it cites and re-running `reprocess` (`requirements.md` §9).
 */
export function listOpinionSummaries(subject?: string): Promise<OpinionSummariesResponse> {
  const suffix = subject ? `?subject=${encodeURIComponent(subject)}` : '';
  return request<OpinionSummariesResponse>(`/opinions/summaries${suffix}`);
}

/**
 * Open questions (`plan.md` M8c) — something raised in one entry, possibly
 * resolved by a later one. Never live, only whatever a past `npm run
 * reprocess` last wrote.
 */
export function listQuestions(options: { status?: 'open' | 'resolved'; limit?: number } = {}): Promise<QuestionsResponse> {
  const query = new URLSearchParams();
  if (options.status) query.set('status', options.status);
  if (options.limit !== undefined) query.set('limit', String(options.limit));
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return request<QuestionsResponse>(`/questions${suffix}`);
}

export async function deleteQuestion(id: string): Promise<void> {
  await request<undefined>(`/questions/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** Reverts a resolution without discarding the original question — for
 * when the match itself was wrong, not the question (`requirements.md`
 * §6.2). */
export async function reopenQuestion(id: string): Promise<void> {
  await request<undefined>(`/questions/${encodeURIComponent(id)}/reopen`, { method: 'POST' });
}

/**
 * The approved category names extraction may use, per structure type
 * (`plan.md` M8, `requirements.md` §5.3).
 */
export function listCategories(): Promise<CategoriesResponse> {
  return request<CategoriesResponse>('/categories');
}

/** The user requesting a category directly — approved immediately, no
 * suggestion or review step (`requirements.md` §5.3's second route). */
export async function approveCategory(structureType: StructureType, name: string): Promise<void> {
  const body: ApproveCategoryRequest = { structureType, name };
  await request<undefined>('/categories', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Categories the AI has suggested but a human has not yet decided on
 * (`requirements.md` §5.3's first route). */
export function listSuggestions(options: { structureType?: StructureType; status?: string } = {}): Promise<SuggestionsResponse> {
  const query = new URLSearchParams();
  if (options.structureType) query.set('structureType', options.structureType);
  if (options.status) query.set('status', options.status);
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return request<SuggestionsResponse>(`/categories/suggestions${suffix}`);
}

export async function approveSuggestion(id: string): Promise<void> {
  await request<undefined>(`/categories/suggestions/${encodeURIComponent(id)}/approve`, { method: 'POST' });
}

export async function rejectSuggestion(id: string): Promise<void> {
  await request<undefined>(`/categories/suggestions/${encodeURIComponent(id)}/reject`, { method: 'POST' });
}

/**
 * Aggregated data for the analysis surfaces (`plan.md` M8, `design.md`
 * §5.3) — already computed behind the API (`requirements.md` §7.1); this
 * frontend only ever renders what comes back, never sums or averages
 * anything itself.
 */
export function analysisMetrics(): Promise<MetricsSummaryResponse> {
  return request<MetricsSummaryResponse>('/analysis/metrics');
}

export function analysisReviews(): Promise<ReviewsSummaryResponse> {
  return request<ReviewsSummaryResponse>('/analysis/reviews');
}

export function analysisLists(): Promise<ListsSummaryResponse> {
  return request<ListsSummaryResponse>('/analysis/lists');
}

export function analysisQuestions(): Promise<QuestionsSummaryResponse> {
  return request<QuestionsSummaryResponse>('/analysis/questions');
}

/** A numeric field's total/average across a window, optionally filtered to
 * another field's value (`plan.md` M9) — e.g. total distance where sport is
 * rowing. Computed entirely behind the API; nothing here sums anything. */
export function analysisMetricField(
  metric: string,
  fieldKey: string,
  options: { filter?: { field: string; value: string }; windowDays?: number } = {},
): Promise<MetricFieldSummaryResponse> {
  const query = new URLSearchParams();
  if (options.filter) query.set('filter', `${options.filter.field}:${options.filter.value}`);
  if (options.windowDays !== undefined) query.set('windowDays', String(options.windowDays));
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return request<MetricFieldSummaryResponse>(
    `/analysis/metrics/${encodeURIComponent(metric)}/fields/${encodeURIComponent(fieldKey)}${suffix}`,
  );
}

/**
 * One turn of the chat feature ("further features", `requirements.md` §8).
 * Ephemeral — nothing about the conversation is stored behind the API, so
 * the caller sends the whole conversation so far on every turn. Everything
 * about which tools to call and how to answer happens behind this one
 * request (`requirements.md` §7.1) — this function is transport, nothing else.
 */
export function chat(messages: ChatMessage[]): Promise<ChatResponse> {
  return request<ChatResponse>('/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages } satisfies ChatRequest),
  });
}

/**
 * Transcribe raw PCM samples (`requirements.md` §4.7). Sends the samples'
 * exact bytes, not a re-encoded copy — see `lib/recorder.ts` for why nothing
 * arrives here in a compressed format that would need decoding.
 */
export function transcribe(samples: Float32Array, sampleRate: number): Promise<TranscribeResponse> {
  return request<TranscribeResponse>(`/transcribe?sampleRate=${sampleRate}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: new Blob([samples.buffer as ArrayBuffer]),
  });
}
