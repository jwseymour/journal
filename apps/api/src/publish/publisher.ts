import type { PublishableSourceType, PublishedIndex } from '../index/published-index.js';
import type { ListItemsReader } from '../index/lists-index.js';
import type { MetricsReader } from '../index/metrics-index.js';
import type { OpinionStatementsReader } from '../index/opinion-statements-index.js';
import type { PublicSearchIndex, PublicSearchSourceType } from '../index/public-search-index.js';
import type { QuestionsReader } from '../index/questions-index.js';
import type { ReviewsReader } from '../index/reviews-index.js';
import { excerpt } from '../record/excerpt.js';
import { contentHash } from '../record/hash.js';
import { nowTimestamp } from '../record/time.js';
import { chunkParagraphs } from '../search/chunk.js';
import type { DocumentStore } from '../store/document-store.js';
import type { EntryStore } from '../store/entry-store.js';

/**
 * The seam every publish/unpublish/resync action goes through
 * (`requirements.md` §9.3, §11, `plan.md` M15) — the one file that knows a
 * `public/` mirror exists at all, the same "one file for this concern"
 * shape `ModelClient`/`Transcriber` already use (`plan.md` standing rule 8).
 *
 * Publishing never edits the source. It renders a privacy-safe snapshot —
 * plain JSON, not markdown, since presentation is the public surface's own
 * concern (`requirements.md` §10) — and copies it into `public/`, tracked
 * by `PublishedIndex`. The canonical entry or document never carries a
 * visibility field: for an entry that would violate §4.3's "nothing else"
 * outright, and keeping documents on the same mechanism means there is
 * exactly one way anything ever becomes public, not two.
 *
 * Every method here is a tolerant no-op on a source that does not exist or
 * is not published — the same posture `validate`/`untouch` already take
 * (`plan.md` M10): publishing is an action route, not an edit, so there is
 * nothing to 404 about.
 */

export interface EntryPublicSnapshot {
  id: string;
  created: string;
  body: string;
  excerpt: string;
}

export interface DocumentPublicSnapshot {
  id: string;
  title: string;
  created: string;
  updated: string;
  body: string;
  excerpt: string;
}

/**
 * The five derived-structure snapshots (`plan.md` M16) deliberately carry
 * only the record's own semantic content — never `entryId`, never
 * `touched`/`extractedAt` provenance — since the entry it came from is not
 * itself public and there is no reason a public reader needs to know which
 * private entry a public review or metric was drawn from.
 */
export interface MetricPublicSnapshot {
  id: string;
  metric: string;
  eventTime: string;
  detail: string;
  fields: Record<string, string | number | null>;
}

export interface ReviewPublicSnapshot {
  id: string;
  title: string;
  medium: string;
  rating: number | null;
  progress: number | null;
  opinion: string;
  eventTime: string;
}

export interface ListItemPublicSnapshot {
  id: string;
  listType: string;
  text: string;
  context: string;
  importance: number | null;
  eventTime: string;
}

export interface OpinionStatementPublicSnapshot {
  id: string;
  subject: string;
  statement: string;
  eventTime: string;
}

/** Omits `resolvedEntryId` — the resolving entry's own linkage is provenance,
 * not content — but keeps `resolution` itself: publishing a resolved
 * question is meant to show the answer, not just the open question. */
export interface QuestionPublicSnapshot {
  id: string;
  question: string;
  eventTime: string;
  status: 'open' | 'resolved';
  resolution: string | null;
}

export type PublicSnapshot =
  | EntryPublicSnapshot
  | DocumentPublicSnapshot
  | MetricPublicSnapshot
  | ReviewPublicSnapshot
  | ListItemPublicSnapshot
  | OpinionStatementPublicSnapshot
  | QuestionPublicSnapshot;

/** Where a published snapshot lives, relative to the storage root/bucket. */
export function publicMirrorKey(sourceType: PublishableSourceType, sourceId: string): string {
  return `public/${sourceType}s/${sourceId}.json`;
}

