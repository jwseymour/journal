/**
 * The API contract between the frontend and the backend.
 *
 * This package is types only. It has no dependencies and emits no runtime code,
 * so importing it can never drag storage, validation, or provider detail across
 * the boundary (`requirements.md` §7.1). Import everything from here with
 * `import type`.
 *
 * These shapes are what a replacement frontend would be written against, and
 * what a hosted backend would have to keep serving. Treat them as a published
 * interface rather than an internal convenience.
 */

/**
 * WGS 84 decimal degrees, at whatever precision the device reported.
 *
 * Never rounded — the point is to keep exactly what was captured, however
 * irrelevant the trailing digits turn out to be (`format.md` §3).
 */
export interface Coordinates {
  lat: number;
  lon: number;
}

/**
 * Everything an entry records about itself.
 *
 * Three fields, and no others. There is no title, no tag, no word count, no
 * modification time (`requirements.md` §4.3). `location` is *absent* when
 * unavailable rather than null or empty, which is why it is optional here and
 * why `exactOptionalPropertyTypes` is on.
 */
export interface EntryMetadata {
  /** A ULID. Assigned once at creation, never changes, never reused. */
  id: string;

  /**
   * RFC 3339, always carrying a UTC offset — `2026-07-26T22:55:13+01:00`.
   *
   * A local time without an offset is permanently ambiguous, which matters
   * given an expectation of travel (`requirements.md` §4.3). Kept as a string
   * rather than a `Date` precisely because `Date` cannot hold the offset.
   */
  created: string;

  location?: Coordinates;
}

/**
 * An entry as it appears in a list: metadata plus enough prose to recognise it.
 *
 * The excerpt is cut by the backend. The frontend renders the string it is
 * given and does not know how it was produced (`requirements.md` §7.1).
 */
export interface EntrySummary extends EntryMetadata {
  excerpt: string;
}

/** An entry in full. The body is exactly the bytes on disk, minus frontmatter.
 * `published` is computed, the same way `Document.published` is (see
 * `Published`'s own comment) — never a field written into the file itself
 * (`requirements.md` §4.3's "nothing else" stays about file frontmatter, not
 * about this kind of derived, always-recomputed status). */
export interface Entry extends EntryMetadata, Published {
  body: string;

  /**
   * An opaque fingerprint of exactly what is on disk right now.
   *
   * Not a hash of anything the caller should interpret — just a value that
   * changes if and only if the file's bytes change. Pass it back on
   * `PUT /entries/:id` as a precondition: if it no longer matches what is on
   * disk, the write is rejected with `edit_conflict` rather than silently
   * overwriting someone else's change.
   *
   * This matters specifically because these files are meant to be opened in an
   * ordinary text editor — that is a stated benefit of plain files, not an edge
   * case (`plan.md` M2) — so the backend can never assume it is the only writer.
   */
  contentHash: string;
}

/**
 * One page of entries, newest first.
 *
 * Ordered by `created` descending, with `id` descending as the tiebreak. The
 * cursor is opaque: it encodes a position in that ordering and nothing the
 * caller should parse. Pagination is cursor-based from the first commit so that
 * swapping a directory scan for an index (M5) does not change this shape.
 */
export interface EntryPage {
  entries: EntrySummary[];
  /** Pass back as `cursor` for the next page. `null` means this was the last. */
  nextCursor: string | null;
}

/**
 * One calendar month that has at least one entry in it, local to each
 * entry's own `created` offset — the same `YYYY-MM` grouping the on-disk
 * `journal/YYYY/MM/` layout already uses.
 *
 * Deliberately just the label, never a count: an entry count is an
 * aggregate over writing behaviour, which this application never shows
 * (`design.md` §4, `plan.md` standing rule 7). This type must not grow one.
 */
export interface EntryPeriod {
  year: number;
  month: number;
}

export interface EntryPeriodsResponse {
  /** Every month with an entry, newest first. */
  periods: EntryPeriod[];
}

/**
 * Creating an entry.
 *
 * `created` and `location` come from the client because only the client knows
 * the user's UTC offset and position. That is device state, not business logic,
 * so it does not breach "no logic in the frontend" — and the backend must not
 * assume it shares a clock or a timezone with the user, because one day it
 * will not (`requirements.md` §7.2).
 *
 * Both are optional. Omitting `created` falls back to the server's own local
 * time, which keeps `curl` usable; omitting `location` means no location, and
 * nothing is recorded.
 */
export interface CreateEntryRequest {
  body: string;
  created?: string;
  location?: Coordinates;
}

/**
 * The result of creating an entry.
 *
 * `path` is where the file landed, relative to the journal root, with POSIX
 * separators — `journal/2026/07/2026-07-26-2255-abcde8.md`.
 *
 * It is **informational only**: something to `cat` while developing, and a
 * reassurance that a real file exists. It is never a key. Nothing may resolve
 * an entry by it, store it, or reconstruct it, because identity lives in the
 * `id` and a file that is renamed by hand must not break anything
 * (`requirements.md` §4.2). A hosted backend is free to make it meaningless.
 */
export interface CreateEntryResponse {
  id: string;
  created: string;
  path: string;
  /** See `Entry.contentHash`. Needed immediately: the draft lifecycle autosaves
   * the same entry right after creating it, and that first save needs a
   * precondition to check against. */
  contentHash: string;
}

/**
 * Editing an entry — body only.
 *
 * `id`, `created` and `location` describe the act of writing and never change
 * after creation, edit or not (`requirements.md` §4.3). An edit changes what
 * was written, not when or where it was written, so this is the entire
 * request: the new text, and proof the caller has seen the current version.
 */
export interface UpdateEntryRequest {
  body: string;
  /** Must match the current `Entry.contentHash`, or the write is rejected. */
  contentHash: string;
}

/** The entry as it stands after the edit, including its new `contentHash`. */
export type UpdateEntryResponse = Entry;

