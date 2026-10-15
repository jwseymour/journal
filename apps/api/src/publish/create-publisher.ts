import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from '../config.js';
import { createS3Client } from '../store/s3-client.js';
import type { ListItemsReader } from '../index/lists-index.js';
import type { MetricsReader } from '../index/metrics-index.js';
import type { OpinionStatementsReader } from '../index/opinion-statements-index.js';
import type { PublicSearchIndex } from '../index/public-search-index.js';
import type { PublishedIndex } from '../index/published-index.js';
import type { QuestionsReader } from '../index/questions-index.js';
import type { ReviewsReader } from '../index/reviews-index.js';
import type { DocumentStore } from '../store/document-store.js';
import { writeFileAtomic } from '../store/atomic-write.js';
import type { EntryStore } from '../store/entry-store.js';
import { Publisher, type PublicBlobStore } from './publisher.js';

/**
 * The `public/` mirror's write path — same `fs`/`s3` split every other
 * storage-facing concern in this codebase makes, branching on the same
 * `config.storageBackend` `createEntryStore`/`createDocumentStore` already
 * do, so publishing always lands on whichever backend the rest of the
 * journal actually uses.
 */

class FsPublicBlobStore implements PublicBlobStore {
  readonly #root: string;

  constructor(journalRoot: string) {
    this.#root = journalRoot;
  }

  async put(key: string, json: string): Promise<void> {
    await writeFileAtomic(join(this.#root, key), json, this.#root);
  }

  // `writeFileAtomic` already accepts a `Buffer` (`atomic-write.ts`'s own
  // doc comment — attachments have needed this since M4), so mirroring one
  // is exactly the same call as `put` with different bytes.
  async putBytes(key: string, data: Buffer): Promise<void> {
    await writeFileAtomic(join(this.#root, key), data, this.#root);
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(join(this.#root, key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

class S3PublicBlobStore implements PublicBlobStore {
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

  async putBytes(key: string, data: Buffer, contentType: string): Promise<void> {
    await this.#s3.send(
      new PutObjectCommand({ Bucket: this.#bucket, Key: key, Body: data, ContentType: contentType }),
    );
  }

  async delete(key: string): Promise<void> {
    await this.#s3.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: key }));
  }
}

export function createPublisher(
  config: Config,
  index: PublishedIndex,
  entryStore: EntryStore,
  documentStore: DocumentStore,
  metrics: MetricsReader,
  reviews: ReviewsReader,
  lists: ListItemsReader,
  opinionStatements: OpinionStatementsReader,
  questions: QuestionsReader,
  publicSearchIndex: PublicSearchIndex,
): Publisher {
  const blobs: PublicBlobStore =
    config.storageBackend === 'fs'
      ? new FsPublicBlobStore(config.journalDir)
      : new S3PublicBlobStore(createS3Client(config), config.s3Bucket!);

  return new Publisher(
    blobs,
    index,
    entryStore,
    documentStore,
    metrics,
    reviews,
    lists,
    opinionStatements,
    questions,
    publicSearchIndex,
  );
}
