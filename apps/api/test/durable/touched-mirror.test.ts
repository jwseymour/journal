import { beforeEach, describe, expect, it } from 'vitest';
import { TouchedMirror, touchedMirrorKey, type DurableBlobStore } from '../../src/durable/touched-mirror.js';
import { ListsIndex } from '../../src/index/lists-index.js';
import { MetricsIndex } from '../../src/index/metrics-index.js';
import { OpinionStatementsIndex } from '../../src/index/opinion-statements-index.js';
import { QuestionsIndex } from '../../src/index/questions-index.js';
import { ReviewsIndex } from '../../src/index/reviews-index.js';
import { TodosIndex } from '../../src/index/todos-index.js';

/** The same fake-the-seam approach `publish/publisher.test.ts`'s
 * `FakeBlobStore` takes for `PublicBlobStore` — an in-memory stand-in for
 * `DurableBlobStore`, real enough to prove `list` returns exactly what was
 * `put`. */
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

let blobs: FakeDurableBlobStore;
let metricsIndex: MetricsIndex;
let reviewsIndex: ReviewsIndex;
let listsIndex: ListsIndex;
let opinionStatementsIndex: OpinionStatementsIndex;
let questionsIndex: QuestionsIndex;
let todosIndex: TodosIndex;
let mirror: TouchedMirror;

function freshIndexes(): void {
  metricsIndex = new MetricsIndex(':memory:');
  reviewsIndex = new ReviewsIndex(':memory:');
  listsIndex = new ListsIndex(':memory:');
  opinionStatementsIndex = new OpinionStatementsIndex(':memory:');
  questionsIndex = new QuestionsIndex(':memory:');
  todosIndex = new TodosIndex(':memory:');
  mirror = new TouchedMirror(
    blobs,
    metricsIndex,
    reviewsIndex,
    listsIndex,
    opinionStatementsIndex,
    questionsIndex,
    todosIndex,
  );
}

beforeEach(() => {
  blobs = new FakeDurableBlobStore();
  freshIndexes();
});

const metric = { id: 'm1', entryId: 'e1', metric: 'exercise', eventTime: '2026-07-20T09:00:00+01:00', eventEpochMs: Date.parse('2026-07-20T08:00:00Z'), eventTimeExplicit: true, detail: 'a run', fields: {}, extractedAt: '2026-07-20T10:00:00+01:00' };

describe('sync', () => {
  it('writes a touched record to the durable mirror', async () => {
    metricsIndex.replaceEntry('e1', [{ ...metric, touched: false }]);
    metricsIndex.validate('m1', 'now');

    await mirror.sync('metric', 'm1');

    const key = touchedMirrorKey('metric', 'm1');
    expect(blobs.files.has(key)).toBe(true);
    expect(JSON.parse(blobs.files.get(key)!)).toMatchObject({ id: 'm1', touched: true, detail: 'a run' });
  });

  it('overwrites the mirror with a touched record’s latest content on every sync', async () => {
    metricsIndex.replaceEntry('e1', [{ ...metric, touched: false }]);
    metricsIndex.update('m1', { detail: 'a 10k run' }, 'now');
    await mirror.sync('metric', 'm1');

    const key = touchedMirrorKey('metric', 'm1');
    expect(JSON.parse(blobs.files.get(key)!)).toMatchObject({ detail: 'a 10k run' });
  });

  it('deletes the mirror when a record is reverted to untouched', async () => {
    metricsIndex.replaceEntry('e1', [{ ...metric, touched: false }]);
    metricsIndex.validate('m1', 'now');
    await mirror.sync('metric', 'm1');
    expect(blobs.files.has(touchedMirrorKey('metric', 'm1'))).toBe(true);

    metricsIndex.untouch('m1', 'now');
    await mirror.sync('metric', 'm1');

    expect(blobs.files.has(touchedMirrorKey('metric', 'm1'))).toBe(false);
  });

  it('deletes the mirror when a touched record is discarded entirely', async () => {
    metricsIndex.replaceEntry('e1', [{ ...metric, touched: false }]);
    metricsIndex.validate('m1', 'now');
    await mirror.sync('metric', 'm1');

    metricsIndex.remove('m1');
    await mirror.sync('metric', 'm1');

    expect(blobs.files.has(touchedMirrorKey('metric', 'm1'))).toBe(false);
  });

  it('never writes anything for a record that was never touched', async () => {
    metricsIndex.replaceEntry('e1', [{ ...metric, touched: false }]);
    await mirror.sync('metric', 'm1');
    expect(blobs.files.size).toBe(0);
  });
});