/**
 * The result of running live extraction for one entry — every structure
 * type, one call each (`plan.md` M18). Unlike before M18, nothing here
 * commits directly: every candidate becomes a `PendingExtractionItem`
 * awaiting explicit approval (`requirements.md` §6.1, rewritten at M18).
 * Safe to call more than once on the same entry — a fresh run supersedes
 * any still-`pending` items from an earlier run on the same entry, and
 * diffs its candidates against everything already live, not only what has
 * been individually touched, so nothing duplicates.
 *
 * `pendingItemCount` is how many items this pass produced (`'new'`,
 * `'update'`, `'resolution'`, `'completion'` combined) — fetch
 * `GET /pending-items?entryId=&processRunId=` for the actual items.
 */
export interface ProcessEntryResponse {
  pendingItemCount: number;
  processRunId: string;
}

/** The three confidence tiers a live extraction candidate is tagged with
 * (`plan.md` M18). Only `'medium'`/`'high'` ever reach a `PendingExtractionItem`
 * — `'low'` is dropped by `LivePendingProcessor` before it becomes one, so a
 * `PendingExtractionItem.confidence` of `'low'` should not occur for anything
 * produced after that cutoff shipped. Confidence otherwise arranges the
 * review popup/queue (lowest-surfaced-confidence first, within its
 * structure-type group); discarded the moment an item is approved, never
 * stored on the committed record. A coarse categorical tier rather than a
 * numeric score: models are not reliably calibrated self-reporters of a
 * continuous probability, and every other open-ended judgment in this schema
 * (`MetricFieldType`, `eventTimeExplicit`) is already a small enum, not a
 * float. */
export type PendingItemConfidence = 'high' | 'medium' | 'low';

export type PendingItemStructureType = 'metric' | 'review' | 'list_item' | 'opinion_statement' | 'question' | 'todo';

/** What kind of candidate this is (`plan.md` M18):
 * - `'new'` — no live record exists yet; approving creates one.
 * - `'update'` — a fresh extraction differs from an already-live record
 *   (`targetRecordId`); approving applies it via that structure's own
 *   `update()`, the same as an approved `*UpdateSuggestion` today.
 * - `'resolution'` — this entry appears to resolve an open question, or an
 *   open `kind: 'question'` opinion statement (`targetRecordId` names it);
 *   approving calls that structure's own `resolveApproved`, bypassing the
 *   touched-record guard the same way an approved `TodoCompletionSuggestion`
 *   already bypasses todos' — the fix for the gap `QuestionsIndex.resolve()`'s
 *   own comment has flagged since M10.
 * - `'completion'` — this entry appears to complete an open to-do
 *   (`targetRecordId` names it); approving calls the to-do's completion
 *   path, same bypass. */
export type PendingItemKind = 'new' | 'update' | 'resolution' | 'completion';

/** One candidate produced by a live `POST /entries/:id/process` run
 * (`plan.md` M18), awaiting explicit approval — nothing before this point
 * is ever silently committed. `payload` carries the type-specific fields a
 * `'new'`/`'update'` item would write, or the resolution/completion text
 * for the other two kinds — see `apps/api/src/model/pending-item-applier.ts`
 * for exactly how each `(structureType, kind)` pair is applied.
 * `category` is the record's metric/medium/listType/subject, denormalized
 * for grouping and the visibility-default check on approval — `null` for
 * question/todo, which have no category. */
export interface PendingExtractionItem {
  id: string;
  entryId: string;
  processRunId: string;
  structureType: PendingItemStructureType;
  kind: PendingItemKind;
  /** The existing live record this item targets — present for every kind
   * except `'new'`. */
  targetRecordId: string | null;
  category: string | null;
  payload: Record<string, unknown>;
  confidence: PendingItemConfidence;
  /** A brief note from the model, mainly meaningful when confidence is not
   * `'high'` — why it read the entry this way. */
  reason: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'superseded';
  createdAt: string;
  decidedAt: string | null;
}

export interface PendingItemsResponse {
  items: PendingExtractionItem[];
}

/** What makes "approve all pending metrics" one click instead of many
 * (`plan.md` M18) — applies each id's approval independently, so one bad
 * item in the batch cannot block the rest. */
export interface ApproveBatchRequest {
  ids: string[];
}

export interface ApproveBatchResponse {
  approved: string[];
  failed: { id: string; error: string }[];
}

/** Whether an entry's live extraction is current (`plan.md` M18) — compares
 * the entry's present `contentHash` against the hash stored the last time
 * `POST /entries/:id/process` completed. `'never_processed'` if it has
 * never been run at all. */
export interface EntryStatusResponse {
  state: 'never_processed' | 'stale' | 'up_to_date';
}

/**
 * The result of attaching a file to an entry (`format.md` §4).
 *
 * `relativeLink` is meant to be written straight into the entry's own body,
 * exactly as given — `![](2026-07-26-2255-abcde8/photo.jpg)`. Unlike
 * `CreateEntryResponse.path`, this is not informational: it is the actual
 * markdown link fragment, because that is the one thing a caller attaching a
 * file needs in order to finish the job — inserting it into the text is still
 * the user's own act, same as any other keystroke (`requirements.md` §4.4).
 */
export interface AddAttachmentResponse {
  relativeLink: string;
}

/**
 * Everything a document records about itself (`requirements.md` §9).
 *
 * A document is not an entry: it has a title, it is revised repeatedly over
 * its working life rather than written once, and its identity has nothing
 * to do with when it was started (`requirements.md` §9.1). `updated` exists
 * here for exactly that reason — entries deliberately have no modification
 * time (`EntryMetadata`), but a document's whole point is being returned to.
 */
export interface DocumentMetadata {
  /** A ULID. Assigned once at creation, never changes, never reused. */
  id: string;

  title: string;

  /** RFC 3339, always carrying a UTC offset — same shape as `EntryMetadata.created`. */
  created: string;

