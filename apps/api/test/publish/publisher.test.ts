import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DocumentsIndex } from '../../src/index/documents-index.js';
import { ListsIndex } from '../../src/index/lists-index.js';
import { MetricsIndex } from '../../src/index/metrics-index.js';
import { OpinionStatementsIndex } from '../../src/index/opinion-statements-index.js';
import { PublicSearchIndex } from '../../src/index/public-search-index.js';
import { PublishedIndex } from '../../src/index/published-index.js';
import { QuestionsIndex } from '../../src/index/questions-index.js';
import { ReviewsIndex } from '../../src/index/reviews-index.js';
import { SqliteIndex } from '../../src/index/sqlite-index.js';
import { Publisher, publicAttachmentKey, publicMirrorKey, type PublicBlobStore } from '../../src/publish/publisher.js';
import { nowTimestamp } from '../../src/record/time.js';
import { FsDocumentStore } from '../../src/store/fs-document-store.js';
import { FsEntryStore } from '../../src/store/fs-entry-store.js';

/**
 * `Publisher` against real `Fs*Store`s (so a real `contentHash`/body round
 * trips through it) but a fake, in-memory `PublicBlobStore` — the same
 * "fake the seam this unit doesn't own" approach `document-store-contract
 * .test.ts` takes with its fake S3 client, just simpler here since there is
 * only one method pair to fake.
 */
class FakeBlobStore implements PublicBlobStore {
  files = new Map<string, string>();
  bytes = new Map<string, { data: Buffer; contentType: string }>();
  putCalls = 0;

  async put(key: string, json: string): Promise<void> {
    this.putCalls += 1;
    this.files.set(key, json);
  }

  async putBytes(key: string, data: Buffer, contentType: string): Promise<void> {
    this.bytes.set(key, { data, contentType });
  }

  async delete(key: string): Promise<void> {
    this.files.delete(key);
    this.bytes.delete(key);
  }
}

let root: string;
let entryIndex: SqliteIndex;
let documentsIndex: DocumentsIndex;
let publishedIndex: PublishedIndex;
let entryStore: FsEntryStore;
let documentStore: FsDocumentStore;
let metricsIndex: MetricsIndex;
let reviewsIndex: ReviewsIndex;
let listsIndex: ListsIndex;
let opinionStatementsIndex: OpinionStatementsIndex;
let questionsIndex: QuestionsIndex;
let publicSearchIndex: PublicSearchIndex;
let blobs: FakeBlobStore;
let publisher: Publisher;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'journal-publisher-'));
  entryIndex = new SqliteIndex(':memory:');
  documentsIndex = new DocumentsIndex(':memory:');
  publishedIndex = new PublishedIndex(':memory:');
  entryStore = new FsEntryStore(root, entryIndex);
  documentStore = new FsDocumentStore(root, documentsIndex);
  metricsIndex = new MetricsIndex(':memory:');
  reviewsIndex = new ReviewsIndex(':memory:');
  listsIndex = new ListsIndex(':memory:');
  opinionStatementsIndex = new OpinionStatementsIndex(':memory:');
  questionsIndex = new QuestionsIndex(':memory:');
  publicSearchIndex = new PublicSearchIndex(':memory:');
  blobs = new FakeBlobStore();
  publisher = new Publisher(
    blobs,
    publishedIndex,
    entryStore,
    documentStore,
    metricsIndex,
    reviewsIndex,
    listsIndex,
    opinionStatementsIndex,
    questionsIndex,
    publicSearchIndex,
  );
});

afterEach(async () => {
  entryIndex.close();
  documentsIndex.close();
  publishedIndex.close();
  metricsIndex.close();
  reviewsIndex.close();
  listsIndex.close();
  opinionStatementsIndex.close();
  questionsIndex.close();
  publicSearchIndex.close();
  await rm(root, { recursive: true, force: true });
});

