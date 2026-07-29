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

/** An entry in full. The body is exactly the bytes on disk, minus frontmatter. */
export interface Entry extends EntryMetadata {
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
 * One matching passage from a search (`plan.md` M6, `requirements.md` §8).
 *
 * A hit is a paragraph, not an entry — "search by meaning" means finding the
 * part of an entry that answers the query, so `passage` is what matched, and
 * `entryId`/`created` are enough to link back to the entry it came from
 * without a second round trip for the common case of showing a result list.
 */
export interface SearchHit {
  entryId: string;
  created: string;
  location?: Coordinates;
  /** The paragraph that matched, exactly as written. */
  passage: string;
}

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
export interface TemporalMetric {
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
}

export interface MetricsResponse {
  metrics: TemporalMetric[];
}

/**
 * One extracted review (`plan.md` M8, `requirements.md` §5.2) — "more like
 * a table with various fields" than a temporal metric. Every encounter with
 * the same title is its own record — a rewatch is a second `Review`, never
 * an edit to the first.
 */
export interface Review {
  id: string;
  entryId: string;
  title: string;
  /** Open-ended in principle; in practice the currently-approved seed set —
   * see `apps/api/src/model/reviews.ts`. */
  medium: string;
  /** 1–5, or `null` if the entry gave no rating — never inferred from tone. */
  rating: number | null;
  opinion: string;
  /** When the thing was encountered, not when the entry was written
   * (`requirements.md` §6.3). RFC 3339 with a UTC offset. */
  eventTime: string;
  eventTimeExplicit: boolean;
}

export interface ReviewsResponse {
  reviews: Review[];
}

/**
 * One extracted atomic list item (`plan.md` M8, `requirements.md` §5.2) —
 * for example a quote. `text` is the item itself, verbatim, not a summary.
 */
export interface ListItem {
  id: string;
  entryId: string;
  /** Open-ended in principle; in practice the currently-approved seed set —
   * see `apps/api/src/model/lists.ts`. */
  listType: string;
  text: string;
  context: string;
  eventTime: string;
  eventTimeExplicit: boolean;
}

export interface ListItemsResponse {
  items: ListItem[];
}

/**
 * A model of opinions (`plan.md` M8, `requirements.md` §5.2) — two layers.
 *
 * **Layer 1 — a statement.** One entry's expression of a view on a subject,
 * exactly like the other structures: extracted per entry, linked to it,
 * corrected by discarding. `statement` is a faithful summary of what *this
 * entry* said, never extended beyond it.
 */
export interface OpinionStatement {
  id: string;
  entryId: string;
  /** Open-ended in principle; in practice the currently-approved seed set —
   * see `apps/api/src/model/opinions.ts`. */
  subject: string;
  statement: string;
  eventTime: string;
  eventTimeExplicit: boolean;
}

export interface OpinionStatementsResponse {
  statements: OpinionStatement[];
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
 * The open-ended category field every structure type above has (`metric`,
 * `medium`, `listType`, `subject`) — kept to an approved set the AI may
 * extract against, grown only by approval (`plan.md` M8, `requirements.md`
 * §5.3: "the AI does not autonomously create new metrics").
 */
export type StructureType = 'metric' | 'review_medium' | 'list_type' | 'opinion_subject';

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
  status: 'pending' | 'approved' | 'rejected';
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

export interface ListTypeSummary {
  listType: string;
  count: number;
}

export interface ListsSummaryResponse {
  summaries: ListTypeSummary[];
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
