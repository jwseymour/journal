import type { S3Client } from '@aws-sdk/client-s3';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../../src/errors.js';
import { MediaIndex } from '../../src/index/media-index.js';
import type { MediaStore, MediaStoreStats } from '../../src/store/media-store.js';
import { FsMediaStore } from '../../src/store/fs-media-store.js';
import { S3MediaStore } from '../../src/store/s3-media-store.js';
import { createFakeS3Client } from './fake-s3-client.js';

/**
 * The `MediaStore` contract, run against both implementations
 * (`requirements.md` — photo library, M19) — mirrors
 * `document-store-contract.test.ts` exactly in shape and reasoning.
 *
 * A real, well-formed MP4 fixture (built by hand, the same box layout
 * `video-metadata.test.ts` verifies) stands in for "a media file with
 * extractable metadata" throughout, so the metadata-extraction path is
 * exercised end to end without depending on a real photo library fixture
 * checked into the repo.
 */

function box(type: string, body: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + body.length, 0);
  header.write(type, 4, 4, 'ascii');
  return Buffer.concat([header, body]);
}

const MAC_EPOCH_OFFSET_SECONDS = 2_082_844_800;

function fixtureVideo(capturedAt: Date): Buffer {
  const macSeconds = Math.floor(capturedAt.getTime() / 1000) + MAC_EPOCH_OFFSET_SECONDS;
  const mvhdBody = Buffer.alloc(20);
  mvhdBody.writeUInt32BE(macSeconds, 4);
  const ftyp = box('ftyp', Buffer.from('isommp42', 'ascii'));
  const moov = box('moov', box('mvhd', mvhdBody));
  return Buffer.concat([ftyp, moov]);
}

