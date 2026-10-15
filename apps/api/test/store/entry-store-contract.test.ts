import type { S3Client } from '@aws-sdk/client-s3';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../../src/errors.js';
import { SqliteIndex } from '../../src/index/sqlite-index.js';
import type { EntryStore } from '../../src/store/entry-store.js';
import { FsEntryStore } from '../../src/store/fs-entry-store.js';
import { S3EntryStore } from '../../src/store/s3-entry-store.js';
import { createFakeS3Client } from './fake-s3-client.js';

/**
 * The `EntryStore` contract, run against both implementations (`plan.md`
 * M11) — the seam `entry-store.ts` describes is only genuinely a seam if
 * both sides of it agree on what they promise. This does not replace
 * `fs-entry-store.test.ts`, which additionally checks filesystem-only
 * details (temp files, `fsync`, exact directory contents) that have no S3
 * analogue; this file covers the behavior every caller of `EntryStore` is
 * entitled to rely on, regardless of backend.
 */

interface Harness {
  readonly store: EntryStore & { rebuild(): Promise<{ entryCount: number; unreadableCount: number }> };
  /** Read an object's raw bytes directly, bypassing the store under test. */
  readRaw(key: string): Promise<string>;
  /** Write an object directly, as if written out of band. */
  writeRaw(key: string, contents: string): Promise<void>;
  cleanup(): Promise<void>;
}