describe('publishing an entry', () => {
  it('copies a snapshot with id, created and body — never location', async () => {
    const entry = await entryStore.create({ body: 'What I did today.', location: { lat: 51.5, lon: -0.1 } });

    await publisher.publish('entry', entry.id);

    const key = publicMirrorKey('entry', entry.id);
    const snapshot = JSON.parse(blobs.files.get(key)!) as Record<string, unknown>;
    expect(snapshot).toEqual({
      id: entry.id,
      created: entry.created,
      body: entry.body,
      excerpt: expect.any(String),
    });
    expect(snapshot).not.toHaveProperty('location');
    expect(publisher.isPublished('entry', entry.id)).toBe(true);
  });

  it('is a tolerant no-op for an entry that does not exist', async () => {
    await expect(publisher.publish('entry', '01ARZ3NDEKTSV4RRFFQ69G5FAV')).resolves.toBeUndefined();
    expect(blobs.files.size).toBe(0);
  });

  it('mirrors every attachment on the entry alongside the snapshot (`plan.md` M19)', async () => {
    const entry = await entryStore.create({ body: 'A photo from today.' });
    await entryStore.addAttachment(entry.id, { filename: 'photo.jpg', data: Buffer.from([0xff, 0xd8]) });
    await entryStore.addAttachment(entry.id, { filename: 'voice.wav', data: Buffer.from('sound') });

    await publisher.publish('entry', entry.id);

    const photo = blobs.bytes.get(publicAttachmentKey(entry.id, 'photo.jpg'));
    expect(photo?.data).toEqual(Buffer.from([0xff, 0xd8]));
    expect(photo?.contentType).toBe('image/jpeg');
    const voice = blobs.bytes.get(publicAttachmentKey(entry.id, 'voice.wav'));
    expect(voice?.data).toEqual(Buffer.from('sound'));
    expect(voice?.contentType).toBe('audio/wav');
  });

  it('mirrors nothing extra for an entry with no attachments', async () => {
    const entry = await entryStore.create({ body: 'Nothing attached.' });
    await publisher.publish('entry', entry.id);
    expect(blobs.bytes.size).toBe(0);
  });
});

describe('publishing a document', () => {
  it('copies a snapshot with id, title, created, updated and body', async () => {
    const document = await documentStore.create({ title: 'A project', body: 'Notes so far.' });

    await publisher.publish('document', document.id);

    const key = publicMirrorKey('document', document.id);
    const snapshot = JSON.parse(blobs.files.get(key)!) as Record<string, unknown>;
    expect(snapshot).toEqual({
      id: document.id,
      title: document.title,
      created: document.created,
      updated: document.updated,
      body: document.body,
      excerpt: expect.any(String),
    });
  });
});

describe('unpublish', () => {
  it('removes the mirror object and the index row', async () => {
    const document = await documentStore.create({ title: 'x', body: 'x' });
    await publisher.publish('document', document.id);

    await publisher.unpublish('document', document.id);

    expect(blobs.files.has(publicMirrorKey('document', document.id))).toBe(false);
    expect(publisher.isPublished('document', document.id)).toBe(false);
  });

  it('is a tolerant no-op for a source never published', async () => {
    await expect(publisher.unpublish('document', '01ARZ3NDEKTSV4RRFFQ69G5FAV')).resolves.toBeUndefined();
  });

  it('removes a published entry\'s mirrored attachments too (`plan.md` M19)', async () => {
    const entry = await entryStore.create({ body: 'A photo from today.' });
    await entryStore.addAttachment(entry.id, { filename: 'photo.jpg', data: Buffer.from('x') });
    await publisher.publish('entry', entry.id);
    expect(blobs.bytes.size).toBe(1);

    await publisher.unpublish('entry', entry.id);

    expect(blobs.bytes.size).toBe(0);
  });
});