  /** RFC 3339, always carrying a UTC offset. Moves on every edit. */
  updated: string;

  /**
   * Entries this document cites, by id — a pointer added by hand, never a
   * derivation (`requirements.md` §9.2). Citing an entry does not pull its
   * content in; a document's text is always written directly. Omitted
   * entirely when empty, the same "absent, not empty" convention
   * `EntryMetadata.location` uses.
   */
  citedEntries?: string[];
}

/** Whether this record is currently readable through the public-facing
 * surface (`requirements.md` §9.3, §10, §11) — computed from whether a
 * rendered snapshot of it exists in the `public/` S3 mirror (`plan.md` M15,
 * M16), never a field stored on the record itself (an entry or document
 * frontmatter, or a derived-structure row). Flipped only by the matching
 * `POST .../:id/publish`/`.../unpublish` route — a deliberate act distinct
 * from an ordinary edit or extraction, never a side effect of either.
 * Shared by documents (M15), entries (M18 — the Publish button on an
 * entry's own page finally needed to read this back, not only set it), and
 * the five touchable derived-structure types — metrics, reviews, list
 * items, opinion statements, questions (M16). */
export interface Published {
  published: boolean;
}

/** A document as it appears in a list: metadata plus enough prose to recognise it. */
export interface DocumentSummary extends DocumentMetadata, Published {
  excerpt: string;
}

/** A document in full. The body is exactly the bytes on disk, minus frontmatter. */
export interface Document extends DocumentMetadata, Published {
  body: string;

  /** Same role as `Entry.contentHash` — an optimistic-concurrency precondition
   * for `PUT /documents/:id`, not a value to interpret. */
  contentHash: string;
}

/**
 * One page of documents, newest-*updated*-first — deliberately different
 * ordering from `EntryPage`'s newest-created-first: a working set of
 * documents is more usefully surfaced by what was worked on most recently
 * than by when it was started (`requirements.md` §9.1).
 */
export interface DocumentPage {
  documents: DocumentSummary[];
  /** Pass back as `cursor` for the next page. `null` means this was the last. */
  nextCursor: string | null;
}

/** Creating a document. A title is required — unlike an entry, a document
 * is a deliberate act, not something that exists from the first keystroke. */
export interface CreateDocumentRequest {
  title: string;
  body: string;
  citedEntries?: string[];
}

/** The result of creating a document. `path` is informational only, exactly
 * as `CreateEntryResponse.path` is (`requirements.md` §4.2's identity-lives-in-id
 * principle applies here too). */
export interface CreateDocumentResponse {
  id: string;
  created: string;
  path: string;
  contentHash: string;
}

/**
 * Editing a document — a full replace of every editable field, not a patch.
 * `id` and `created` never move; `updated` is set by the server. This
 * mirrors `UpdateEntryRequest`'s shape, not the partial-patch shape M10's
 * touched-record types use — a document is directly authored like an entry,
 * never AI-derived, so there is nothing to patch around.
 */
export interface UpdateDocumentRequest {
  title: string;
  body: string;
  citedEntries?: string[];
  /** Must match the current `Document.contentHash`, or the write is rejected. */
  contentHash: string;
}

/** The document as it stands after the edit, including its new `contentHash`. */
export type UpdateDocumentResponse = Document;

/**
 * Publishing or unpublishing a document (`requirements.md` §9.3, `plan.md`
 * M15) — `POST /documents/:id/publish` and `.../unpublish`, no request
 * body: publishing copies a snapshot of whatever is currently saved into
 * the `public/` mirror, it never carries new content of its own, so there
 * is nothing to submit and nothing to guard with a `contentHash`.
 */
export type PublishDocumentResponse = Document;

/**
 * The result of transcribing a recording (`requirements.md` §4.7).
 *
 * Deliberately the only field. Nothing about *which* model produced it, no
 * confidence score, nothing that would leak provider detail across the
 * boundary (`plan.md` standing rule 8) — a transcript is text, exactly like
 * anything else that ends up in an entry's body.
 */
export interface TranscribeResponse {
  text: string;
}

/**
 * One matching passage from a search (`plan.md` M6/M17, `requirements.md`
 * §8).
 *
 * A hit is a paragraph, not a whole entry or document — "search by meaning"
 * means finding the part of a source that answers the query, so `passage`
 * is what matched. `sourceType` discriminates which kind of source it came
 * from (`plan.md` M17 added documents alongside entries), and the rest of
 * each variant is enough to link back to that source without a second round
 * trip for the common case of showing a result list.
 */
export interface EntrySearchHit {
  sourceType: 'entry';
  entryId: string;
  created: string;
  location?: Coordinates;
  /** The paragraph that matched, exactly as written. */
  passage: string;
}

export interface DocumentSearchHit {
  sourceType: 'document';
  documentId: string;
  title: string;
  created: string;
  /** The paragraph that matched, exactly as written. */
  passage: string;
}

export type SearchHit = EntrySearchHit | DocumentSearchHit;

/** The result of a search. Empty, not an error, when nothing matches. */
export interface SearchResponse {
  hits: SearchHit[];
}

/**
 * One extracted temporal metric (`plan.md` M7, `requirements.md` §5.2) —
 * something explicitly stated in an entry and stored against time.
 * `entryId` is what "every derived record links back to its source entry"
 * (`requirements.md` §3) means in practice.
 */
