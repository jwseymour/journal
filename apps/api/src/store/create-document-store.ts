import { S3Client } from '@aws-sdk/client-s3';
import type { Config } from '../config.js';
import type { DocumentsIndex } from '../index/documents-index.js';
import { FsDocumentStore } from './fs-document-store.js';
import { S3DocumentStore } from './s3-document-store.js';

/**
 * Constructs the one `DocumentStore` implementation `config.storageBackend`
 * names — the document-store twin of `create-entry-store.ts`, branching on
 * the same config value so a document and an entry are always on the same
 * backend. The return type is a union rather than `DocumentStore` for the
 * same reason `createEntryStore`'s is: `rebuild.ts` needs `.rebuild()`.
 */
export function createDocumentStore(config: Config, index: DocumentsIndex): FsDocumentStore | S3DocumentStore {
  if (config.storageBackend === 'fs') {
    return new FsDocumentStore(config.journalDir, index);
  }

  const s3 = new S3Client({
    region: config.awsRegion!,
    ...(config.awsAccessKeyId && config.awsSecretAccessKey
      ? { credentials: { accessKeyId: config.awsAccessKeyId, secretAccessKey: config.awsSecretAccessKey } }
      : {}),
  });
  return new S3DocumentStore(s3, config.s3Bucket!, index);
}
