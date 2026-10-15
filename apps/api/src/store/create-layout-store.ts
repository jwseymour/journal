import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { readdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from '../config.js';
import type { LayoutsIndex } from '../index/layouts-index.js';
import { writeFileAtomic } from './atomic-write.js';
import { createS3Client } from './s3-client.js';
import { DurableLayoutStore, type LayoutBlobStore } from './layout-store.js';

/**
 * `derived/layouts/` read/write, on the same `fs`/`s3` split every other
 * storage-facing concern makes (`create-touched-mirror.ts`,
 * `create-entry-store.ts`), branching on `config.storageBackend` so layouts
 * always land on whichever backend the rest of the journal uses.
 */

class FsLayoutBlobStore implements LayoutBlobStore {
  readonly #root: string;

  constructor(journalRoot: string) {
    this.#root = journalRoot;
  }

  async put(key: string, body: string): Promise<void> {
    await writeFileAtomic(join(this.#root, key), body, this.#root);
  }

  async get(key: string): Promise<string | null> {
    try {
      return await readFile(join(this.#root, key), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(join(this.#root, key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  /** `prefix` is always the one flat `derived/layouts/` directory. A missing
   * directory (no layout has ever been saved) is an empty list. */
  async listKeys(prefix: string): Promise<string[]> {
    const dir = join(this.#root, prefix);
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      return entries.filter((entry) => entry.isFile()).map((entry) => `${prefix}${entry.name}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
}

class S3LayoutBlobStore implements LayoutBlobStore {
  readonly #s3: S3Client;
  readonly #bucket: string;

  constructor(s3: S3Client, bucket: string) {
    this.#s3 = s3;
    this.#bucket = bucket;
  }

  async put(key: string, body: string): Promise<void> {
    const contentType = key.endsWith('.json') ? 'application/json' : 'text/plain';
    await this.#s3.send(new PutObjectCommand({ Bucket: this.#bucket, Key: key, Body: body, ContentType: contentType }));
  }

  async get(key: string): Promise<string | null> {
    try {
      const response = await this.#s3.send(new GetObjectCommand({ Bucket: this.#bucket, Key: key }));
      return (await response.Body?.transformToString('utf8')) ?? null;
    } catch (error) {
      if ((error as { name?: string }).name === 'NoSuchKey') return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await this.#s3.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: key }));
  }

  async listKeys(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const page = await this.#s3.send(
        new ListObjectsV2Command({ Bucket: this.#bucket, Prefix: prefix, ContinuationToken: continuationToken }),
      );
      for (const object of page.Contents ?? []) {
        if (object.Key) keys.push(object.Key);
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);
    return keys;
  }
}

export function createLayoutStore(config: Config, index: LayoutsIndex): DurableLayoutStore {
  const blobs: LayoutBlobStore =
    config.storageBackend === 'fs'
      ? new FsLayoutBlobStore(config.journalDir)
      : new S3LayoutBlobStore(createS3Client(config), config.s3Bucket!);

  return new DurableLayoutStore(blobs, index);
}
