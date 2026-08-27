import type { S3Client } from '@aws-sdk/client-s3';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../../src/errors.js';
import { DocumentsIndex } from '../../src/index/documents-index.js';
import type { DocumentStore, DocumentStoreStats } from '../../src/store/document-store.js';
import { FsDocumentStore } from '../../src/store/fs-document-store.js';
import { S3DocumentStore } from '../../src/store/s3-document-store.js';
import { createFakeS3Client } from './fake-s3-client.js';

/**
 * The `DocumentStore` contract, run against both implementations
 * (`requirements.md` §9, `plan.md` M12) — mirrors
 * `entry-store-contract.test.ts` exactly in shape and reasoning.
 *
 * Ordering is deliberately *not* asserted here beyond "every document that
 * was created is present, exactly once, across however many pages it
 * takes." `DocumentStore.create`/`update` never accept a client-supplied
 * timestamp the way entries do, so two calls made back to back in a fast
 * in-memory test can legitimately land in the same millisecond — the exact
 * newest-updated-first tie-break is already proven deterministically,
 * with controlled inputs, in `documents-index.test.ts`.
 */

interface Harness {
  readonly store: DocumentStore & { rebuild(): Promise<DocumentStoreStats> };
  readRaw(key: string): Promise<string>;
  writeRaw(key: string, contents: string): Promise<void>;
  cleanup(): Promise<void>;
}

async function makeFsHarness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'journal-doc-contract-'));
  const index = new DocumentsIndex(':memory:');
  const store = new FsDocumentStore(root, index);
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
  const index = new DocumentsIndex(':memory:');
  const store = new S3DocumentStore(fake as unknown as S3Client, 'contract-test-bucket', index);
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
  ['FsDocumentStore', makeFsHarness],
  ['S3DocumentStore', makeS3Harness],
];