describe('publishing a derived-structure record (`plan.md` M16)', () => {
  it('copies a metric snapshot with only its own content — never entryId', async () => {
    metricsIndex.replaceEntry('01ARZ3NDEKTSV4RRFFQ69G5FAW', [
      {
        id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        metric: 'exercise',
        eventTime: '2026-07-20T09:00:00+01:00',
        eventEpochMs: Date.parse('2026-07-20T08:00:00Z'),
        eventTimeExplicit: true,
        detail: 'a 5k run',
        fields: { distance_km: 5 },
        extractedAt: nowTimestamp().canonical,
        touched: false,
      },
    ]);

    await publisher.publish('metric', '01ARZ3NDEKTSV4RRFFQ69G5FAV');

    const key = publicMirrorKey('metric', '01ARZ3NDEKTSV4RRFFQ69G5FAV');
    const snapshot = JSON.parse(blobs.files.get(key)!) as Record<string, unknown>;
    expect(snapshot).toEqual({
      id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      metric: 'exercise',
      eventTime: '2026-07-20T09:00:00+01:00',
      detail: 'a 5k run',
      fields: { distance_km: 5 },
    });
    expect(snapshot).not.toHaveProperty('entryId');
    expect(publisher.isPublished('metric', '01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(true);
  });

  it('copies a review snapshot with only its own content — never entryId', async () => {
    reviewsIndex.replaceEntry('01ARZ3NDEKTSV4RRFFQ69G5FAW', [
      {
        id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        title: 'Some Film',
        medium: 'film',
        rating: 4,
        progress: 100,
        opinion: 'Really enjoyed it.',
        eventTime: '2026-07-20T20:00:00+01:00',
        eventEpochMs: Date.parse('2026-07-20T19:00:00Z'),
        eventTimeExplicit: true,
        extractedAt: nowTimestamp().canonical,
        touched: false,
      },
    ]);

    await publisher.publish('review', '01ARZ3NDEKTSV4RRFFQ69G5FAV');

    const snapshot = JSON.parse(blobs.files.get(publicMirrorKey('review', '01ARZ3NDEKTSV4RRFFQ69G5FAV'))!) as Record<
      string,
      unknown
    >;
    expect(snapshot).toEqual({
      id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      title: 'Some Film',
      medium: 'film',
      rating: 4,
      progress: 100,
      opinion: 'Really enjoyed it.',
      eventTime: '2026-07-20T20:00:00+01:00',
    });
    expect(snapshot).not.toHaveProperty('entryId');
  });

  it('copies a list-item snapshot with only its own content — never entryId', async () => {
    listsIndex.replaceEntry('01ARZ3NDEKTSV4RRFFQ69G5FAW', [
      {
        id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        listType: 'quote',
        text: '"The unexamined life is not worth living."',
        context: 'Socrates',
        importance: 4,
        eventTime: '2026-07-20T20:00:00+01:00',
        eventEpochMs: Date.parse('2026-07-20T19:00:00Z'),
        eventTimeExplicit: true,
        extractedAt: nowTimestamp().canonical,
        touched: false,
      },
    ]);

    await publisher.publish('list_item', '01ARZ3NDEKTSV4RRFFQ69G5FAV');

    const snapshot = JSON.parse(
      blobs.files.get(publicMirrorKey('list_item', '01ARZ3NDEKTSV4RRFFQ69G5FAV'))!,
    ) as Record<string, unknown>;
    expect(snapshot).toEqual({
      id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      listType: 'quote',
      text: '"The unexamined life is not worth living."',
      context: 'Socrates',
      importance: 4,
      eventTime: '2026-07-20T20:00:00+01:00',
    });
    expect(snapshot).not.toHaveProperty('entryId');
  });

  it('copies an opinion-statement snapshot with only its own content — never entryId', async () => {
    opinionStatementsIndex.replaceEntry('01ARZ3NDEKTSV4RRFFQ69G5FAW', [
      {
        id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        subject: 'philosophy',
        statement: 'Believes in living deliberately.',
        eventTime: '2026-07-20T20:00:00+01:00',
        eventEpochMs: Date.parse('2026-07-20T19:00:00Z'),
        eventTimeExplicit: true,
        extractedAt: nowTimestamp().canonical,
        kind: 'note',
        touched: false,
      },
    ]);

    await publisher.publish('opinion_statement', '01ARZ3NDEKTSV4RRFFQ69G5FAV');

    const snapshot = JSON.parse(
      blobs.files.get(publicMirrorKey('opinion_statement', '01ARZ3NDEKTSV4RRFFQ69G5FAV'))!,
    ) as Record<string, unknown>;
    expect(snapshot).toEqual({
      id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      subject: 'philosophy',
      statement: 'Believes in living deliberately.',
      eventTime: '2026-07-20T20:00:00+01:00',
    });
    expect(snapshot).not.toHaveProperty('entryId');
  });

  it('copies a question snapshot with the resolution but never resolvedEntryId or entryId', async () => {
    questionsIndex.replaceRaised('01ARZ3NDEKTSV4RRFFQ69G5FAW', [
      {
        id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        question: 'Should I stay in this job?',
        eventTime: '2026-07-20T20:00:00+01:00',
        eventEpochMs: Date.parse('2026-07-20T19:00:00Z'),
        eventTimeExplicit: true,
        extractedAt: nowTimestamp().canonical,
        touched: false,
        status: 'resolved',
        resolvedEntryId: '01ARZ3NDEKTSV4RRFFQ69G5FAX',
        resolution: 'Decided to stay another year.',
        resolvedAt: nowTimestamp().canonical,
      },
    ]);

    await publisher.publish('question', '01ARZ3NDEKTSV4RRFFQ69G5FAV');

    const snapshot = JSON.parse(blobs.files.get(publicMirrorKey('question', '01ARZ3NDEKTSV4RRFFQ69G5FAV'))!) as Record<
      string,
      unknown
    >;
    expect(snapshot).toEqual({
      id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      question: 'Should I stay in this job?',
      eventTime: '2026-07-20T20:00:00+01:00',
      status: 'resolved',
      resolution: 'Decided to stay another year.',
    });
    expect(snapshot).not.toHaveProperty('entryId');
    expect(snapshot).not.toHaveProperty('resolvedEntryId');
  });

  it('is a tolerant no-op for a derived record that does not exist', async () => {
    await expect(publisher.publish('metric', '01ARZ3NDEKTSV4RRFFQ69G5FAV')).resolves.toBeUndefined();
    expect(blobs.files.size).toBe(0);
  });

  it('resyncs a published metric when the record is edited, and unpublish removes it', async () => {
    metricsIndex.replaceEntry('01ARZ3NDEKTSV4RRFFQ69G5FAW', [
      {
        id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        metric: 'exercise',
        eventTime: '2026-07-20T09:00:00+01:00',
        eventEpochMs: Date.parse('2026-07-20T08:00:00Z'),
        eventTimeExplicit: true,
        detail: 'a 5k run',
        fields: {},
        extractedAt: nowTimestamp().canonical,
        touched: false,
      },
    ]);
    await publisher.publish('metric', '01ARZ3NDEKTSV4RRFFQ69G5FAV');

    metricsIndex.update('01ARZ3NDEKTSV4RRFFQ69G5FAV', { detail: 'a 10k run' }, nowTimestamp().canonical);
    await publisher.resyncIfPublished('metric', '01ARZ3NDEKTSV4RRFFQ69G5FAV');

    const key = publicMirrorKey('metric', '01ARZ3NDEKTSV4RRFFQ69G5FAV');
    const snapshot = JSON.parse(blobs.files.get(key)!) as { detail: string };
    expect(snapshot.detail).toBe('a 10k run');

    await publisher.unpublish('metric', '01ARZ3NDEKTSV4RRFFQ69G5FAV');
    expect(blobs.files.has(key)).toBe(false);
    expect(publisher.isPublished('metric', '01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(false);
  });
});

describe('publishedIds', () => {
  it('is empty for a type nothing has been published under', () => {
    expect(publisher.publishedIds('review')).toEqual(new Set());
  });

  it('lists exactly the ids currently published under one type', async () => {
    metricsIndex.replaceEntry('01ARZ3NDEKTSV4RRFFQ69G5FAW', [
      {
        id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        metric: 'exercise',
        eventTime: '2026-07-20T09:00:00+01:00',
        eventEpochMs: Date.parse('2026-07-20T08:00:00Z'),
        eventTimeExplicit: true,
        detail: 'a 5k run',
        fields: {},
        extractedAt: nowTimestamp().canonical,
        touched: false,
      },
    ]);
    await publisher.publish('metric', '01ARZ3NDEKTSV4RRFFQ69G5FAV');

    expect(publisher.publishedIds('metric')).toEqual(new Set(['01ARZ3NDEKTSV4RRFFQ69G5FAV']));
    expect(publisher.publishedIds('review')).toEqual(new Set());
  });
});

describe('resyncIfPublished', () => {
  it('is a no-op for a source that is not published', async () => {
    const document = await documentStore.create({ title: 'x', body: 'x' });
    await publisher.resyncIfPublished('document', document.id);
    expect(publisher.isPublished('document', document.id)).toBe(false);
  });

  it('overwrites the mirror when the published source changed', async () => {
    const document = await documentStore.create({ title: 'x', body: 'Before.' });
    await publisher.publish('document', document.id);

    const updated = await documentStore.update(document.id, {
      title: 'x',
      body: 'After.',
      contentHash: document.contentHash,
    });
    await publisher.resyncIfPublished('document', document.id);

    const key = publicMirrorKey('document', document.id);
    const snapshot = JSON.parse(blobs.files.get(key)!) as { body: string };
    expect(snapshot.body).toBe(updated.body);
  });

  it('does not rewrite the mirror when nothing actually changed', async () => {
    const document = await documentStore.create({ title: 'x', body: 'x' });
    await publisher.publish('document', document.id);
    expect(blobs.putCalls).toBe(1);

    await publisher.resyncIfPublished('document', document.id);

    expect(blobs.putCalls).toBe(1);
  });

  it('mirrors a photo newly attached to an already-published entry (`plan.md` M19)', async () => {
    const entry = await entryStore.create({ body: 'Before any photo.' });
    await publisher.publish('entry', entry.id);
    expect(blobs.bytes.size).toBe(0);

    const { relativeLink } = await entryStore.addAttachment(entry.id, {
      filename: 'photo.jpg',
      data: Buffer.from('bytes'),
    });
    const updated = await entryStore.update(entry.id, {
      body: `Look at this. ![](${relativeLink})`,
      contentHash: entry.contentHash,
    });
    await publisher.resyncIfPublished('entry', entry.id);

    expect(blobs.bytes.get(publicAttachmentKey(entry.id, 'photo.jpg'))?.data).toEqual(Buffer.from('bytes'));
    const snapshot = JSON.parse(blobs.files.get(publicMirrorKey('entry', entry.id))!) as { body: string };
    expect(snapshot.body).toBe(updated.body);
  });
});

describe('public search indexing (`plan.md` M17)', () => {
  it('indexes a published entry for public search, by paragraph', async () => {
    const entry = await entryStore.create({ body: 'A walk along the coast.' });
    await publisher.publish('entry', entry.id);

    expect(publicSearchIndex.searchText('coast', 10)).toEqual([
      { sourceType: 'entry', sourceId: entry.id, chunkIndex: 0, text: 'A walk along the coast.' },
    ]);
  });

  it('indexes a published document for public search', async () => {
    const document = await documentStore.create({ title: 'A project', body: 'Notes about a lighthouse.' });
    await publisher.publish('document', document.id);

    expect(publicSearchIndex.searchText('lighthouse', 10)).toEqual([
      { sourceType: 'document', sourceId: document.id, chunkIndex: 0, text: 'Notes about a lighthouse.' },
    ]);
  });

  it('removes the public search chunks on unpublish', async () => {
    const entry = await entryStore.create({ body: 'Findable text.' });
    await publisher.publish('entry', entry.id);
    expect(publicSearchIndex.searchText('findable', 10)).toHaveLength(1);

    await publisher.unpublish('entry', entry.id);

    expect(publicSearchIndex.searchText('findable', 10)).toEqual([]);
  });

  it('re-chunks the public search entry on resync', async () => {
    const document = await documentStore.create({ title: 'x', body: 'Before text.' });
    await publisher.publish('document', document.id);

    await documentStore.update(document.id, { title: 'x', body: 'After text.', contentHash: document.contentHash });
    await publisher.resyncIfPublished('document', document.id);

    expect(publicSearchIndex.searchText('before', 10)).toEqual([]);
    expect(publicSearchIndex.searchText('after', 10)).toHaveLength(1);
  });

  it('never indexes a derived-structure record for public search — only entries and documents have prose worth chunking', async () => {
    metricsIndex.replaceEntry('01ARZ3NDEKTSV4RRFFQ69G5FAW', [
      {
        id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        metric: 'exercise',
        eventTime: '2026-07-20T09:00:00+01:00',
        eventEpochMs: Date.parse('2026-07-20T08:00:00Z'),
        eventTimeExplicit: true,
        detail: 'a memorable run along the coast',
        fields: {},
        extractedAt: nowTimestamp().canonical,
        touched: false,
      },
    ]);

    await publisher.publish('metric', '01ARZ3NDEKTSV4RRFFQ69G5FAV');

    expect(publicSearchIndex.stats()).toEqual({ chunkCount: 0 });
  });
});