describe('restoreAll — the actual bug this file exists to fix', () => {
  it('survives `index.db` being deleted and rebuilt from scratch: a touched record comes back, an untouched one does not', async () => {
    // Two metrics on the same entry: one the user corrected (touched), one
    // never reviewed (still AI-owned/untouched) — the exact situation
    // `plan.md` M10's "Worth knowing" note left unresolved.
    metricsIndex.replaceEntry('e1', [
      { ...metric, id: 'touched-one', touched: false },
      { ...metric, id: 'untouched-one', touched: false },
    ]);
    metricsIndex.update('touched-one', { detail: 'corrected: actually a 10k run' }, 'now');
    await mirror.sync('metric', 'touched-one');

    // Simulate `rm index.db` — a brand-new, empty index, same durable blob
    // store. Nothing about the mirror or its contents changes.
    freshIndexes();
    expect(metricsIndex.list({ limit: 10 })).toEqual([]);

    const counts = await mirror.restoreAll();

    expect(counts.metric).toBe(1);
    expect(metricsIndex.getById('touched-one')).toMatchObject({
      detail: 'corrected: actually a 10k run',
      touched: true,
    });
    // The untouched record is genuinely gone — recoverable only by
    // `npm run reprocess`, never by this recovery path, which is correct:
    // it was always a disposable cache, unlike the touched one beside it.
    expect(metricsIndex.getById('untouched-one')).toBeNull();
  });

  it('restores across every structure type, not only metrics', async () => {
    reviewsIndex.replaceEntry('e1', [{ id: 'r1', title: 'A Book', medium: 'book', rating: 5, progress: 100, opinion: 'Loved it.', eventTime: metric.eventTime, eventEpochMs: metric.eventEpochMs, eventTimeExplicit: true, extractedAt: metric.extractedAt, touched: false }]);
    reviewsIndex.validate('r1', 'now');
    await mirror.sync('review', 'r1');

    listsIndex.replaceEntry('e1', [{ id: 'l1', listType: 'quote', text: 'A quote', context: '', importance: 3, eventTime: metric.eventTime, eventEpochMs: metric.eventEpochMs, eventTimeExplicit: true, extractedAt: metric.extractedAt, touched: false }]);
    listsIndex.validate('l1', 'now');
    await mirror.sync('list_item', 'l1');

    opinionStatementsIndex.replaceEntry('e1', [{ id: 'o1', subject: 'philosophy', statement: 'A view', kind: 'note', eventTime: metric.eventTime, eventEpochMs: metric.eventEpochMs, eventTimeExplicit: true, extractedAt: metric.extractedAt, touched: false }]);
    opinionStatementsIndex.validate('o1', 'now');
    await mirror.sync('opinion_statement', 'o1');

    questionsIndex.replaceRaised('e1', [{ id: 'q1', question: 'A question', eventTime: metric.eventTime, eventEpochMs: metric.eventEpochMs, eventTimeExplicit: true, extractedAt: metric.extractedAt, status: 'open', resolvedEntryId: null, resolution: null, resolvedAt: null, touched: false }]);
    questionsIndex.validate('q1', 'now');
    await mirror.sync('question', 'q1');

    todosIndex.createDirect({ id: 't1', text: 'A user todo', now: metric.eventTime });
    await mirror.sync('todo', 't1');

    freshIndexes();
    const counts = await mirror.restoreAll();

    expect(counts).toEqual({ metric: 0, review: 1, list_item: 1, opinion_statement: 1, question: 1, todo: 1 });
    expect(reviewsIndex.getById('r1')).toMatchObject({ touched: true, title: 'A Book' });
    expect(listsIndex.getById('l1')).toMatchObject({ touched: true, text: 'A quote' });
    expect(opinionStatementsIndex.getById('o1')).toMatchObject({ touched: true, statement: 'A view' });
    expect(questionsIndex.getById('q1')).toMatchObject({ touched: true, question: 'A question' });
    expect(todosIndex.getById('t1')).toMatchObject({ touched: true, origin: 'user', entryId: null });
  });

  it('is a harmless no-op to run against an index that was never actually lost', async () => {
    metricsIndex.replaceEntry('e1', [{ ...metric, touched: false }]);
    metricsIndex.validate('m1', 'now');
    await mirror.sync('metric', 'm1');

    await mirror.restoreAll();
    await mirror.restoreAll();

    expect(metricsIndex.list({ limit: 10 })).toHaveLength(1);
  });
});