export interface TemporalMetric extends Published {
  id: string;
  entryId: string;
  /** Open-ended in principle (`requirements.md` §5.2); in practice, exactly
   * the seed set the AI is allowed to extract against today — see
   * `apps/api/src/model/temporal-metrics.ts`. */
  metric: string;
  /** When the thing happened, not when the entry was written
   * (`requirements.md` §6.3). RFC 3339 with a UTC offset. */
  eventTime: string;
  /** Whether the entry itself stated a time, or this was defaulted to the
   * entry's own written time because it said nothing about when. */
  eventTimeExplicit: boolean;
  detail: string;
  /** User-defined structured values (`MetricFieldDefinition`), keyed by
   * `fieldKey`, `null` for anything the entry didn't state — never guessed.
   * Empty for a metric with no fields defined. */
  fields: Record<string, string | number | null>;
  /** Whether the user has reviewed, corrected, or edited this record
   * (`requirements.md` §2, §6.4, `plan.md` M10). Once touched, a reprocess
   * never overwrites it silently — at most it proposes an update. */
  touched: boolean;
}

export interface MetricsResponse {
  metrics: TemporalMetric[];
}

/** The editable subset of a metric — everything except `id`, `entryId`,
 * `metric` (an approved category, not free content), and `touched` itself
 * (`plan.md` M10). Only the fields present change; everything else is left
 * as stored. */
export interface UpdateMetricRequest {
  detail?: string;
  fields?: Record<string, string | number | null>;
  eventTime?: string;
  eventTimeExplicit?: boolean;
}

/** An AI-proposed update to a record the user has already touched
 * (`plan.md` M10) — never applied automatically, only ever offered, the
 * same shape as `MetricFieldSuggestion` but proposing a change to an
 * existing record rather than a new field. */
export interface MetricUpdateSuggestion {
  id: string;
  recordId: string;
  entryId: string;
  detail: string;
  fields: Record<string, string | number | null>;
  eventTime: string;
  eventTimeExplicit: boolean;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  suggestedAt: string;
}

export interface MetricUpdateSuggestionsResponse {
  suggestions: MetricUpdateSuggestion[];
}

/**
 * A user-defined structured field for one metric — e.g. `exercise` gaining
 * `sport` (an `enum`) or `distance_km` (`numeric`, unit `km`). Grown the
 * same two ways as every open-ended category: the AI suggests one
 * (`MetricFieldSuggestion`), or the user defines one directly.
 */
export type MetricFieldType = 'numeric' | 'enum' | 'text' | 'score';

export interface MetricFieldDefinition {
  id: string;
  metric: string;
  fieldKey: string;
  label: string;
  fieldType: MetricFieldType;
  /** Numeric fields only — descriptive metadata, never used for conversion. */
  unit: string | null;
  /** Score fields only — the scale's inclusive bounds. */
  scoreMin: number | null;
  scoreMax: number | null;
  /** What this field captures — fed into the extraction prompt verbatim. */
  description: string;
}

export interface MetricFieldsResponse {
  fields: MetricFieldDefinition[];
}

/** The user defining a field directly (`requirements.md` §5.3's second
 * route, extended from category names to fields). */
export interface DefineMetricFieldRequest {
  metric: string;
  fieldKey: string;
  label: string;
  fieldType: MetricFieldType;
  unit?: string;
  scoreMin?: number;
  scoreMax?: number;
  description: string;
}

/** Editing a field already defined (`PATCH /metrics/fields/:id`) —
 * deliberately excludes `metric`, `fieldKey`, and `fieldType`: those are
 * the field's identity and the shape of every value already stored under
 * it, so changing them is a remove-and-redefine, not an edit. Only keys
 * present change; everything else is left as stored, the same partial-edit
 * shape every touchable structure's own `Update*Request` already uses. */
export interface UpdateMetricFieldRequest {
  label?: string;
  description?: string;
  unit?: string | null;
  scoreMin?: number | null;
  scoreMax?: number | null;
}

/** The field as it stands after the edit. */
export type UpdateMetricFieldResponse = MetricFieldDefinition;

/** A field the AI proposed but a human has not yet decided on
 * (`requirements.md` §5.3's first route, extended from category names to
 * fields). `entryId` is the entry that prompted it. */
export interface MetricFieldSuggestion {
  id: string;
  metric: string;
  fieldKey: string;
  label: string;
  fieldType: MetricFieldType;
  unit: string | null;
  scoreMin: number | null;
  scoreMax: number | null;
  description: string;
  reason: string;
  entryId: string;
  /** `'parked'` (`plan.md` M18): set aside to reconsider later, neither
   * approved nor rejected — a plain, passive shelf with no reminders or
   * resurfacing (non-negotiable #12). */
  status: 'pending' | 'approved' | 'rejected' | 'parked';
  suggestedAt: string;
}

export interface MetricFieldSuggestionsResponse {
  suggestions: MetricFieldSuggestion[];
}

/** An enum field's approved values — reuses the same `CategoriesIndex`
 * suggest/approve mechanism as every other open-ended category, addressed
 * through `/metrics/fields/:id/values` rather than the closed `/categories`
 * surface (`apps/api/src/index/categories-index.ts`'s `MetricFieldStructureType`). */
export interface MetricFieldValuesResponse {
  values: string[];
}

/**
 * One extracted review (`plan.md` M8, `requirements.md` §5.2) — "more like
 * a table with various fields" than a temporal metric. Every encounter with
 * the same title is its own record — a rewatch is a second `Review`, never
 * an edit to the first.
 */
export interface Review extends Published {
  id: string;
  entryId: string;
  title: string;
  /** Open-ended in principle; in practice the currently-approved seed set —
   * see `apps/api/src/model/reviews.ts`. */
  medium: string;
  /** 1–5, or `null` if the entry gave no rating — never inferred from tone. */
  rating: number | null;
  /** 0–100, or `null` if the entry gave no sense of how far through the
   * work this encounter was — never inferred from tone. For a
   * single-sitting medium (film, music) the extractor defaults this to 100
   * unless the entry says otherwise; for a multi-session medium (book) it
   * is only ever set when the entry actually implies a fraction. */
  progress: number | null;
  opinion: string;
  /** When the thing was encountered, not when the entry was written
   * (`requirements.md` §6.3). RFC 3339 with a UTC offset. */
  eventTime: string;
  eventTimeExplicit: boolean;
  /** Whether the user has reviewed, corrected, or edited this record
   * (`requirements.md` §2, §6.4, `plan.md` M10). */
  touched: boolean;
}

