import type { Config } from '../config.js';
import type { MediaIndex } from '../index/media-index.js';
import { FsMediaStore } from './fs-media-store.js';
import { S3MediaStore } from './s3-media-store.js';
import { createS3Client } from './s3-client.js';

/**
 * Constructs the one `MediaStore` implementation `config.storageBackend`
 * names — the media-store twin of `create-document-store.ts`, branching on
 * the same config value so media and the rest of the journal are always on
 * the same backend. The return type is a union rather than `MediaStore` for
 * the same reason `createDocumentStore`'s is: `rebuild.ts` needs `.rebuild()`.
 */
export function createMediaStore(config: Config, index: MediaIndex): FsMediaStore | S3MediaStore {
  if (config.storageBackend === 'fs') {
    return new FsMediaStore(config.journalDir, index);
  }

  return new S3MediaStore(createS3Client(config), config.s3Bucket!, index);
}
