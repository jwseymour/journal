import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { readdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from '../config.js';
import type { ListsIndex } from '../index/lists-index.js';
import type { MetricsIndex } from '../index/metrics-index.js';
import type { OpinionStatementsIndex } from '../index/opinion-statements-index.js';
import type { QuestionsIndex } from '../index/questions-index.js';
import type { ReviewsIndex } from '../index/reviews-index.js';
import type { TodosIndex } from '../index/todos-index.js';
import { writeFileAtomic } from '../store/atomic-write.js';
import { createS3Client } from '../store/s3-client.js';
import { TouchedMirror, type DurableBlobStore } from './touched-mirror.js';

/**
 * The `derived/touched/` mirror's read/write path — the same `fs`/`s3`
 * split every other storage-facing concern in this codebase makes
 * (`store/create-entry-store.ts`, `publish/create-publisher.ts`), branching
 * on the same `config.storageBackend`, so touched-record durability always
 * lands on whichever backend the rest of the journal actually uses.
 */

class FsDurableBlobStore implements DurableBlobStore {
  readonly #root: string;

  constructor(journalRoot: string) {
    this.#root = journalRoot;
  }

  async put(key: string, json: string): Promise<void> {
    await writeFileAtomic(join(this.#root, key), json, this.#root);
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(join(this.#root, key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  /** `prefix` is always one flat directory (`derived/touched/<type>s/`,
   * `touched-mirror.ts`) — no recursion needed, just every `.json` file
   * directly inside it. A missing directory (nothing of this type has ever
   * been touched) is an empty list, not an error. */
  async list(prefix: string): Promise<{ key: string; json: string }[]> {
    const dir = join(this.#root, prefix);
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }

    const results: { key: string; json: string }[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const json = await readFile(join(dir, entry.name), 'utf8');
      results.push({ key: `${prefix}${entry.name}`, json });
    }
    return results;
  }
}

class S3DurableBlobStore implements DurableBlobStore {
  readonly #s3: S3Client;
  readonly #bucket: string;

  constructor(s3: S3Client, bucket: string) {
    this.#s3 = s3;
    this.#bucket = bucket;
  }

  async put(key: string, json: string): Promise<void> {
    await this.#s3.send(
      new PutObjectCommand({ Bucket: this.#bucket, Key: key, Body: json, ContentType: 'application/json' }),
    );
  }

  async delete(key: string): Promise<void> {
    await this.#s3.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: key }));
  }

  async list(prefix: string): Promise<{ key: string; json: string }[]> {
    const results: { key: string; json: string }[] = [];
    let continuationToken: string | undefined;

    do {
      const page = await this.#s3.send(
        new ListObjectsV2Command({
          Bucket: this.#bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const object of page.Contents ?? []) {
        if (!object.Key) continue;
        const body = await this.#s3.send(new GetObjectCommand({ Bucket: this.#bucket, Key: object.Key }));
        const json = await body.Body?.transformToString('utf8');
        if (json !== undefined) results.push({ key: object.Key, json });
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);

    return results;
  }
}

/**
 * Takes the concrete `*Index` classes, not their `*Reader` interfaces —
 * `TouchedMirror` needs `restoreTouched` (`touched-mirror.ts`), which is
 * deliberately not part of any `*Reader` interface (nothing else needs it),
 * so only the real index, never a hand-written fake, satisfies this.
 */
export function createTouchedMirror(
  config: Config,
  metrics: MetricsIndex,
  reviews: ReviewsIndex,
  lists: ListsIndex,
  opinionStatements: OpinionStatementsIndex,
  questions: QuestionsIndex,
  todos: TodosIndex,
): TouchedMirror {
  const blobs: DurableBlobStore =
    config.storageBackend === 'fs'
      ? new FsDurableBlobStore(config.journalDir)
      : new S3DurableBlobStore(createS3Client(config), config.s3Bucket!);

  return new TouchedMirror(blobs, metrics, reviews, lists, opinionStatements, questions, todos);
}