export interface ReviewsResponse {
  reviews: Review[];
}

/** The editable subset — everything except `id`, `entryId`, `medium` (an
 * approved category, not free content), and `touched` itself (`plan.md`
 * M10). */
export interface UpdateReviewRequest {
  title?: string;
  rating?: number | null;
  progress?: number | null;
  opinion?: string;
  eventTime?: string;
  eventTimeExplicit?: boolean;
}

export interface ReviewUpdateSuggestion {
  id: string;
  recordId: string;
  entryId: string;
  title: string;
  rating: number | null;
  progress: number | null;
  opinion: string;
  eventTime: string;
  eventTimeExplicit: boolean;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  suggestedAt: string;
}

export interface ReviewUpdateSuggestionsResponse {
  suggestions: ReviewUpdateSuggestion[];
}

/**
 * One extracted atomic list item (`plan.md` M8, `requirements.md` §5.2) —
 * for example a quote. `text` is the item itself, verbatim, not a summary.
 */
export interface ListItem extends Published {
  id: string;
  entryId: string;
  /** Open-ended in principle; in practice the currently-approved seed set —
   * see `apps/api/src/model/lists.ts`. */
  listType: string;
  text: string;
  context: string;
  /** 1–5, or `null` if nothing in the entry signalled particular
   * significance — never inferred from topic alone. No decay is stored
   * against this value; any age-based ranking is computed fresh at read
   * time from `importance` and `eventTime`, never written back. */
  importance: number | null;
  eventTime: string;
  eventTimeExplicit: boolean;
  /** Whether the user has reviewed, corrected, or edited this record
   * (`requirements.md` §2, §6.4, `plan.md` M10). */
  touched: boolean;
}

export interface ListItemsResponse {
  items: ListItem[];
}

/** The editable subset — everything except `id`, `entryId`, `listType` (an
 * approved category, not free content), and `touched` itself (`plan.md`
 * M10). */
export interface UpdateListItemRequest {
  text?: string;
  context?: string;
  importance?: number | null;
  eventTime?: string;
  eventTimeExplicit?: boolean;
}

export interface ListItemUpdateSuggestion {
  id: string;
  recordId: string;
  entryId: string;
  text: string;
  context: string;
  importance: number | null;
  eventTime: string;
  eventTimeExplicit: boolean;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  suggestedAt: string;
}

export interface ListItemUpdateSuggestionsResponse {
  suggestions: ListItemUpdateSuggestion[];
}

/**
 * The concept model (`plan.md` M8, `requirements.md` §5.2) — two layers.
 *
 * **Layer 1 — a statement.** One entry's contribution to a subject —
 * exactly like the other structures: extracted per entry, linked to it,
 * corrected by discarding. `statement` is a faithful record of what *this
 * entry* said, never extended beyond it.
 *
 * **The per-person conversation-topics idea, folded in rather than built
 * separately** (raised in `requirements.md` §11, resolved 2026-08-30):
 * `kind` distinguishes a plain note or fact (`'note'`) from something to
 * raise with the subject later (`'question'`) — the latter carries the
 * exact same open/resolved lifecycle `OpenQuestion` already has, just
 * scoped to a concept subject instead of existing as its own flat list.
 * `status`/`resolvedEntryId`/`resolution` are `null` for a `'note'` — they
 * exist at all only for `'question'` statements.
 */
export interface OpinionStatement extends Published {
  id: string;
  entryId: string;
  /** Open-ended in principle; in practice the currently-approved seed set —
   * see `apps/api/src/model/opinions.ts`. */
  subject: string;
  statement: string;
  eventTime: string;
  eventTimeExplicit: boolean;
  /** Decided once at extraction time, immutable afterward — the same
   * "an approved category, not free content" treatment `subject` itself
   * gets, not something a later re-extraction reclassifies. */
  kind: 'note' | 'question';
  /** `null` for `kind: 'note'`. For `kind: 'question'`, whether it's still
   * open or a later entry has answered it — resolved automatically by the
   * same extraction pipeline `OpenQuestion` uses, never inferred beyond
   * what that later entry actually said. */
  status: 'open' | 'resolved' | null;
  /** The entry that resolved this question, or `null` while open or for a
   * `'note'`. */
  resolvedEntryId: string | null;
  /** A faithful quote or summary of what the resolving entry actually
   * said — never an answer inferred beyond that. `null` while open or for
   * a `'note'`. */
  resolution: string | null;
  /** Whether the user has reviewed, corrected, or edited this record
   * (`requirements.md` §2, §6.4, `plan.md` M10). Reopening a resolved
   * question counts as a touch, the same as `OpenQuestion`. */
  touched: boolean;
}

export interface OpinionStatementsResponse {
  statements: OpinionStatement[];
}

/** The editable subset — everything except `id`, `entryId`, `subject` (an
 * approved category, not free content), and `touched` itself (`plan.md`
 * M10). */
export interface UpdateOpinionStatementRequest {
  statement?: string;
  eventTime?: string;
  eventTimeExplicit?: boolean;
}

export interface OpinionStatementUpdateSuggestion {
  id: string;
  recordId: string;
  entryId: string;
  statement: string;
  eventTime: string;
  eventTimeExplicit: boolean;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  suggestedAt: string;
}

export interface OpinionStatementUpdateSuggestionsResponse {
  suggestions: OpinionStatementUpdateSuggestion[];
}

/**
 * **Layer 2 — a summary.** Regenerated per subject from every current
 * statement on it (`apps/api/src/model/opinion-summarizer.ts`) — "organised
 * in one location, see how it changes over time" (`requirements.md` §5.2).
 * Never hand-edited (§9); if a part is wrong, the fix is correcting or
 * discarding the statement it cites and reprocessing.
 *
 * Every part names the exact `OpinionStatement` ids it draws from — checked
 * against the real statements before being stored, never trusted blindly —
 * so nothing here can read as a position you never actually stated without
 * a citation attached that a reader can go check.
 */
