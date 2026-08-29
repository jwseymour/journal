import type { ListItemRecord } from '../index/lists-index.js';
import type { TemporalMetricRecord } from '../index/metrics-index.js';
import type { OpinionStatementRecord } from '../index/opinion-statements-index.js';
import type { QuestionRecord } from '../index/questions-index.js';
import type { ReviewRecord } from '../index/reviews-index.js';
import type { TodoRecord } from '../index/todos-index.js';

/**
 * Durable backing for touched derived records — closes the gap `plan.md`
 * M10's own "Worth knowing" note flagged and never resolved: `touched`
 * (`requirements.md` §2, §6.4) is supposed to mean a record is the user's
 * permanently, protected from ever being silently regenerated away. But the
 * column that flag lives on, and the only copy of a touched record's
 * content, has only ever lived in `index.db` — which `format.md` §7 and
 * every `Index` class's own doc comments call a disposable cache, free to
 * be deleted and rebuilt at any time. Before this file existed, `rm
 * index.db && npm run rebuild` did exactly that: silently took every
 * correction the user had ever made along with it.
 *
 * The fix mirrors how the rest of the system already treats "durable": a
 * touched record's full content is copied into the same durable storage
 * (`fs` or S3, `create-touched-mirror.ts`) that entries, documents, and the
 * `public/` mirror already live in, under `derived/touched/` — one JSON
 * object per record, keyed the same way `publish/publisher.ts` keys the
 * public mirror. `index.db` remains exactly the disposable cache it always
 * was; this is what makes that true again instead of merely stated.
 *
 * Two operations, both driven from outside this file: `sync` (called from
 * `http/app.ts` after any action that can change whether a record is
 * touched or what a touched record contains) keeps the mirror in step with
 * current truth. `restoreAll` (called from `rebuild.ts`) is the recovery
 * path — reads every mirrored record back and reinserts it into a freshly
 * rebuilt index, the same way `EntryStore.rebuild()` proves durability for
 * entries: by actually deleting the disposable layer and rebuilding from
 * the durable one.
 */

export type TouchedSourceType = 'metric' | 'review' | 'list_item' | 'opinion_statement' | 'question' | 'todo';

/** Where one touched record's durable snapshot lives, relative to the
 * storage root/bucket — the same `<prefix>/<type>s/<id>.json` shape
 * `publish/publisher.ts`'s `publicMirrorKey` uses, one directory over. */
export function touchedMirrorKey(sourceType: TouchedSourceType, sourceId: string): string {
  return `derived/touched/${sourceType}s/${sourceId}.json`;
}

function touchedMirrorPrefix(sourceType: TouchedSourceType): string {
  return `derived/touched/${sourceType}s/`;
}

/** The write/read surface `TouchedMirror` needs against the
 * `derived/touched/` prefix. A superset of `publish/publisher.ts`'s
 * `PublicBlobStore`: recovery means enumerating and reading everything
 * back, not only ever writing forward, so `list` has no equivalent there. */
export interface DurableBlobStore {
  put(key: string, json: string): Promise<void>;
  delete(key: string): Promise<void>;
  /** Every object currently stored under `prefix`, key and contents both. */
  list(prefix: string): Promise<{ key: string; json: string }[]>;
}

interface TouchedReader<T extends { touched: boolean }> {
  getById(id: string): T | null;
}

/** What each `*Index` class already provides for its own record type
 * (`metrics-index.ts` and its five siblings) — a raw upsert that forces
 * `touched = 1`, used only by `restoreAll` below. */
interface TouchedRestorer<T> {
  restoreTouched(record: T): void;
}

type Backing<T extends { touched: boolean }> = TouchedReader<T> & TouchedRestorer<T>;

export class TouchedMirror {
  readonly #blobs: DurableBlobStore;
  readonly #metrics: Backing<TemporalMetricRecord>;
  readonly #reviews: Backing<ReviewRecord>;
  readonly #lists: Backing<ListItemRecord>;
  readonly #opinionStatements: Backing<OpinionStatementRecord>;
  readonly #questions: Backing<QuestionRecord>;
  readonly #todos: Backing<TodoRecord>;

  constructor(
    blobs: DurableBlobStore,
    metrics: Backing<TemporalMetricRecord>,
    reviews: Backing<ReviewRecord>,
    lists: Backing<ListItemRecord>,
    opinionStatements: Backing<OpinionStatementRecord>,
    questions: Backing<QuestionRecord>,
    todos: Backing<TodoRecord>,
  ) {
    this.#blobs = blobs;
    this.#metrics = metrics;
    this.#reviews = reviews;
    this.#lists = lists;
    this.#opinionStatements = opinionStatements;
    this.#questions = questions;
    this.#todos = todos;
  }

  /**
   * Reconciles the durable mirror for one record with its current state.
   * Touched: the record's full current content is written (or overwritten)
   * to `derived/touched/`. Not touched, or gone entirely (discarded,
   * `getById` returns `null`): whatever was mirrored is deleted, since
   * there is nothing left that needs protecting from a disposable-cache
   * wipe. One method covers every mutating action — update, validate,
   * untouch, discard, and approving or rejecting a suggestion — because all
   * of them reduce to the same question: does this id currently need
   * durable backing, and if so, with what content.
   */
  async sync(sourceType: TouchedSourceType, sourceId: string): Promise<void> {
    const record = this.#getById(sourceType, sourceId);
    const key = touchedMirrorKey(sourceType, sourceId);
    if (record && record.touched) {
      await this.#blobs.put(key, JSON.stringify(record));
    } else {
      await this.#blobs.delete(key);
    }
  }

  /** The recovery path (`rebuild.ts`): reads every durably-mirrored touched
   * record back and restores it into the (freshly rebuilt) index. Returns
   * how many records were restored per type, for the same kind of summary
   * line `rebuild.ts` already prints for entries and documents. */
  async restoreAll(): Promise<Record<TouchedSourceType, number>> {
    return {
      metric: await this.#restoreType('metric', this.#metrics),
      review: await this.#restoreType('review', this.#reviews),
      list_item: await this.#restoreType('list_item', this.#lists),
      opinion_statement: await this.#restoreType('opinion_statement', this.#opinionStatements),
      question: await this.#restoreType('question', this.#questions),
      todo: await this.#restoreType('todo', this.#todos),
    };
  }

  async #restoreType<T>(sourceType: TouchedSourceType, target: TouchedRestorer<T>): Promise<number> {
    const objects = await this.#blobs.list(touchedMirrorPrefix(sourceType));
    for (const { json } of objects) {
      target.restoreTouched(JSON.parse(json) as T);
    }
    return objects.length;
  }

  #getById(sourceType: TouchedSourceType, sourceId: string): { touched: boolean } | null {
    switch (sourceType) {
      case 'metric':
        return this.#metrics.getById(sourceId);
      case 'review':
        return this.#reviews.getById(sourceId);
      case 'list_item':
        return this.#lists.getById(sourceId);
      case 'opinion_statement':
        return this.#opinionStatements.getById(sourceId);
      case 'question':
        return this.#questions.getById(sourceId);
      case 'todo':
        return this.#todos.getById(sourceId);
    }
  }
}
