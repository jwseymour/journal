import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../../src/errors.js';
import { FsEntryStore } from '../../src/store/fs-entry-store.js';

let root: string;
let store: FsEntryStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'journal-test-'));
  store = new FsEntryStore(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const read = (relPath: string) => readFile(join(root, relPath), 'utf8');

async function catchError(fn: () => Promise<unknown>): Promise<AppError> {
  try {
    await fn();
  } catch (error) {
    return error as AppError;
  }
  throw new Error('expected a failure');
}

describe('create', () => {
  it('writes a real markdown file that reads cleanly on its own', async () => {
    const entry = await store.create({
      body: 'The first thing I wrote.',
      created: '2026-07-26T22:55:13+01:00',
      location: { lat: 51.5072, lon: -0.1276 },
    });

    expect(entry.path).toMatch(/^journal\/2026\/07\/2026-07-26-2255-[0-9a-z]{6}\.md$/);
    expect(await read(entry.path)).toBe(
      `---\nid: ${entry.id}\ncreated: 2026-07-26T22:55:13+01:00\n` +
        `location: { lat: 51.5072, lon: -0.1276 }\n---\nThe first thing I wrote.\n`,
    );
  });

  it('omits location entirely when the device did not supply one', async () => {
    const entry = await store.create({ body: 'No fix.', created: '2026-07-26T22:55:13+01:00' });
    expect(await read(entry.path)).not.toContain('location');
    expect(entry.location).toBeUndefined();
  });

  it('falls back to this machine’s clock only when created is omitted', async () => {
    const entry = await store.create({ body: 'From curl.' });
    expect(entry.created).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/);
  });

  it('returns the body exactly as it was stored', async () => {
    const entry = await store.create({ body: 'No trailing newline' });
    expect(entry.body).toBe('No trailing newline\n');
    expect(await read(entry.path)).toMatch(/---\nNo trailing newline\n$/);
  });

  it('declines to commit an entry that was never written', async () => {
    for (const body of ['', '   ', '\n\n\n', '\t \r\n']) {
      const error = await catchError(() => store.create({ body }));
      expect(error.code).toBe('invalid_request');
    }
    await expect(readdir(root)).resolves.toEqual([]);
  });

  it('rejects a created without an offset rather than guessing one', async () => {
    const error = await catchError(() =>
      store.create({ body: 'x', created: '2026-07-26T22:55:13' }),
    );
    expect(error.code).toBe('invalid_request');
    expect(error.message).toContain('UTC offset');
  });

  it('files by the writer’s local date, not the machine’s', async () => {
    const entry = await store.create({ body: 'Tokyo.', created: '2026-08-01T00:30:00+09:00' });
    expect(entry.path).toMatch(/^journal\/2026\/08\/2026-08-01-0030-/);
  });

  it('leaves no temporary file behind', async () => {
    const entry = await store.create({ body: 'x', created: '2026-07-26T22:55:13+01:00' });
    const dir = join(root, 'journal/2026/07');
    const names = await readdir(dir);
    expect(names).toEqual([entry.path.split('/').pop()]);
    expect(names.some((n) => n.endsWith('.tmp'))).toBe(false);
  });

  it('gives every entry a distinct id and file, even within one minute', async () => {
    const created = '2026-07-26T22:55:13+01:00';
    const entries = await Promise.all(
      Array.from({ length: 40 }, (_, i) => store.create({ body: `Entry ${i}`, created })),
    );
    expect(new Set(entries.map((e) => e.id)).size).toBe(40);
    expect(new Set(entries.map((e) => e.path)).size).toBe(40);
    expect((await readdir(join(root, 'journal/2026/07'))).length).toBe(40);
  });
});