export interface OpinionSummaryPart {
  text: string;
  sourceStatementIds: string[];
  /** The entries those statements came from — resolved here so the frontend
   * never has to cross-reference a statement id to find out
   * (`requirements.md` §7.1). */
  sourceEntryIds: string[];
}

export interface OpinionSummary {
  subject: string;
  generatedAt: string;
  parts: OpinionSummaryPart[];
}

export interface OpinionSummariesResponse {
  summaries: OpinionSummary[];
}

/**
 * Open questions — something the writer posed as genuinely undecided, that
 * a later entry may go on to answer. Unlike every structure above, a single
 * record's life can span two entries: `entryId` is always the entry that
 * *raised* it; `resolvedEntryId` is whichever later entry the extractor
 * matched it to, or `null` while still open. No category enum — unlike
 * metrics, reviews, lists, and opinions, there is no approved-name set to
 * extract against here, since a question's content is the whole of it.
 */
export interface OpenQuestion extends Published {
  id: string;
  entryId: string;
  question: string;
  eventTime: string;
  eventTimeExplicit: boolean;
  status: 'open' | 'resolved';
  resolvedEntryId: string | null;
  /** A faithful quote or summary of what the resolving entry actually said —
   * never an answer inferred beyond that. `null` while still open. */
  resolution: string | null;
  /** Whether the user has reviewed, corrected, or edited this record
   * (`requirements.md` §2, §6.4, `plan.md` M10). Reopening counts as a
   * touch — it is a correction. */
  touched: boolean;
}

export interface QuestionsResponse {
  questions: OpenQuestion[];
}

/** The editable subset of what an entry *raised* — never the resolution,
 * which has its own dedicated `reopen`/`resolve` machinery (`plan.md` M10). */
export interface UpdateQuestionRequest {
  question?: string;
  eventTime?: string;
  eventTimeExplicit?: boolean;
}

export interface QuestionUpdateSuggestion {
  id: string;
  recordId: string;
  entryId: string;
  question: string;
  eventTime: string;
  eventTimeExplicit: boolean;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  suggestedAt: string;
}

export interface QuestionUpdateSuggestionsResponse {
  suggestions: QuestionUpdateSuggestion[];
}

export interface QuestionsSummaryResponse {
  openCount: number;
  resolvedCount: number;
}

/**
 * "Public by default" visibility, one setting per category
 * (`requirements.md` §11, `plan.md` M16) — reuses exactly the four core
 * category types `ApproveCategoryRequest` already validates against.
 * Questions have no category and so never appear here — a question is only
 * ever published one at a time, directly (`POST /questions/:id/publish`).
 */
export type VisibilityStructureType = 'metric' | 'review_medium' | 'list_type' | 'opinion_subject';

export interface VisibilityDefault {
  structureType: VisibilityStructureType;
  category: string;
  defaultPublic: boolean;
}

export interface VisibilityDefaultsResponse {
  defaults: VisibilityDefault[];
}

/** Setting never publishes anything by itself — it only changes what
 * `GET /publish-queue` surfaces for confirmation. */
export interface SetVisibilityDefaultRequest {
  structureType: VisibilityStructureType;
  category: string;
  defaultPublic: boolean;
}

/** One record sitting in a "public by default" category that has not yet
 * actually been published — offered for one-click confirmation, never
 * auto-published (`requirements.md` §11, `plan.md` M16). `preview` is a
 * short, type-appropriate excerpt (a metric's `detail`, a review's `title`,
 * a list item's `text`, an opinion statement's `statement`) so the
 * confirmation UI has something to show without a second round trip. */
export interface PublishQueueItem {
  structureType: VisibilityStructureType;
  category: string;
  id: string;
  preview: string;
  eventTime: string;
}

export interface PublishQueueResponse {
  items: PublishQueueItem[];
}

/**
 * To-dos (`plan.md` M15, `requirements.md` §11) — an outstanding task,
 * errand, or commitment, closest in shape to `OpenQuestion` above: `entryId`
 * is whichever entry *raised* it, `doneEntryId` is whichever later entry
 * reported it done, or `null` while still open. Two departures from every
 * structure above, both deliberate: `entryId` may be `null` — a to-do
 * created directly in the UI has no source entry at all — and `origin`
 * records whether an AI-generated version of this record exists to revert
 * to, distinct from `touched` (see `apps/api/src/index/todos-index.ts` for
 * why they're separate).
 */
export interface Todo {
  id: string;
  entryId: string | null;
  text: string;
  eventTime: string;
  eventTimeExplicit: boolean;
  status: 'open' | 'done';
  doneEntryId: string | null;
  /** A faithful quote or summary of what the completing entry actually
   * said — never inferred beyond that. `null` while open or when completed
   * by a direct UI toggle rather than an entry. */
  resolution: string | null;
  origin: 'extracted' | 'user';
  touched: boolean;
}

export interface TodosResponse {
  todos: Todo[];
}

/** The user creating a to-do directly, with no source entry
 * (`requirements.md` §11) — the deliberate exception to every structure
 * above, which only ever originates from an entry. */
export interface CreateTodoRequest {
  text: string;
}

/** The editable subset of what was raised — never the completion, which has
 * its own dedicated `complete`/`reopen` machinery. */
export interface UpdateTodoRequest {
  text?: string;
  eventTime?: string;
  eventTimeExplicit?: boolean;
}

export interface TodoUpdateSuggestion {
  id: string;
  recordId: string;
  entryId: string;
  text: string;
  eventTime: string;
  eventTimeExplicit: boolean;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  suggestedAt: string;
}

