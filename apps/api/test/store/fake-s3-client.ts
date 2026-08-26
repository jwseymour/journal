import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';

/**
 * An in-memory stand-in for `S3Client`, used only by
 * `entry-store-contract.test.ts` (`plan.md` M11). Real enough to exercise
 * `S3EntryStore`'s actual command-building logic — object identity via
 * `instanceof`, the same `NoSuchKey`/`NotFound` error shape a real bucket
 * would throw, keyset listing with pagination — without a real AWS account
 * or a MinIO container in CI.
 */
export interface FakeS3Client extends Pick<S3Client, 'send'> {
  /** Test-only: read an object's raw bytes directly, bypassing `EntryStore`. */
  readRaw(key: string): Buffer | undefined;
  /** Test-only: write an object directly, as if something else wrote to the
   * bucket out of band. */
  writeRaw(key: string, body: string | Buffer): void;
}

function notFound(name: 'NoSuchKey' | 'NotFound'): Error {
  const error = new Error(name) as Error & { name: string; $metadata: { httpStatusCode: number } };
  error.name = name;
  error.$metadata = { httpStatusCode: 404 };
  return error;
}

export function createFakeS3Client(pageSize = 1000): FakeS3Client {
  const objects = new Map<string, Buffer>();

  return {
    readRaw: (key) => objects.get(key),
    writeRaw: (key, body) => {
      objects.set(key, typeof body === 'string' ? Buffer.from(body, 'utf8') : body);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    send: (async (command: any) => {
      if (command instanceof PutObjectCommand) {
        const { Key, Body } = command.input;
        const buffer =
          typeof Body === 'string'
            ? Buffer.from(Body, 'utf8')
            : Buffer.isBuffer(Body)
              ? Body
              : Buffer.from(Body as Uint8Array);
        objects.set(Key as string, buffer);
        return {};
      }

      if (command instanceof GetObjectCommand) {
        const key = command.input.Key as string;
        const buffer = objects.get(key);
        if (!buffer) throw notFound('NoSuchKey');
        return { Body: { transformToString: async () => buffer.toString('utf8') } };
      }

      if (command instanceof HeadObjectCommand) {
        const key = command.input.Key as string;
        if (!objects.has(key)) throw notFound('NotFound');
        return {};
      }

      if (command instanceof DeleteObjectCommand) {
        objects.delete(command.input.Key as string);
        return {};
      }

      if (command instanceof ListObjectsV2Command) {
        const prefix = (command.input.Prefix as string | undefined) ?? '';
        const token = command.input.ContinuationToken as string | undefined;
        const allKeys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
        const start = token ? Number(token) : 0;
        const page = allKeys.slice(start, start + pageSize);
        const nextStart = start + pageSize;
        const isTruncated = nextStart < allKeys.length;
        return {
          Contents: page.map((Key) => ({ Key })),
          IsTruncated: isTruncated,
          NextContinuationToken: isTruncated ? String(nextStart) : undefined,
        };
      }

      throw new Error(`FakeS3Client: unsupported command ${command?.constructor?.name}`);
    }) as S3Client['send'],
  };
}