describe('get', () => {
  it('finds an entry by its id', async () => {
    const created = await store.create({ body: 'Findable.', created: '2026-07-26T22:55:13+01:00' });
    const fetched = await store.get(created.id);
    expect(fetched).toEqual(created);
  });

  it('returns null for an id that does not exist', async () => {
    expect(await store.get('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBeNull();
  });

  it('reads through to disk, so an entry edited in a text editor is never stale', async () => {
    const entry = await store.create({ body: 'Before.', created: '2026-07-26T22:55:13+01:00' });
    const onDisk = await read(entry.path);
    await writeFile(join(root, entry.path), onDisk.replace('Before.', 'After, edited by hand.'));

    expect((await store.get(entry.id))?.body).toBe('After, edited by hand.\n');
  });

  it('notices an entry that has been deleted from underneath it', async () => {
    const entry = await store.create({ body: 'Doomed.', created: '2026-07-26T22:55:13+01:00' });
    await rm(join(root, entry.path));
    expect(await store.get(entry.id)).toBeNull();
  });

  it('finds an entry written into the directory by something else entirely', async () => {
    await mkdir(join(root, 'journal/2020/01'), { recursive: true });
    await writeFile(
      join(root, 'journal/2020/01/2020-01-01-0900-abcdef.md'),
      '---\nid: 01ARZ3NDEKTSV4RRFFQ69G5FAV\ncreated: 2020-01-01T09:00:00Z\n---\nWritten in vim.\n',
    );
    const entry = await store.get('01ARZ3NDEKTSV4RRFFQ69G5FAV');
    expect(entry?.body).toBe('Written in vim.\n');
    expect(entry?.path).toBe('journal/2020/01/2020-01-01-0900-abcdef.md');
  });

  it('finds an entry whose file has been renamed, because identity is not the filename', async () => {
    const entry = await store.create({ body: 'Renamed.', created: '2026-07-26T22:55:13+01:00' });
    const contents = await read(entry.path);
    await rm(join(root, entry.path));
    await writeFile(join(root, 'journal/2026/07/something-else-entirely.md'), contents);

    const found = await store.get(entry.id);
    expect(found?.body).toBe('Renamed.\n');
    expect(found?.path).toBe('journal/2026/07/something-else-entirely.md');
  });
});

describe('list', () => {
  const at = (iso: string, body: string) => store.create({ body, created: iso });

  it('is empty, not an error, when nothing has been written', async () => {
    expect(await store.list({ limit: 10 })).toEqual({ entries: [], nextCursor: null });
  });

  it('returns entries newest first', async () => {
    await at('2026-07-01T09:00:00+01:00', 'First');
    await at('2026-07-03T09:00:00+01:00', 'Third');
    await at('2026-07-02T09:00:00+01:00', 'Second');

    const { entries } = await store.list({ limit: 10 });
    expect(entries.map((e) => e.excerpt)).toEqual(['Third', 'Second', 'First']);
  });

  it('orders by instant, so a timezone change cannot reshuffle the past', async () => {
    // Written 30 minutes apart while flying west; the later entry has an
    // earlier-looking local time and an earlier-sorting filename.
    await at('2026-07-26T22:00:00+01:00', 'Before take-off');
    await at('2026-07-26T18:30:00-04:00', 'After landing');

    const { entries } = await store.list({ limit: 10 });
    expect(entries.map((e) => e.excerpt)).toEqual(['After landing', 'Before take-off']);
  });

  it('carries an excerpt, cut on this side of the boundary', async () => {
    await at('2026-07-01T09:00:00Z', `${'word '.repeat(200)}`);
    const [entry] = (await store.list({ limit: 1 })).entries;
    expect(entry!.excerpt).toMatch(/…$/);
    expect(entry!.excerpt.length).toBeLessThan(250);
  });

  it('pages without skipping or repeating an entry', async () => {
    for (let i = 0; i < 25; i += 1) {
      await at(`2026-07-${String(i + 1).padStart(2, '0')}T09:00:00Z`, `Entry ${i}`);
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await store.list({ limit: 7, ...(cursor ? { cursor } : {}) });
      seen.push(...page.entries.map((e) => e.id));
      cursor = page.nextCursor ?? undefined;
      pages += 1;
      expect(pages).toBeLessThan(10);
    } while (cursor);

    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
    expect(pages).toBe(4);
  });

  it('does not repeat an entry when one is written between pages', async () => {
    for (let i = 0; i < 6; i += 1) {
      await at(`2026-07-0${i + 1}T09:00:00Z`, `Entry ${i}`);
    }
    const first = await store.list({ limit: 3 });
    await at('2026-08-01T09:00:00Z', 'Written between pages');
    const second = await store.list({ limit: 3, cursor: first.nextCursor! });

    const ids = [...first.entries, ...second.entries].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(second.entries.map((e) => e.excerpt)).toEqual(['Entry 2', 'Entry 1', 'Entry 0']);
  });

  it('rejects a cursor it did not issue', async () => {
    const error = await catchError(() => store.list({ limit: 5, cursor: 'made-up' }));
    expect(error.code).toBe('invalid_cursor');
  });
});

describe('tolerating a directory that is edited by hand', () => {
  it('skips an unreadable file rather than losing the rest of the journal', async () => {
    const good = await store.create({ body: 'Intact.', created: '2026-07-26T22:55:13+01:00' });
    await writeFile(join(root, 'journal/2026/07/broken.md'), 'This has no frontmatter at all.\n');
    await writeFile(join(root, 'journal/2026/07/half.md'), '---\nid: nonsense\n');

    const { entries } = await store.list({ limit: 10 });
    expect(entries.map((e) => e.id)).toEqual([good.id]);
    expect(await store.stats()).toEqual({ entryCount: 1, unreadableCount: 2 });
  });

  it('ignores files that are not entries, and directories that are not ours', async () => {
    await store.create({ body: 'Real.', created: '2026-07-26T22:55:13+01:00' });
    await mkdir(join(root, '.git/objects'), { recursive: true });
    await writeFile(join(root, '.git/objects/pack.md'), 'not an entry');
    await mkdir(join(root, 'journal/2026/07/2026-07-26-2255-abcdef'), { recursive: true });
    await writeFile(join(root, 'journal/2026/07/2026-07-26-2255-abcdef/photo.jpg'), 'binary');
    await writeFile(join(root, 'journal/notes.txt'), 'not an entry');

    expect(await store.stats()).toEqual({ entryCount: 1, unreadableCount: 0 });
  });

  it('keeps exactly one of two files claiming the same id, deterministically', async () => {
    const entry = await store.create({ body: 'Original.', created: '2026-07-26T22:55:13+01:00' });
    const contents = await read(entry.path);
    await writeFile(join(root, 'journal/2026/07/0000-copy.md'), contents);

    const first = await store.list({ limit: 10 });
    expect(first.entries).toHaveLength(1);
    // The lexically first path wins, so restarts agree with each other.
    expect((await store.get(entry.id))?.path).toBe('journal/2026/07/0000-copy.md');
    expect((await store.stats()).unreadableCount).toBe(1);
  });

  it('notices entries appearing and vanishing between calls', async () => {
    expect((await store.stats()).entryCount).toBe(0);

    await mkdir(join(root, 'journal/2020/01'), { recursive: true });
    const path = join(root, 'journal/2020/01/2020-01-01-0900-abcdef.md');
    await writeFile(
      path,
      '---\nid: 01ARZ3NDEKTSV4RRFFQ69G5FAV\ncreated: 2020-01-01T09:00:00Z\n---\nHere.\n',
    );
    expect((await store.stats()).entryCount).toBe(1);

    await rm(path);
    expect((await store.stats()).entryCount).toBe(0);
  });

  it('reads entries filed somewhere other than YYYY/MM', async () => {
    await mkdir(join(root, 'journal/old-stuff/imported'), { recursive: true });
    await writeFile(
      join(root, 'journal/old-stuff/imported/whatever.md'),
      '---\nid: 01ARZ3NDEKTSV4RRFFQ69G5FAV\ncreated: 2020-01-01T09:00:00Z\n---\nMoved by hand.\n',
    );
    expect((await store.get('01ARZ3NDEKTSV4RRFFQ69G5FAV'))?.body).toBe('Moved by hand.\n');
  });
});

describe('what the store must never do', () => {
  it('does not create the journal directory itself', async () => {
    const missing = join(root, 'does-not-exist');
    const orphan = new FsEntryStore(missing);
    expect(await orphan.list({ limit: 10 })).toEqual({ entries: [], nextCursor: null });
    await expect(readdir(missing)).rejects.toThrow();
  });

  it('never modifies an entry once written', async () => {
    const entry = await store.create({ body: 'Untouched.', created: '2026-07-26T22:55:13+01:00' });
    const before = await read(entry.path);

    await store.get(entry.id);
    await store.list({ limit: 10 });
    await store.stats();
    await store.create({ body: 'Another.', created: '2026-07-27T10:00:00+01:00' });

    expect(await read(entry.path)).toBe(before);
  });
});

describe('update', () => {
  it('changes the body and nothing else', async () => {
    const original = await store.create({
      body: 'First draft.',
      created: '2026-07-26T22:55:13+01:00',
      location: { lat: 51.5072, lon: -0.1276 },
    });

    const updated = await store.update(original.id, {
      body: 'Revised.',
      contentHash: original.contentHash,
    });

    expect(updated.id).toBe(original.id);
    expect(updated.created).toBe(original.created);
    expect(updated.location).toEqual(original.location);
    expect(updated.body).toBe('Revised.\n');
    // The file itself agrees — id, created and location untouched on disk.
    expect(await read(original.path)).toBe(
      `---\nid: ${original.id}\ncreated: 2026-07-26T22:55:13+01:00\n` +
        `location: { lat: 51.5072, lon: -0.1276 }\n---\nRevised.\n`,
    );
  });

  it('never renames or moves the file', async () => {
    const entry = await store.create({ body: 'x', created: '2026-07-26T22:55:13+01:00' });
    await store.update(entry.id, { body: 'y', contentHash: entry.contentHash });
    // Reading it back by id still resolves to the same path.
    const found = await store.get(entry.id);
    expect(found?.path).toBe(entry.path);
  });

  it('returns a new contentHash that reflects the new content', async () => {
    const entry = await store.create({ body: 'x', created: '2026-07-26T22:55:13+01:00' });
    const updated = await store.update(entry.id, { body: 'y', contentHash: entry.contentHash });
    expect(updated.contentHash).not.toBe(entry.contentHash);

    const reFetched = await store.get(entry.id);
    expect(reFetched?.contentHash).toBe(updated.contentHash);
  });

  it('rejects a stale hash rather than overwriting a change it never saw', async () => {
    const entry = await store.create({ body: 'Original.', created: '2026-07-26T22:55:13+01:00' });
    // Someone else's write lands first.
    await store.update(entry.id, { body: 'Someone else changed this.', contentHash: entry.contentHash });

    const error = await catchError(() =>
      store.update(entry.id, { body: 'My stale edit.', contentHash: entry.contentHash }),
    );
    expect(error.code).toBe('edit_conflict');

    // The other write is untouched — nothing was overwritten.
    expect((await store.get(entry.id))?.body).toBe('Someone else changed this.\n');
  });

  it('rejects a stale hash when the file was edited by hand, outside the app', async () => {
    const entry = await store.create({ body: 'Original.', created: '2026-07-26T22:55:13+01:00' });
    const onDisk = await read(entry.path);
    await writeFile(join(root, entry.path), onDisk.replace('Original.', 'Edited in vim.'));

    const error = await catchError(() =>
      store.update(entry.id, { body: 'My edit, based on stale content.', contentHash: entry.contentHash }),
    );
    expect(error.code).toBe('edit_conflict');
    expect((await store.get(entry.id))?.body).toBe('Edited in vim.\n');
  });

  it('rejects an update to an entry that does not exist', async () => {
    const error = await catchError(() =>
      store.update('01ARZ3NDEKTSV4RRFFQ69G5FAV', { body: 'x', contentHash: 'whatever' }),
    );
    expect(error.code).toBe('entry_not_found');
  });

  it('rejects an update to an entry deleted from underneath it', async () => {
    const entry = await store.create({ body: 'x', created: '2026-07-26T22:55:13+01:00' });
    await rm(join(root, entry.path));

    const error = await catchError(() =>
      store.update(entry.id, { body: 'y', contentHash: entry.contentHash }),
    );
    expect(error.code).toBe('entry_not_found');
  });

  it('allows editing a body down to whitespace — editing is allowed, without exception', async () => {
    const entry = await store.create({ body: 'Something.', created: '2026-07-26T22:55:13+01:00' });
    const updated = await store.update(entry.id, { body: '   ', contentHash: entry.contentHash });
    expect(updated.body.trim()).toBe('');
    // The entry still exists — editing to blank is not the same as discarding.
    expect(await store.get(entry.id)).not.toBeNull();
  });

  it('is atomic: the file is never left truncated or half-written', async () => {
    const entry = await store.create({ body: 'Original content.', created: '2026-07-26T22:55:13+01:00' });
    await store.update(entry.id, { body: 'Updated content.', contentHash: entry.contentHash });

    const dir = join(root, 'journal/2026/07');
    const names = await readdir(dir);
    expect(names.some((n) => n.endsWith('.tmp'))).toBe(false);
  });
});

describe('discardIfBlank', () => {
  it('removes a whitespace-only entry entirely', async () => {
    const entry = await store.create({ body: 'placeholder', created: '2026-07-26T22:55:13+01:00' });
    await store.update(entry.id, { body: '   \n\n  ', contentHash: entry.contentHash });

    await store.discardIfBlank(entry.id);

    expect(await store.get(entry.id)).toBeNull();
    await expect(read(entry.path)).rejects.toThrow();
  });

  it('refuses to discard an entry that has real content', async () => {
    const entry = await store.create({ body: 'Real writing.', created: '2026-07-26T22:55:13+01:00' });

    const error = await catchError(() => store.discardIfBlank(entry.id));
    expect(error.code).toBe('invalid_request');
    // Refused, not silently ignored: the entry is untouched.
    expect((await store.get(entry.id))?.body).toBe('Real writing.\n');
  });

  it('is a no-op, not an error, for an entry that does not exist', async () => {
    await expect(store.discardIfBlank('01ARZ3NDEKTSV4RRFFQ69G5FAV')).resolves.toBeUndefined();
  });

  it('is a no-op for an entry already discarded', async () => {
    const entry = await store.create({ body: 'placeholder', created: '2026-07-26T22:55:13+01:00' });
    await store.update(entry.id, { body: ' ', contentHash: entry.contentHash });
    await store.discardIfBlank(entry.id);

    await expect(store.discardIfBlank(entry.id)).resolves.toBeUndefined();
  });

  it('leaves other entries in the list untouched', async () => {
    const keep = await store.create({ body: 'Keep me.', created: '2026-07-26T09:00:00+01:00' });
    const discard = await store.create({ body: 'placeholder', created: '2026-07-26T10:00:00+01:00' });
    await store.update(discard.id, { body: '', contentHash: discard.contentHash });

    await store.discardIfBlank(discard.id);

    const { entries } = await store.list({ limit: 10 });
    expect(entries.map((e) => e.id)).toEqual([keep.id]);
  });
});