export interface TodoUpdateSuggestionsResponse {
  suggestions: TodoUpdateSuggestion[];
}

/** A later entry reporting a *touched* to-do done — never applied silently
 * (`requirements.md` §11), unlike the untouched path, which the `complete`
 * route below covers directly. */
export interface TodoCompletionSuggestion {
  id: string;
  recordId: string;
  entryId: string;
  resolution: string;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  suggestedAt: string;
}

export interface TodoCompletionSuggestionsResponse {
  suggestions: TodoCompletionSuggestion[];
}

export interface TodosSummaryResponse {
  openCount: number;
  doneCount: number;
}

/**
 * The open-ended category field every structure type above has (`metric`,
 * `medium`, `listType`, `subject`) — kept to an approved set the AI may
 * extract against, grown only by approval (`plan.md` M8, `requirements.md`
 * §5.3: "the AI does not autonomously create new metrics").
 */
export type CoreStructureType = 'metric' | 'review_medium' | 'list_type' | 'opinion_subject';
/** One per user-defined metric field of type `enum` — its approved values
 * reuse the exact same suggest/approve mechanism as every core structure
 * type. Mirrors `apps/api/src/index/categories-index.ts`'s own widening. */
export type MetricFieldStructureType = `metric_field:${string}:${string}`;
export type StructureType = CoreStructureType | MetricFieldStructureType;

/** The names currently approved for each structure type. */
export interface CategoriesResponse {
  metric: string[];
  review_medium: string[];
  list_type: string[];
  opinion_subject: string[];
}

/**
 * A category the AI proposed but a human has not yet decided on
 * (`requirements.md` §5.3's first route: "the AI suggests a new metric, and
 * the user approves it"). `entryId` is the entry that prompted it, so the
 * reasoning can be checked against the actual prose.
 */
export interface CategorySuggestion {
  id: string;
  structureType: StructureType;
  name: string;
  reason: string;
  entryId: string;
  /** `'parked'` (`plan.md` M18) — see `MetricFieldSuggestion.status`. */
  status: 'pending' | 'approved' | 'rejected' | 'parked';
  suggestedAt: string;
}

export interface SuggestionsResponse {
  suggestions: CategorySuggestion[];
}

/** The user requesting a category directly (`requirements.md` §5.3's second
 * route) — approved immediately, no suggestion or review step. */
export interface ApproveCategoryRequest {
  structureType: StructureType;
  name: string;
}

/**
 * Aggregated data for the analysis surfaces (`plan.md` M8, `design.md`
 * §5.3) — computed behind the API, never in the frontend
 * (`requirements.md` §7.1). A small multiple's raw material: one
 * `MetricSummary` per approved metric, zero-filled so a metric with no
 * occurrences still has its own tile rather than silently vanishing.
 */
export interface DayCount {
  /** `YYYY-MM-DD`, UTC. */
  date: string;
  count: number;
}

export interface MetricSummary {
  metric: string;
  /** Every occurrence ever recorded, not only within the window. */
  totalCount: number;
  /** Oldest first, one entry per day in the window. */
  days: DayCount[];
}

export interface MetricsSummaryResponse {
  summaries: MetricSummary[];
  windowDays: number;
}

/** One calendar day (UTC) within a field's summary window, and the sum of
 * that field's numeric values recorded on it — the raw material for a
 * magnitude-aware small multiple, computed here rather than in the frontend
 * (`requirements.md` §7.1). */
export interface DayValue {
  /** `YYYY-MM-DD`, UTC. */
  date: string;
  value: number;
}

/**
 * Aggregated numeric data for one metric field (`plan.md` M9 — structured
 * metric fields), e.g. "how much rowing have I done": total/average/count
 * across the window, optionally filtered to records where another field
 * equals a given value.
 */
export interface MetricFieldSummaryResponse {
  metric: string;
  fieldKey: string;
  unit: string | null;
  filter: { field: string; value: string } | null;
  total: number;
  average: number;
  /** Records contributing a non-null value — the denominator `average` used. */
  count: number;
  windowDays: number;
  days: DayValue[];
}

/** `averageRating` is `null` when nothing in the medium has a rating — never
 * coerced to 0, which would read as "rated zero" rather than "no ratings
 * given." */
export interface ReviewMediumSummary {
  medium: string;
  count: number;
  averageRating: number | null;
}

export interface ReviewsSummaryResponse {
  summaries: ReviewMediumSummary[];
}

/** One half-point rating value (1, 1.5, 2, ... 5) and how many reviews
 * landed there. Every bucket is always present, zero-filled — the same
 * "no silent gaps" convention `ReviewMediumSummary` already gives a medium
 * with zero reviews (`design.md` §5.3's small-multiples idiom: "am I a
 * generous rater, do I rate books harder than films" is a shape question,
 * not a mean). */
export interface ReviewRatingBucket {
  rating: number;
  count: number;
}

export interface ReviewMediumHistogram {
  medium: string;
  buckets: ReviewRatingBucket[];
}

export interface ReviewsHistogramResponse {
  overall: ReviewRatingBucket[];
  byMedium: ReviewMediumHistogram[];
}

export interface ListTypeSummary {
  listType: string;
  count: number;
}

export interface ListsSummaryResponse {
  summaries: ListTypeSummary[];
}

/** One approved concept subject and how many statements it's gathered —
 * the analysis page's equivalent of `ListTypeSummary`, so a subject with
 * zero statements yet still gets its own row rather than silently missing
 * (`requirements.md` §5.2, reframed 2026-08-30: grouping by subject is the
 * point of this structure, and the analysis surface should say so too). */
export interface OpinionSubjectSummary {
  subject: string;
  count: number;
}

export interface OpinionSubjectSummariesResponse {
  summaries: OpinionSubjectSummary[];
}

