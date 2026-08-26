import { S3Client } from '@aws-sdk/client-s3';
import type { Config } from '../config.js';
import type { SqliteIndex } from '../index/sqlite-index.js';
import { FsEntryStore } from './fs-entry-store.js';
import { S3EntryStore } from './s3-entry-store.js';

/**
 * Constructs the one `EntryStore` implementation `config.storageBackend`
 * names (`plan.md` M11) — the single place that branches on it, so
 * `index.ts`/`rebuild.ts`/`reprocess.ts` each call this instead of
 * repeating the same `if`. The return type is a union rather than the
 * `EntryStore` interface because `rebuild.ts` needs `.rebuild()`, which
 * (like `FsEntryStore` before it) is a concrete capability of each backend
 * rather than part of the interface every caller gets.
 */
export function createEntryStore(config: Config, index: SqliteIndex): FsEntryStore | S3EntryStore {
  if (config.storageBackend === 'fs') {
    return new FsEntryStore(config.journalDir, index);
  }

  // Validated at boot (`config.ts`) — both are guaranteed set once
  // `storageBackend` is `s3`.
  const s3 = new S3Client({
    region: config.awsRegion!,
    ...(config.awsAccessKeyId && config.awsSecretAccessKey
      ? { credentials: { accessKeyId: config.awsAccessKeyId, secretAccessKey: config.awsSecretAccessKey } }
      : {}),
  });
  return new S3EntryStore(s3, config.s3Bucket!, index);
}