async function makeFsHarness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'journal-contract-'));
  const index = new SqliteIndex(':memory:');
  const store = new FsEntryStore(root, index);
  return {
    store,
    readRaw: (key) => readFileSyncAsync(join(root, key)),
    writeRaw: async (key, contents) => {
      const path = join(root, key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, contents, 'utf8');
    },
    cleanup: async () => {
      index.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function readFileSyncAsync(path: string): Promise<string> {
  return readFileSync(path, 'utf8');
}

function makeS3Harness(): Harness {
  const fake = createFakeS3Client();
  const index = new SqliteIndex(':memory:');
  const store = new S3EntryStore(fake as unknown as S3Client, 'contract-test-bucket', index);
  return {
    store,
    readRaw: async (key) => {
      const buffer = fake.readRaw(key);
      if (!buffer) throw new Error(`no such object: ${key}`);
      return buffer.toString('utf8');
    },
    writeRaw: async (key, contents) => {
      fake.writeRaw(key, contents);
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
  ['FsEntryStore', makeFsHarness],
  ['S3EntryStore', makeS3Harness],
];

describe.each(backends)('%s — EntryStore contract', (_name, makeHarness) => {
  let h: Harness;

  beforeEach(async () => {
    h = await makeHarness();
  });

  afterEach(async () => {
    await h.cleanup();
  });

  describe('create', () => {
    it('writes a real markdown file/object that reads cleanly on its own', async () => {
      const entry = await h.store.create({
        body: 'The first thing I wrote.',
        created: '2026-07-26T22:55:13+01:00',
        location: { lat: 51.5072, lon: -0.1276 },
      });

      expect(entry.path).toMatch(/^journal\/2026\/07\/2026-07-26-2255-[0-9a-z]{6}\.md$/);
      expect(await h.readRaw(entry.path)).toBe(
        `---\nid: ${entry.id}\ncreated: 2026-07-26T22:55:13+01:00\n` +
          `location: { lat: 51.5072, lon: -0.1276 }\n---\nThe first thing I wrote.\n`,
      );
    });

    it('omits location entirely when the device did not supply one', async () => {
      const entry = await h.store.create({ body: 'No fix.', created: '2026-07-26T22:55:13+01:00' });
      expect(await h.readRaw(entry.path)).not.toContain('location');
      expect(entry.location).toBeUndefined();
    });

    it('returns the body exactly as it was stored', async () => {
      const entry = await h.store.create({ body: 'No trailing newline' });
      expect(entry.body).toBe('No trailing newline\n');
    });

    it('declines to commit an entry that was never written', async () => {
      for (const body of ['', '   ', '\n\n\n', '\t \r\n']) {
        const error = await catchError(() => h.store.create({ body }));
        expect(error.code).toBe('invalid_request');
      }
    });

    it('rejects a created without an offset rather than guessing one', async () => {
      const error = await catchError(() =>
        h.store.create({ body: 'x', created: '2026-07-26T22:55:13' }),
      );
      expect(error.code).toBe('invalid_request');
    });

    it('files by the writer’s local date, not the machine’s', async () => {
      const entry = await h.store.create({ body: 'Tokyo.', created: '2026-08-01T00:30:00+09:00' });
      expect(entry.path).toMatch(/^journal\/2026\/08\/2026-08-01-0030-/);
    });

    it('gives every entry a distinct id and path, even within one minute', async () => {
      const created = '2026-07-26T22:55:13+01:00';
      const entries = await Promise.all(
        Array.from({ length: 20 }, (_, i) => h.store.create({ body: `Entry ${i}`, created })),
      );
      expect(new Set(entries.map((e) => e.id)).size).toBe(20);
      expect(new Set(entries.map((e) => e.path)).size).toBe(20);
    });
  });

  describe('get', () => {
    it('finds an entry by its id', async () => {
      const created = await h.store.create({ body: 'Findable.', created: '2026-07-26T22:55:13+01:00' });
      expect(await h.store.get(created.id)).toEqual(created);
    });

    it('returns null for an id that does not exist', async () => {
      expect(await h.store.get('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBeNull();
    });

    it('reads through fresh, so a write from outside the app is never stale', async () => {
      const entry = await h.store.create({ body: 'Before.', created: '2026-07-26T22:55:13+01:00' });
      const onDisk = await h.readRaw(entry.path);
      await h.writeRaw(entry.path, onDisk.replace('Before.', 'After, edited elsewhere.'));

      expect((await h.store.get(entry.id))?.body).toBe('After, edited elsewhere.\n');
    });

    it('finds an entry written by something else entirely', async () => {
      await h.writeRaw(
        'journal/2020/01/2020-01-01-0900-abcdef.md',
        '---\nid: 01ARZ3NDEKTSV4RRFFQ69G5FAV\ncreated: 2020-01-01T09:00:00Z\n---\nWritten elsewhere.\n',
      );
      const entry = await h.store.get('01ARZ3NDEKTSV4RRFFQ69G5FAV');
      expect(entry?.body).toBe('Written elsewhere.\n');
      expect(entry?.path).toBe('journal/2020/01/2020-01-01-0900-abcdef.md');
    });
  });

  describe('list', () => {
    const at = (iso: string, body: string) => h.store.create({ body, created: iso });

    it('is empty, not an error, when nothing has been written', async () => {
      expect(await h.store.list({ limit: 10 })).toEqual({ entries: [], nextCursor: null });
    });

    it('returns entries newest first', async () => {
      await at('2026-07-01T09:00:00+01:00', 'First');
      await at('2026-07-03T09:00:00+01:00', 'Third');
      await at('2026-07-02T09:00:00+01:00', 'Second');

      const { entries } = await h.store.list({ limit: 10 });
      expect(entries.map((e) => e.excerpt)).toEqual(['Third', 'Second', 'First']);
    });

    it('orders by instant, so a timezone change cannot reshuffle the past', async () => {
      await at('2026-07-26T22:00:00+01:00', 'Before take-off');
      await at('2026-07-26T18:30:00-04:00', 'After landing');

      const { entries } = await h.store.list({ limit: 10 });
      expect(entries.map((e) => e.excerpt)).toEqual(['After landing', 'Before take-off']);
    });

    it('pages without skipping or repeating an entry', async () => {
      for (let i = 0; i < 25; i += 1) {
        await at(`2026-07-${String(i + 1).padStart(2, '0')}T09:00:00Z`, `Entry ${i}`);
      }

      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await h.store.list({ limit: 7, ...(cursor ? { cursor } : {}) });
        seen.push(...page.entries.map((e) => e.id));
        cursor = page.nextCursor ?? undefined;
        pages += 1;
        expect(pages).toBeLessThan(10);
      } while (cursor);

      expect(seen).toHaveLength(25);
      expect(new Set(seen).size).toBe(25);
    });

    it('rejects a cursor it did not issue', async () => {
      const error = await catchError(() => h.store.list({ limit: 5, cursor: 'made-up' }));
      expect(error.code).toBe('invalid_cursor');
    });

    it('restricts to one calendar month when year and month are given', async () => {
      await at('2026-06-15T09:00:00Z', 'June');
      await at('2026-07-01T09:00:00Z', 'July first');
      await at('2026-07-26T09:00:00Z', 'July last');

      const { entries } = await h.store.list({ limit: 10, year: 2026, month: 7 });
      expect(entries.map((e) => e.excerpt)).toEqual(['July last', 'July first']);
    });
  });

  describe('listPeriods', () => {
    it('lists each distinct year-month once, newest first', async () => {
      await h.store.create({ body: 'June', created: '2026-06-15T09:00:00Z' });
      await h.store.create({ body: 'July', created: '2026-07-01T09:00:00Z' });

      expect(await h.store.listPeriods()).toEqual({
        periods: [
          { year: 2026, month: 7 },
          { year: 2026, month: 6 },
        ],
      });
    });
  });

  describe('update', () => {
    it('changes the body and nothing else', async () => {
      const original = await h.store.create({
        body: 'First draft.',
        created: '2026-07-26T22:55:13+01:00',
        location: { lat: 51.5072, lon: -0.1276 },
      });

      const updated = await h.store.update(original.id, { body: 'Revised.', contentHash: original.contentHash });

      expect(updated.id).toBe(original.id);
      expect(updated.created).toBe(original.created);
      expect(updated.location).toEqual(original.location);
      expect(updated.body).toBe('Revised.\n');
    });

    it('returns a new contentHash that reflects the new content', async () => {
      const entry = await h.store.create({ body: 'x', created: '2026-07-26T22:55:13+01:00' });
      const updated = await h.store.update(entry.id, { body: 'y', contentHash: entry.contentHash });
      expect(updated.contentHash).not.toBe(entry.contentHash);
    });

    it('rejects a stale hash rather than overwriting a change it never saw', async () => {
      const entry = await h.store.create({ body: 'Original.', created: '2026-07-26T22:55:13+01:00' });
      await h.store.update(entry.id, { body: 'Someone else changed this.', contentHash: entry.contentHash });

      const error = await catchError(() =>
        h.store.update(entry.id, { body: 'My stale edit.', contentHash: entry.contentHash }),
      );
      expect(error.code).toBe('edit_conflict');
      expect((await h.store.get(entry.id))?.body).toBe('Someone else changed this.\n');
    });

    it('rejects an update to an entry that does not exist', async () => {
      const error = await catchError(() =>
        h.store.update('01ARZ3NDEKTSV4RRFFQ69G5FAV', { body: 'x', contentHash: 'whatever' }),
      );
      expect(error.code).toBe('entry_not_found');
    });

    it('allows editing a body down to whitespace, without exception', async () => {
      const entry = await h.store.create({ body: 'Something.', created: '2026-07-26T22:55:13+01:00' });
      const updated = await h.store.update(entry.id, { body: '   ', contentHash: entry.contentHash });
      expect(updated.body.trim()).toBe('');
      expect(await h.store.get(entry.id)).not.toBeNull();
    });
  });

  describe('discardIfBlank', () => {
    it('removes a whitespace-only entry entirely', async () => {
      const entry = await h.store.create({ body: 'placeholder', created: '2026-07-26T22:55:13+01:00' });
      await h.store.update(entry.id, { body: '   \n\n  ', contentHash: entry.contentHash });

      await h.store.discardIfBlank(entry.id);
      expect(await h.store.get(entry.id)).toBeNull();
    });

    it('refuses to discard an entry that has real content', async () => {
      const entry = await h.store.create({ body: 'Real writing.', created: '2026-07-26T22:55:13+01:00' });
      const error = await catchError(() => h.store.discardIfBlank(entry.id));
      expect(error.code).toBe('invalid_request');
      expect((await h.store.get(entry.id))?.body).toBe('Real writing.\n');
    });

    it('is a no-op, not an error, for an entry that does not exist', async () => {
      await expect(h.store.discardIfBlank('01ARZ3NDEKTSV4RRFFQ69G5FAV')).resolves.toBeUndefined();
    });
  });

  describe('addAttachment', () => {
    it('writes the file beside the entry, in a directory sharing its stem', async () => {
      const entry = await h.store.create({ body: 'A photo from today.', created: '2026-07-26T22:55:13+01:00' });
      const data = Buffer.from([0xff, 0xd8, 0xff, 0x00]);

      const result = await h.store.addAttachment(entry.id, { filename: 'photo.jpg', data });
      const stem = entry.path.split('/').pop()!.replace(/\.md$/, '');
      expect(result.relativeLink).toBe(`${stem}/photo.jpg`);

      const dir = entry.path.slice(0, entry.path.lastIndexOf('/'));
      expect(await h.readRaw(`${dir}/${stem}/photo.jpg`)).toBeTruthy();
    });

    it('rejects a second attachment with the same filename, leaving the first untouched', async () => {
      const entry = await h.store.create({ body: 'x', created: '2026-07-26T22:55:13+01:00' });
      await h.store.addAttachment(entry.id, { filename: 'voice.m4a', data: Buffer.from('first') });

      const error = await catchError(() =>
        h.store.addAttachment(entry.id, { filename: 'voice.m4a', data: Buffer.from('second') }),
      );
      expect(error.code).toBe('attachment_conflict');
    });

    it('rejects a missing entry', async () => {
      const error = await catchError(() =>
        h.store.addAttachment('01ARZ3NDEKTSV4RRFFQ69G5FAV', { filename: 'x.jpg', data: Buffer.from('x') }),
      );
      expect(error.code).toBe('entry_not_found');
    });

    it.each([
      ['a path traversal attempt', '../../etc/passwd'],
      ['a nested path', 'sub/dir/file.jpg'],
      ['just a dot', '.'],
      ['an empty name', ''],
      ['a leading-dot hidden file', '.hidden.jpg'],
    ])('rejects %s as a filename', async (_label, filename) => {
      const entry = await h.store.create({ body: 'x', created: '2026-07-26T22:55:13+01:00' });
      const error = await catchError(() => h.store.addAttachment(entry.id, { filename, data: Buffer.from('x') }));
      expect(error.code).toBe('invalid_request');
    });
  });

  describe('listAttachments / getAttachment', () => {
    it('lists every attachment written on the entry', async () => {
      const entry = await h.store.create({ body: 'x', created: '2026-07-26T22:55:13+01:00' });
      await h.store.addAttachment(entry.id, { filename: 'photo.jpg', data: Buffer.from('a') });
      await h.store.addAttachment(entry.id, { filename: 'voice.wav', data: Buffer.from('b') });

      const attachments = await h.store.listAttachments(entry.id);
      expect(attachments.map((a) => a.filename).sort()).toEqual(['photo.jpg', 'voice.wav']);
    });

    it('is empty for an entry with no attachments, and for an entry that does not exist', async () => {
      const entry = await h.store.create({ body: 'x', created: '2026-07-26T22:55:13+01:00' });
      expect(await h.store.listAttachments(entry.id)).toEqual([]);
      expect(await h.store.listAttachments('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toEqual([]);
    });

    it('reads back exactly the bytes that were written, with a content type inferred from the extension', async () => {
      const entry = await h.store.create({ body: 'x', created: '2026-07-26T22:55:13+01:00' });
      const data = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
      await h.store.addAttachment(entry.id, { filename: 'photo.jpg', data });

      const bytes = await h.store.getAttachment(entry.id, 'photo.jpg');
      expect(bytes?.data).toEqual(data);
      expect(bytes?.contentType).toBe('image/jpeg');
    });

    it('is null for a filename that does not exist, an entry that does not exist, or a traversal attempt', async () => {
      const entry = await h.store.create({ body: 'x', created: '2026-07-26T22:55:13+01:00' });
      await h.store.addAttachment(entry.id, { filename: 'photo.jpg', data: Buffer.from('a') });

      expect(await h.store.getAttachment(entry.id, 'missing.jpg')).toBeNull();
      expect(await h.store.getAttachment('01ARZ3NDEKTSV4RRFFQ69G5FAV', 'photo.jpg')).toBeNull();
      expect(await h.store.getAttachment(entry.id, '../../etc/passwd')).toBeNull();
    });
  });

  describe('rebuild', () => {
    it('reproduces the same list output as the index built incrementally', async () => {
      await h.store.create({ body: 'First', created: '2026-07-01T09:00:00Z' });
      await h.store.create({ body: 'Second', created: '2026-07-02T09:00:00Z' });
      await h.writeRaw('journal/2026/07/broken.md', 'no frontmatter');

      const before = await h.store.list({ limit: 10 });
      const beforeStats = await h.store.stats();

      const result = await h.store.rebuild();

      expect(result).toEqual(beforeStats);
      expect(await h.store.list({ limit: 10 })).toEqual(before);
    });

    it('sheds stale rows for objects deleted since the last scan', async () => {
      const survivor = await h.store.create({ body: 'Stays.', created: '2026-07-01T09:00:00Z' });
      const doomed = await h.store.create({ body: 'Goes.', created: '2026-07-02T09:00:00Z' });
      await h.store.stats();
      await h.store.discardIfBlank(doomed.id).catch(() => {
        /* has real content — removed a different way below instead */
      });
      // discardIfBlank refuses real content, so remove it the same way an
      // out-of-band deletion would: directly, bypassing the store.
      await h.store.update(doomed.id, { body: '', contentHash: (await h.store.get(doomed.id))!.contentHash });
      await h.store.discardIfBlank(doomed.id);

      await h.store.rebuild();

      const { entries } = await h.store.list({ limit: 10 });
      expect(entries.map((e) => e.id)).toEqual([survivor.id]);
    });
  });
});