/**
 * A conversational turn in the chat feature ("further features",
 * `requirements.md` §8). No persistence in v1 — the client holds the whole
 * conversation, the server holds none of it between requests, so a
 * `ChatRequest` always carries the entire history so far.
 */
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  /** Oldest first, ending in the new user message. */
  messages: ChatMessage[];
}

/** One point in a day-bucketed series, normalised for the sparkline
 * renderer regardless of whether it was sourced from a `DayCount` (keyed
 * `count`) or a `DayValue` (keyed `value`) on the backend — the frontend
 * has exactly one shape to draw. */
export interface SparklinePoint {
  /** `YYYY-MM-DD`, UTC. */
  date: string;
  value: number;
}

export interface SparklineChartSpec {
  type: 'sparkline';
  title: string;
  unit: string | null;
  totalLabel: string | null;
  points: SparklinePoint[];
}

export interface BarComparisonBar {
  label: string;
  value: number;
}

export interface BarComparisonChartSpec {
  type: 'bar_comparison';
  title: string;
  unit: string | null;
  bars: BarComparisonBar[];
}

export interface StatTileChartSpec {
  type: 'stat_tile';
  label: string;
  value: number | string;
  unit: string | null;
}

export interface TableColumn {
  key: string;
  label: string;
}

export interface TableRow {
  values: Record<string, string | number | null>;
  /** The record this row came from, when it has one — never rendered as its
   * own column, only as a citation link back to the source entry
   * (`requirements.md` §3). */
  entryId: string | null;
}

export interface TableChartSpec {
  type: 'table';
  title: string;
  columns: TableColumn[];
  rows: TableRow[];
}

/**
 * The fixed vocabulary the chat model may choose from — never model-
 * generated code or layout, only a pick from this union filled with real
 * data the backend already computed. Matched by a single `switch` on the
 * frontend (`apps/web/components/chat/chart-spec.tsx`).
 */
export type ChartSpec = SparklineChartSpec | BarComparisonChartSpec | StatTileChartSpec | TableChartSpec;

/**
 * The result of one chat turn. `citedEntryIds` is coarse, per-turn
 * traceability — every entry behind whatever data was looked up this turn,
 * deduplicated, not per-sentence citation (`requirements.md` §3); finer-
 * grained citation would want persisted turns to attach it to, which v1
 * deliberately does not have.
 */
export interface ChatResponse {
  answer: string;
  charts: ChartSpec[];
  citedEntryIds: string[];
}

/**
 * Stable, machine-readable failure codes.
 *
 * Codes rather than bare HTTP statuses, because a future remote frontend will
 * need to distinguish these without parsing prose. Add to this union; do not
 * repurpose an existing member.
 */
export type ApiErrorCode =
  /** The request body or query string did not validate. */
  | 'invalid_request'
  /** No entry with that id. */
  | 'entry_not_found'
  /** The cursor was not one we issued. */
  | 'invalid_cursor'
  /**
   * The request came from, or was addressed to, a host this server does not
   * serve. The allowlist is explicit and there is no wildcard.
   */
  | 'forbidden_origin'
  /** A file exists but could not be read as an entry. See `format.md` §3. */
  | 'malformed_entry'
  /**
   * `contentHash` on a `PUT` no longer matches what is on disk — the entry
   * changed since the caller last read it, most likely by hand in a text
   * editor. The write did not happen (`plan.md` M2).
   */
  | 'edit_conflict'
  /**
   * A `PUT` named a derived record (metric, review, list item, opinion
   * statement, or question) that does not exist. Unlike the tolerant no-op
   * `DELETE` and state-transition routes use, an edit that lands nowhere is
   * worth telling the caller about (`plan.md` M10).
   */
  | 'record_not_found'
  /** The journal directory could not be read or written. */
  | 'journal_unavailable'
  /**
   * An attachment with that filename already exists on this entry.
   * Attachments are written once and never overwritten (`requirements.md`
   * §7.4) — pick a different name and try again.
   */
  | 'attachment_conflict'
  /**
   * The local speech-to-text model could not produce a transcript — it may
   * still be downloading, or the recording may be unusable. Never a reason to
   * lose the audio; nothing about the recording itself is discarded when this
   * happens (`requirements.md` §4.7).
   */
  | 'transcription_failed'
  /**
   * The search index could not answer — most likely the local embedding
   * model is still downloading on first use. Never a reason to lose
   * anything; search reads the index, it never writes an entry
   * (`requirements.md` §6.1).
   */
  | 'search_unavailable'
  /**
   * The AI Gateway is not configured, unreachable, or returned something
   * that could not be validated against the extraction schema after retry.
   * Never a reason to lose or block writing an entry — extraction only ever
   * reads entries (`requirements.md` §6.1, §7.6).
   */
  | 'extraction_failed'
  /**
   * The AI Gateway is not configured, unreachable, or a chat turn could not
   * be completed. Never a reason to lose anything — chat only ever reads
   * (`requirements.md` §7.6).
   */
  | 'chat_failed'
  /**
   * The request carried no valid session cookie or bearer token
   * (`plan.md` M11). Sign in via `POST /auth/google/start` or
   * `POST /auth/login`.
   */
  | 'unauthorized'
  /** Anything unanticipated. */
  | 'internal';

export interface ApiError {
  error: {
    code: ApiErrorCode;
    message: string;
  };
}

/** Liveness, and enough detail to tell which journal is being served. */
export interface HealthResponse {
  status: 'ok';
  journalDir: string;
  entryCount: number;

  /**
   * Files under the journal directory that look like entries but could not be
   * read as one — missing `id`, unparseable `created`, broken frontmatter.
   *
   * Such a file is skipped rather than allowed to fail the whole listing: one
   * damaged file must never make the rest of the journal unreachable. Skipping
   * silently would hide real damage, so the count is surfaced here.
   *
   * This is a count of *unreadable files*, not of writing. It says nothing
   * about how much or how often the user writes and is not an engagement
   * metric (`design.md` §4).
   */
  unreadableCount: number;
}
