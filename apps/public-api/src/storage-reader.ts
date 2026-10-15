import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { PublicApiConfig } from './config.js';

/**
 * Read-only access to the document files themselves — mirrors
 * `apps/api/src/store/{fs,s3}-document-store.ts`'s read paths, but this is
 * the entire surface: no write, no create, no list-the-directory scan. The
 * index (`index-reader.ts`) is always what says *which* documents exist;
 * this only ever fetches the bytes of one already-known path.
 */
export interface StorageReader {
  /** The raw file text at `relPath`, or `null` if it is gone. */
  read(relPath: string): Promise<string | null>;

  /** The raw bytes at `relPath`, or `null` if it is gone — a published
   * entry's mirrored attachment (`plan.md` M19), never a snapshot, which
   * `read` above already handles as text. */
  readBytes(relPath: string): Promise<Buffer | null>;
}

function isNotFound(error: unknown): boolean {
  if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return true;
  const name = (error as { name?: string } | null)?.name;
  return name === 'NoSuchKey' || name === 'NotFound';
}

class FsStorageReader implements StorageReader {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  async read(relPath: string): Promise<string | null> {
    try {
      return await readFile(join(this.#root, relPath), 'utf8');
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async readBytes(relPath: string): Promise<Buffer | null> {
    try {
      return await readFile(join(this.#root, relPath));
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }
}

class S3StorageReader implements StorageReader {
  readonly #s3: S3Client;
  readonly #bucket: string;

  constructor(s3: S3Client, bucket: string) {
    this.#s3 = s3;
    this.#bucket = bucket;
  }

  async read(relPath: string): Promise<string | null> {
    try {
      const response = await this.#s3.send(new GetObjectCommand({ Bucket: this.#bucket, Key: relPath }));
      return await (response.Body as { transformToString(): Promise<string> }).transformToString();
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async readBytes(relPath: string): Promise<Buffer | null> {
    try {
      const response = await this.#s3.send(new GetObjectCommand({ Bucket: this.#bucket, Key: relPath }));
      const bytes = await (response.Body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray();
      return Buffer.from(bytes);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }
}

/** Constructs the one `StorageReader` `config.storageBackend` names — same
 * branch `apps/api/src/store/create-document-store.ts` makes, so this
 * service always reads from wherever the private API actually writes. */
export function createStorageReader(config: PublicApiConfig): StorageReader {
  if (config.storageBackend === 'fs') {
    return new FsStorageReader(config.journalDir!);
  }

  const s3 = new S3Client({
    region: config.awsRegion!,
    ...(config.awsAccessKeyId && config.awsSecretAccessKey
      ? { credentials: { accessKeyId: config.awsAccessKeyId, secretAccessKey: config.awsSecretAccessKey } }
      : {}),
  });
  return new S3StorageReader(s3, config.s3Bucket!);
}