/**
 * Where a published entry's own attachment, once mirrored, lives relative
 * to the storage root/bucket (`plan.md` M19). Deliberately a separate tree
 * from `publicMirrorKey`'s `public/entrys/<id>.json` rather than nested
 * under it, since an attachment is a binary blob a `StorageReader.read()`
 * (text-only, on the public-api side) must never be asked to parse as JSON.
 * `apps/public-api` computes this exact same key by hand to read it back —
 * see that app's own `attachment-key.ts` — so a change here is a change
 * there too.
 */
export function publicAttachmentKey(entryId: string, filename: string): string {
  return `public/entry-attachments/${entryId}/${filename}`;
}

/** The one write surface a publisher needs against the `public/` prefix —
 * deliberately smaller than a full storage interface, since this is the
 * only thing ever written there. `put`/`delete` handle a snapshot's JSON;
 * `putBytes` handles a mirrored attachment's binary (`plan.md` M19) — `delete`
 * itself is already content-agnostic (it just removes whatever is at a key),
 * so there is no `deleteBytes` twin. */
export interface PublicBlobStore {
  put(key: string, json: string): Promise<void>;
  putBytes(key: string, data: Buffer, contentType: string): Promise<void>;
  delete(key: string): Promise<void>;
}

interface RenderedSource {
  snapshot: PublicSnapshot;
  created: string;
  contentHash: string;
}

/** `entry`/`document` are the only two source types with real prose worth
 * chunking for search — the five derived-structure types are short,
 * structured facts, not passages, so they are never indexed here
 * (`plan.md` M17). */
function toPublicSearchSourceType(sourceType: PublishableSourceType): PublicSearchSourceType | null {
  return sourceType === 'entry' || sourceType === 'document' ? sourceType : null;
}

export class Publisher {
  readonly #blobs: PublicBlobStore;
  readonly #index: PublishedIndex;
  readonly #entryStore: EntryStore;
  readonly #documentStore: DocumentStore;
  readonly #metrics: MetricsReader;
  readonly #reviews: ReviewsReader;
  readonly #lists: ListItemsReader;
  readonly #opinionStatements: OpinionStatementsReader;
  readonly #questions: QuestionsReader;
  readonly #publicSearchIndex: PublicSearchIndex;

  constructor(
    blobs: PublicBlobStore,
    index: PublishedIndex,
    entryStore: EntryStore,
    documentStore: DocumentStore,
    metrics: MetricsReader,
    reviews: ReviewsReader,
    lists: ListItemsReader,
    opinionStatements: OpinionStatementsReader,
    questions: QuestionsReader,
    publicSearchIndex: PublicSearchIndex,
  ) {
    this.#blobs = blobs;
    this.#index = index;
    this.#entryStore = entryStore;
    this.#documentStore = documentStore;
    this.#metrics = metrics;
    this.#reviews = reviews;
    this.#lists = lists;
    this.#opinionStatements = opinionStatements;
    this.#questions = questions;
    this.#publicSearchIndex = publicSearchIndex;
  }

