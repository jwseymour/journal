import { S3Client } from '@aws-sdk/client-s3';
import { fromTemporaryCredentials } from '@aws-sdk/credential-providers';
import type { Config } from '../config.js';

/**
 * The one place `apps/api` builds an S3 client — used by `createEntryStore`,
 * `createDocumentStore`, and `createPublisher` alike, so credential handling
 * never drifts between them.
 *
 * When `config.s3AssumeRoleArn` is set (the deployed EC2 host —
 * `infra/terraform/main.tf` — gives the instance itself only `public/*`
 * read access, and `apps/api` assumes this second, broader role to reach
 * `journal/*`/`documents/*`), credentials come from that assumed role
 * instead of the default chain. `apps/public-api` has no equivalent of this
 * function and never assumes anything — it just uses whatever the instance
 * role already grants it directly.
 */
export function createS3Client(config: Config): S3Client {
  return new S3Client({
    region: config.awsRegion!,
    ...(config.s3AssumeRoleArn
      ? {
          credentials: fromTemporaryCredentials({
            params: { RoleArn: config.s3AssumeRoleArn, RoleSessionName: 'journal-api' },
          }),
        }
      : config.awsAccessKeyId && config.awsSecretAccessKey
        ? { credentials: { accessKeyId: config.awsAccessKeyId, secretAccessKey: config.awsSecretAccessKey } }
        : {}),
  });
}