describe.each(backends)('%s — DocumentStore contract', (_name, makeHarness) => {
  let h: Harness;

  beforeEach(async () => {
    h = await makeHarness();
  });

  afterEach(async () => {
    await h.cleanup();
  });

  describe('create', () => {
    it('writes a real markdown file/object that reads cleanly on its own', async () => {
      const document = await h.store.create({ title: 'The greenhouse project', body: 'Notes so far.' });

      expect(document.path).toBe(`documents/${document.id}.md`);
      expect(await h.readRaw(document.path)).toBe(
        `---\nid: ${document.id}\ntitle: The greenhouse project\ncreated: ${document.created}\n` +
          `updated: ${document.created}\n---\nNotes so far.\n`,
      );
    });

    it('returns the body exactly as it was stored', async () => {
      const document = await h.store.create({ title: 'x', body: 'No trailing newline' });
      expect(document.body).toBe('No trailing newline\n');
    });

    it('declines to create a document with no title', async () => {
      for (const title of ['', '   ']) {
        const error = await catchError(() => h.store.create({ title, body: 'x' }));
        expect(error.code).toBe('invalid_request');
      }
    });

    it('stores citedEntries and omits the key entirely when absent', async () => {
      const withCitations = await h.store.create({
        title: 'x',
        body: 'x',
        citedEntries: ['01ARZ3NDEKTSV4RRFFQ69G5FAV'],
      });
      expect(withCitations.citedEntries).toEqual(['01ARZ3NDEKTSV4RRFFQ69G5FAV']);

      const without = await h.store.create({ title: 'y', body: 'y' });
      expect(without.citedEntries).toBeUndefined();
      expect(await h.readRaw(without.path)).not.toContain('citedEntries');
    });

    it('gives every document a distinct id and path, even created concurrently', async () => {
      const documents = await Promise.all(
        Array.from({ length: 20 }, (_, i) => h.store.create({ title: `Doc ${i}`, body: `Body ${i}` })),
      );
      expect(new Set(documents.map((d) => d.id)).size).toBe(20);
      expect(new Set(documents.map((d) => d.path)).size).toBe(20);
    });
  });

  describe('get', () => {
    it('finds a document by its id', async () => {
      const created = await h.store.create({ title: 'Findable', body: 'x' });
      expect(await h.store.get(created.id)).toEqual(created);
    });

    it('returns null for an id that does not exist', async () => {
      expect(await h.store.get('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBeNull();
    });

    it('reads through fresh, so a write from outside the app is never stale', async () => {
      const document = await h.store.create({ title: 'x', body: 'Before.' });
      const onDisk = await h.readRaw(document.path);
      await h.writeRaw(document.path, onDisk.replace('Before.', 'After, edited elsewhere.'));

      expect((await h.store.get(document.id))?.body).toBe('After, edited elsewhere.\n');
    });

    it('finds a document written by something else entirely', async () => {
      await h.writeRaw(
        'documents/01ARZ3NDEKTSV4RRFFQ69G5FAV.md',
        '---\nid: 01ARZ3NDEKTSV4RRFFQ69G5FAV\ntitle: External\ncreated: 2020-01-01T09:00:00Z\nupdated: 2020-01-01T09:00:00Z\n---\nWritten elsewhere.\n',
      );
      const document = await h.store.get('01ARZ3NDEKTSV4RRFFQ69G5FAV');
      expect(document?.body).toBe('Written elsewhere.\n');
      expect(document?.title).toBe('External');
    });
  });

  describe('list', () => {
    it('is empty, not an error, when nothing has been written', async () => {
      expect(await h.store.list({ limit: 10 })).toEqual({ documents: [], nextCursor: null });
    });

    it('returns every created document exactly once, across however many pages it takes', async () => {
      const created = await Promise.all(
        Array.from({ length: 25 }, (_, i) => h.store.create({ title: `Doc ${i}`, body: `Body ${i}` })),
      );

      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await h.store.list({ limit: 7, ...(cursor ? { cursor } : {}) });
        seen.push(...page.documents.map((d) => d.id));
        cursor = page.nextCursor ?? undefined;
        pages += 1;
        expect(pages).toBeLessThan(10);
      } while (cursor);

      expect(seen).toHaveLength(25);
      expect(new Set(seen)).toEqual(new Set(created.map((d) => d.id)));
    });

    it('rejects a cursor it did not issue', async () => {
      const error = await catchError(() => h.store.list({ limit: 5, cursor: 'made-up' }));
      expect(error.code).toBe('invalid_cursor');
    });
  });

  describe('update', () => {
    it('replaces title, body and citedEntries; id and created never move', async () => {
      const original = await h.store.create({ title: 'Draft title', body: 'First draft.' });

      const updated = await h.store.update(original.id, {
        title: 'Final title',
        body: 'Revised.',
        citedEntries: ['01ARZ3NDEKTSV4RRFFQ69G5FAV'],
        contentHash: original.contentHash,
      });

      expect(updated.id).toBe(original.id);
      expect(updated.created).toBe(original.created);
      expect(updated.title).toBe('Final title');
      expect(updated.body).toBe('Revised.\n');
      expect(updated.citedEntries).toEqual(['01ARZ3NDEKTSV4RRFFQ69G5FAV']);
    });

    it('advances updated, and returns a new contentHash', async () => {
      const document = await h.store.create({ title: 'x', body: 'x' });
      const updated = await h.store.update(document.id, {
        title: 'x',
        body: 'y',
        contentHash: document.contentHash,
      });
      expect(updated.contentHash).not.toBe(document.contentHash);
    });

    it('rejects a stale hash rather than overwriting a change it never saw', async () => {
      const document = await h.store.create({ title: 'x', body: 'Original.' });
      await h.store.update(document.id, {
        title: 'x',
        body: 'Someone else changed this.',
        contentHash: document.contentHash,
      });

      const error = await catchError(() =>
        h.store.update(document.id, { title: 'x', body: 'My stale edit.', contentHash: document.contentHash }),
      );
      expect(error.code).toBe('edit_conflict');
      expect((await h.store.get(document.id))?.body).toBe('Someone else changed this.\n');
    });

    it('rejects an update to a document that does not exist', async () => {
      const error = await catchError(() =>
        h.store.update('01ARZ3NDEKTSV4RRFFQ69G5FAV', { title: 'x', body: 'x', contentHash: 'whatever' }),
      );
      expect(error.code).toBe('record_not_found');
    });

    it('rejects an update that would leave the document with no title', async () => {
      const document = await h.store.create({ title: 'x', body: 'x' });
      const error = await catchError(() =>
        h.store.update(document.id, { title: '  ', body: 'x', contentHash: document.contentHash }),
      );
      expect(error.code).toBe('invalid_request');
    });
  });

  describe('rebuild', () => {
    it('reproduces the same stats and list contents as the index built incrementally', async () => {
      await h.store.create({ title: 'First', body: 'First body.' });
      await h.store.create({ title: 'Second', body: 'Second body.' });
      await h.writeRaw('documents/broken.md', 'no frontmatter');

      const beforeStats = await h.store.stats();
      const { documents: before } = await h.store.list({ limit: 10 });

      const result = await h.store.rebuild();

      expect(result).toEqual(beforeStats);
      const { documents: after } = await h.store.list({ limit: 10 });
      expect(new Set(after.map((d) => d.id))).toEqual(new Set(before.map((d) => d.id)));
    });
  });
});