  /** Copies a fresh snapshot into `public/` and records it. A no-op if the
   * source no longer exists — there is nothing to publish. */
  async publish(sourceType: PublishableSourceType, sourceId: string): Promise<void> {
    const rendered = await this.#render(sourceType, sourceId);
    if (!rendered) return;

    const key = publicMirrorKey(sourceType, sourceId);
    await this.#blobs.put(key, JSON.stringify(rendered.snapshot));
    this.#index.upsert({
      sourceType,
      sourceId,
      mirrorKey: key,
      sourceCreatedAt: rendered.created,
      publishedAt: nowTimestamp().canonical,
      sourceHashAtPublish: rendered.contentHash,
    });
    this.#reindexForPublicSearch(sourceType, sourceId, rendered.snapshot);
    if (sourceType === 'entry') await this.#syncEntryAttachments(sourceId);
  }

  /** Removes the mirror object and the record of it. A no-op if it was
   * never published. */
  async unpublish(sourceType: PublishableSourceType, sourceId: string): Promise<void> {
    const row = this.#index.get(sourceType, sourceId);
    if (!row) return;
    await this.#blobs.delete(row.mirrorKey);
    this.#index.remove(sourceType, sourceId);
    const searchType = toPublicSearchSourceType(sourceType);
    if (searchType) this.#publicSearchIndex.removeSource(searchType, sourceId);
    if (sourceType === 'entry') await this.#removeEntryAttachments(sourceId);
  }

  /**
   * Called after a successful edit to a source that might be published
   * (`plan.md` M15) — if it is, and its content actually changed since the
   * last publish, the mirror is overwritten in place. A no-op otherwise,
   * including when the source was never published at all. This is what
   * keeps a published entry or document from silently drifting out of sync
   * with what a viewer of the public surface sees.
   */
  async resyncIfPublished(sourceType: PublishableSourceType, sourceId: string): Promise<void> {
    const row = this.#index.get(sourceType, sourceId);
    if (!row) return;

    const rendered = await this.#render(sourceType, sourceId);
    if (!rendered || rendered.contentHash === row.sourceHashAtPublish) return;

    await this.#blobs.put(row.mirrorKey, JSON.stringify(rendered.snapshot));
    this.#index.upsert({
      ...row,
      sourceCreatedAt: rendered.created,
      publishedAt: nowTimestamp().canonical,
      sourceHashAtPublish: rendered.contentHash,
    });
    this.#reindexForPublicSearch(sourceType, sourceId, rendered.snapshot);
    // A body edit is the only way an entry's attachments can change (a new
    // `![](...)` link means a new call to `EntryStore.addAttachment`, which
    // always changes the body too) — so re-syncing here, gated on the same
    // "did the content hash actually move" check just above, catches a
    // newly-attached photo on an already-published entry for free, with no
    // separate trigger of its own.
    if (sourceType === 'entry') await this.#syncEntryAttachments(sourceId);
  }

  /** Copies every attachment currently on this entry into `public/`
   * (`plan.md` M19) — the whole directory, not only whatever the body
   * happens to link to: an attachment belongs to the entry the moment it is
   * written (`format.md` §4), and publishing an entry means publishing what
   * belongs to it, the same as the body itself. Attachments are write-once,
   * so re-copying an already-mirrored one is redundant but harmless — there
   * is no drift to detect here the way `resyncIfPublished` detects it for a
   * body that can change. */
  async #syncEntryAttachments(entryId: string): Promise<void> {
    const attachments = await this.#entryStore.listAttachments(entryId);
    for (const { filename } of attachments) {
      const bytes = await this.#entryStore.getAttachment(entryId, filename);
      if (!bytes) continue; // Vanished between listing and reading — nothing to mirror.
      await this.#blobs.putBytes(publicAttachmentKey(entryId, filename), bytes.data, bytes.contentType);
    }
  }

  /** The `unpublish` twin of `#syncEntryAttachments` — an attachment is
   * never deleted from the private side (`format.md` §4), so the only way
   * its public mirror goes away is unpublishing the entry it belongs to. */
  async #removeEntryAttachments(entryId: string): Promise<void> {
    const attachments = await this.#entryStore.listAttachments(entryId);
    for (const { filename } of attachments) {
      await this.#blobs.delete(publicAttachmentKey(entryId, filename));
    }
  }

  /** Keeps the public search index (`plan.md` M17) in step with every
   * publish/resync — entries and documents only (see
   * `toPublicSearchSourceType`), chunked the same way the private search
   * index chunks a body, by paragraph. */
  #reindexForPublicSearch(sourceType: PublishableSourceType, sourceId: string, snapshot: PublicSnapshot): void {
    const searchType = toPublicSearchSourceType(sourceType);
    if (!searchType) return;
    const body = (snapshot as EntryPublicSnapshot | DocumentPublicSnapshot).body;
    const paragraphs = chunkParagraphs(body);
    if (paragraphs.length === 0) {
      this.#publicSearchIndex.removeSource(searchType, sourceId);
      return;
    }
    this.#publicSearchIndex.replaceSource(searchType, sourceId, paragraphs);
  }

  isPublished(sourceType: PublishableSourceType, sourceId: string): boolean {
    return this.#index.isPublished(sourceType, sourceId);
  }

  /** Every currently published id of one type — what `/publish-queue`
   * (`plan.md` M16) checks a category's records against, so a record that
   * is already public is never offered again. */
  publishedIds(sourceType: PublishableSourceType): Set<string> {
    return new Set(this.#index.listByType(sourceType).map((row) => row.sourceId));
  }

  async #render(sourceType: PublishableSourceType, sourceId: string): Promise<RenderedSource | null> {
    if (sourceType === 'entry') {
      const entry = await this.#entryStore.get(sourceId);
      if (!entry) return null;
      // Deliberately excludes `location` — an entry's coordinates are
      // never a public-facing fact, full stop, not a checkbox someone
      // could get wrong (`requirements.md` §4.3, §9.3, §11).
      const snapshot: EntryPublicSnapshot = {
        id: entry.id,
        created: entry.created,
        body: entry.body,
        excerpt: excerpt(entry.body),
      };
      return { snapshot, created: entry.created, contentHash: entry.contentHash };
    }

    if (sourceType === 'document') {
      const document = await this.#documentStore.get(sourceId);
      if (!document) return null;
      const snapshot: DocumentPublicSnapshot = {
        id: document.id,
        title: document.title,
        created: document.created,
        updated: document.updated,
        body: document.body,
        excerpt: excerpt(document.body),
      };
      return { snapshot, created: document.created, contentHash: document.contentHash };
    }

    // The five derived-structure types (`plan.md` M16) have no stored
    // `contentHash` of their own — unlike an entry or document, a record
    // here is never a file on disk — so `resyncIfPublished` compares a hash
    // computed fresh over the rendered snapshot's own JSON instead. That is
    // exactly as sound a drift detector: the snapshot IS the published
    // artefact, so a hash of it changing is precisely "the mirror is now
    // wrong."
    if (sourceType === 'metric') {
      const record = this.#metrics.getById(sourceId);
      if (!record) return null;
      const snapshot: MetricPublicSnapshot = {
        id: record.id,
        metric: record.metric,
        eventTime: record.eventTime,
        detail: record.detail,
        fields: record.fields,
      };
      return { snapshot, created: record.eventTime, contentHash: contentHash(JSON.stringify(snapshot)) };
    }

    if (sourceType === 'review') {
      const record = this.#reviews.getById(sourceId);
      if (!record) return null;
      const snapshot: ReviewPublicSnapshot = {
        id: record.id,
        title: record.title,
        medium: record.medium,
        rating: record.rating,
        progress: record.progress,
        opinion: record.opinion,
        eventTime: record.eventTime,
      };
      return { snapshot, created: record.eventTime, contentHash: contentHash(JSON.stringify(snapshot)) };
    }

    if (sourceType === 'list_item') {
      const record = this.#lists.getById(sourceId);
      if (!record) return null;
      const snapshot: ListItemPublicSnapshot = {
        id: record.id,
        listType: record.listType,
        text: record.text,
        context: record.context,
        importance: record.importance,
        eventTime: record.eventTime,
      };
      return { snapshot, created: record.eventTime, contentHash: contentHash(JSON.stringify(snapshot)) };
    }

    if (sourceType === 'opinion_statement') {
      const record = this.#opinionStatements.getById(sourceId);
      if (!record) return null;
      const snapshot: OpinionStatementPublicSnapshot = {
        id: record.id,
        subject: record.subject,
        statement: record.statement,
        eventTime: record.eventTime,
      };
      return { snapshot, created: record.eventTime, contentHash: contentHash(JSON.stringify(snapshot)) };
    }

    const record = this.#questions.getById(sourceId);
    if (!record) return null;
    const snapshot: QuestionPublicSnapshot = {
      id: record.id,
      question: record.question,
      eventTime: record.eventTime,
      status: record.status,
      resolution: record.resolution,
    };
    return { snapshot, created: record.eventTime, contentHash: contentHash(JSON.stringify(snapshot)) };
  }
}