function isoOf(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

const CAPTURED = new Date(Date.UTC(2024, 5, 1, 14, 22, 3));
const VIDEO_FIXTURE = fixtureVideo(CAPTURED);

interface Harness {
  readonly store: MediaStore & { rebuild(): Promise<MediaStoreStats> };
  /** Places a binary + sidecar directly, as if written by something else
   * entirely (or by a previous run whose index.db was then deleted). */
  writeRaw(id: string, ext: string, data: Buffer, sidecar: { originalFilename: string; uploadedAt: string }): Promise<void>;
  /** A binary with no sidecar at all — the "damage" case `rebuild` must
   * survive without failing the whole scan. */
  writeBinaryOnly(id: string, ext: string, data: Buffer): Promise<void>;
  cleanup(): Promise<void>;
}

async function makeFsHarness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'journal-media-contract-'));
  const index = new MediaIndex(':memory:');
  const store = new FsMediaStore(root, index);
  return {
    store,
    writeRaw: async (id, ext, data, sidecar) => {
      await writeFile(join(root, 'media', `${id}${ext}`), data).catch(async (cause) => {
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
          const { mkdir } = await import('node:fs/promises');
          await mkdir(join(root, 'media'), { recursive: true });
          await writeFile(join(root, 'media', `${id}${ext}`), data);
          return;
        }
        throw cause;
      });
      await writeFile(join(root, 'media', `${id}.json`), JSON.stringify(sidecar), 'utf8');
    },
    writeBinaryOnly: async (id, ext, data) => {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(join(root, 'media'), { recursive: true });
      await writeFile(join(root, 'media', `${id}${ext}`), data);
    },
    cleanup: async () => {
      index.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function makeS3Harness(): Harness {
  const fake = createFakeS3Client();
  const index = new MediaIndex(':memory:');
  const store = new S3MediaStore(fake as unknown as S3Client, 'contract-test-bucket', index);
  return {
    store,
    writeRaw: async (id, ext, data, sidecar) => {
      fake.writeRaw(`media/${id}${ext}`, data);
      fake.writeRaw(`media/${id}.json`, JSON.stringify(sidecar));
    },
    writeBinaryOnly: async (id, ext, data) => {
      fake.writeRaw(`media/${id}${ext}`, data);
    },
    cleanup: async () => {
      index.close();
    },
  };
}

async function catchError(fn: () => Promise<unknown>): Promise<AppError> {
  try {
    await fn();
  } catch (error) {
    return error as AppError;
  }
  throw new Error('expected a failure');
}

const backends: [string, () => Promise<Harness> | Harness][] = [
  ['FsMediaStore', makeFsHarness],
  ['S3MediaStore', makeS3Harness],
];

describe.each(backends)('%s — MediaStore contract', (_name, makeHarness) => {
  let h: Harness;

  beforeEach(async () => {
    h = await makeHarness();
  });

  afterEach(async () => {
    await h.cleanup();
  });

  describe('upload', () => {
    it('stores the item and extracts its metadata from the bytes themselves', async () => {
      const stored = await h.store.upload({
        contentType: 'video/mp4',
        data: VIDEO_FIXTURE,
        originalFilename: 'IMG_0001.mp4',
      });

      expect(stored.kind).toBe('video');
      expect(stored.contentType).toBe('video/mp4');
      expect(stored.byteSize).toBe(VIDEO_FIXTURE.length);
      expect(stored.originalFilename).toBe('IMG_0001.mp4');
      expect(stored.capturedAt).toBe(isoOf(CAPTURED));
      expect(stored.path).toBe(`media/${stored.id}.mp4`);
    });

    it('still stores a file with no extractable metadata, rather than rejecting it', async () => {
      const stored = await h.store.upload({
        contentType: 'image/jpeg',
        data: Buffer.from('not actually a jpeg'),
        originalFilename: 'weird.jpg',
      });
      expect(stored.capturedAt).toBeNull();
      expect(stored.width).toBeNull();
    });

    it('rejects an unsupported content type', async () => {
      const error = await catchError(() =>
        h.store.upload({ contentType: 'audio/mpeg', data: Buffer.from('x'), originalFilename: 'voice.mp3' }),
      );
      expect(error.code).toBe('unsupported_media_type');
    });

    it('rejects an upload with no filename', async () => {
      for (const originalFilename of ['', '   ']) {
        const error = await catchError(() =>
          h.store.upload({ contentType: 'video/mp4', data: VIDEO_FIXTURE, originalFilename }),
        );
        expect(error.code).toBe('invalid_request');
      }
    });

    it('gives every item a distinct id, even uploaded concurrently', async () => {
      const items = await Promise.all(
        Array.from({ length: 15 }, (_, i) =>
          h.store.upload({ contentType: 'video/mp4', data: VIDEO_FIXTURE, originalFilename: `v${i}.mp4` }),
        ),
      );
      expect(new Set(items.map((m) => m.id)).size).toBe(15);
    });
  });

  describe('get / getBytes', () => {
    it('finds an item by id, and its raw bytes match exactly what was uploaded', async () => {
      const stored = await h.store.upload({
        contentType: 'video/mp4',
        data: VIDEO_FIXTURE,
        originalFilename: 'a.mp4',
      });

      expect(await h.store.get(stored.id)).toEqual(stored);
      const bytes = await h.store.getBytes(stored.id);
      expect(bytes?.contentType).toBe('video/mp4');
      expect(bytes?.data.equals(VIDEO_FIXTURE)).toBe(true);
    });

    it('returns null for an id that does not exist', async () => {
      expect(await h.store.get('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBeNull();
      expect(await h.store.getBytes('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBeNull();
    });

    it('finds an item written by something else entirely, once rebuilt', async () => {
      await h.writeRaw('01ARZ3NDEKTSV4RRFFQ69G5FAV', '.mp4', VIDEO_FIXTURE, {
        originalFilename: 'external.mp4',
        uploadedAt: '2024-06-01T09:00:00Z',
      });
      const stats = await h.store.rebuild();
      expect(stats.mediaCount).toBe(1);

      const media = await h.store.get('01ARZ3NDEKTSV4RRFFQ69G5FAV');
      expect(media?.originalFilename).toBe('external.mp4');
      expect(media?.capturedAt).toBe(isoOf(CAPTURED));
    });
  });

  describe('remove', () => {
    it('deletes the item so it no longer appears anywhere', async () => {
      const stored = await h.store.upload({
        contentType: 'video/mp4',
        data: VIDEO_FIXTURE,
        originalFilename: 'a.mp4',
      });
      await h.store.remove(stored.id);

      expect(await h.store.get(stored.id)).toBeNull();
      expect(await h.store.getBytes(stored.id)).toBeNull();
      expect((await h.store.list({ limit: 10 })).media).toEqual([]);
    });

    it('is a tolerant no-op on an id that does not exist', async () => {
      await expect(h.store.remove('01ARZ3NDEKTSV4RRFFQ69G5FAV')).resolves.toBeUndefined();
    });
  });

  describe('list', () => {
    it('is empty, not an error, when nothing has been uploaded', async () => {
      expect(await h.store.list({ limit: 10 })).toEqual({ media: [], nextCursor: null });
    });

    it('returns every uploaded item exactly once, across however many pages it takes', async () => {
      const uploaded = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          h.store.upload({ contentType: 'video/mp4', data: VIDEO_FIXTURE, originalFilename: `v${i}.mp4` }),
        ),
      );

      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await h.store.list({ limit: 5, ...(cursor ? { cursor } : {}) });
        seen.push(...page.media.map((m) => m.id));
        cursor = page.nextCursor ?? undefined;
        pages += 1;
        expect(pages).toBeLessThan(10);
      } while (cursor);

      expect(seen).toHaveLength(12);
      expect(new Set(seen)).toEqual(new Set(uploaded.map((m) => m.id)));
    });

    it('rejects a cursor it did not issue', async () => {
      const error = await catchError(() => h.store.list({ limit: 5, cursor: 'made-up' }));
      expect(error.code).toBe('invalid_cursor');
    });
  });

  describe('listByCapturedDate', () => {
    it('finds an item captured on that date', async () => {
      await h.store.upload({ contentType: 'video/mp4', data: VIDEO_FIXTURE, originalFilename: 'a.mp4' });
      const date = isoOf(CAPTURED).slice(0, 10);

      const found = await h.store.listByCapturedDate(date);
      expect(found).toHaveLength(1);
      expect(found[0]?.originalFilename).toBe('a.mp4');
    });

    it('is empty for a date nothing was captured on', async () => {
      await h.store.upload({ contentType: 'video/mp4', data: VIDEO_FIXTURE, originalFilename: 'a.mp4' });
      expect(await h.store.listByCapturedDate('1999-01-01')).toEqual([]);
    });

    it('never matches an item with no extractable captured time', async () => {
      await h.store.upload({ contentType: 'image/jpeg', data: Buffer.from('no exif here'), originalFilename: 'x.jpg' });
      expect(await h.store.listByCapturedDate(isoOf(CAPTURED).slice(0, 10))).toEqual([]);
    });
  });

  describe('rebuild', () => {
    it('reproduces the same stats and list contents as the index built incrementally', async () => {
      await h.store.upload({ contentType: 'video/mp4', data: VIDEO_FIXTURE, originalFilename: 'a.mp4' });
      await h.store.upload({ contentType: 'video/mp4', data: VIDEO_FIXTURE, originalFilename: 'b.mp4' });

      const beforeStats = await h.store.stats();
      const { media: before } = await h.store.list({ limit: 10 });

      const result = await h.store.rebuild();

      expect(result).toEqual(beforeStats);
      const { media: after } = await h.store.list({ limit: 10 });
      expect(new Set(after.map((m) => m.id))).toEqual(new Set(before.map((m) => m.id)));
    });

    it('counts, but does not fail over, a binary with no sidecar at all', async () => {
      await h.writeRaw('01GOODNDEKTSV4RRFFQ69G5FAV', '.mp4', VIDEO_FIXTURE, {
        originalFilename: 'fine.mp4',
        uploadedAt: '2024-06-01T09:00:00Z',
      });
      await h.writeBinaryOnly('01BRKN3NDEKTSV4RRFFQ69G5FA', '.mp4', VIDEO_FIXTURE);

      const stats = await h.store.rebuild();
      expect(stats.mediaCount).toBe(1);
      expect(stats.unreadableCount).toBe(1);
      expect((await h.store.get('01GOODNDEKTSV4RRFFQ69G5FAV'))?.originalFilename).toBe('fine.mp4');
      expect(await h.store.get('01BRKN3NDEKTSV4RRFFQ69G5FA')).toBeNull();
    });
  });
});
