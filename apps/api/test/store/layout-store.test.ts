import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../../src/config.js';
import { LayoutsIndex } from '../../src/index/layouts-index.js';
import { legacyPrefsToSyntax } from '../../src/layout/legacy-prefs.js';
import { createLayoutStore } from '../../src/store/create-layout-store.js';
import { DurableLayoutStore, type LayoutBlobStore } from '../../src/store/layout-store.js';

/** The `derived/layouts/` durable store with no real filesystem. */
class MemoryBlobStore implements LayoutBlobStore {
  files = new Map<string, string>();
  async put(key: string, body: string) {
    this.files.set(key, body);
  }
  async get(key: string) {
    return this.files.get(key) ?? null;
  }
  async delete(key: string) {
    this.files.delete(key);
  }
  async listKeys(prefix: string) {
    return [...this.files.keys()].filter((k) => k.startsWith(prefix));
  }
}

let blobs: MemoryBlobStore;
let index: LayoutsIndex;
let store: DurableLayoutStore;

beforeEach(() => {
  blobs = new MemoryBlobStore();
  index = new LayoutsIndex(':memory:');
  store = new DurableLayoutStore(blobs, index);
});

afterEach(() => index.close());

const simple = (name: string, section = 'S', panel = 'todos') =>
  `layout "x"\n\nsection "${section}"\n  panel ${panel}\n`;

describe('DurableLayoutStore', () => {
  it('create: forces the request name into the DSL, canonicalises, first is default', async () => {
    const layout = await store.create({ surface: 'analysis', name: 'My board', syntax: simple('My board') });
    expect(layout.name).toBe('My board');
    expect(layout.syntax).toBe('layout "My board"\n\nsection "S"\n  panel todos\n');
    expect(layout.isDefault).toBe(true);
    expect(layout.spec.sections[0]?.panels[0]?.view).toBe('todos');
    // Two durable objects, git-diff friendly.
    expect(blobs.files.has(`derived/layouts/${layout.id}.dsl`)).toBe(true);
    expect(blobs.files.has(`derived/layouts/${layout.id}.meta.json`)).toBe(true);
  });

  it('create: the second layout for a surface is not default', async () => {
    await store.create({ surface: 'analysis', name: 'first', syntax: simple('first') });
    const second = await store.create({ surface: 'analysis', name: 'second', syntax: simple('second') });
    expect(second.isDefault).toBe(false);
  });

  it('update: rejects a stale expectedUpdatedAt, accepts the current one', async () => {
    const layout = await store.create({ surface: 'analysis', name: 'a', syntax: simple('a') });
    expect(await store.update(layout.id, { syntax: simple('a', 'Renamed') }, 'nonsense')).toBeNull();

    const updated = await store.update(layout.id, { syntax: 'layout "Renamed"\n\nsection "T"\n  panel lists\n' }, layout.updatedAt);
    expect(updated).not.toBeNull();
    expect(updated!.name).toBe('Renamed');
    expect(updated!.spec.sections[0]?.panels[0]?.view).toBe('lists');
    expect(updated!.isDefault).toBe(true); // default pointer survives an edit
  });

  it('setDefault: moves the pointer and clears the previous holder', async () => {
    const a = await store.create({ surface: 'analysis', name: 'a', syntax: simple('a') });
    const b = await store.create({ surface: 'analysis', name: 'b', syntax: simple('b') });
    expect((await store.list('analysis')).defaultId).toBe(a.id);

    await store.setDefault('analysis', b.id);
    const { layouts, defaultId } = await store.list('analysis');
    expect(defaultId).toBe(b.id);
    expect(layouts.filter((l) => l.isDefault).map((l) => l.id)).toEqual([b.id]);
  });

  it('remove: promotes the most-recently-updated survivor when the default goes', async () => {
    const a = await store.create({ surface: 'analysis', name: 'a', syntax: simple('a') });
    const b = await store.create({ surface: 'analysis', name: 'b', syntax: simple('b') });
    await store.setDefault('analysis', a.id);

    await store.remove(a.id);
    const { layouts, defaultId } = await store.list('analysis');
    expect(layouts.map((l) => l.id)).toEqual([b.id]);
    expect(defaultId).toBe(b.id);
    expect(blobs.files.has(`derived/layouts/${a.id}.dsl`)).toBe(false);
  });

  it('remove: a tolerant no-op for an id that does not exist', async () => {
    await expect(store.remove('01ARZ3NDEKTSV4RRFFQ69G5FAV')).resolves.toBeUndefined();
  });

  it('the mirror/rebuild drill: rm the index, rebuild from durable, everything survives', async () => {
    const a = await store.create({ surface: 'analysis', name: 'Rhythm first', syntax: simple('a', 'One', 'presence') });
    const b = await store.create({ surface: 'analysis', name: 'Threads first', syntax: simple('b', 'Two', 'questions') });
    await store.setDefault('analysis', b.id);

    // Drop the disposable projection entirely, like `rm index.db && rebuild`.
    index.close();
    const freshIndex = new LayoutsIndex(':memory:');
    const rebuilt = new DurableLayoutStore(blobs, freshIndex);
    const { layoutCount } = await rebuilt.rebuild();
    expect(layoutCount).toBe(2);

    const { layouts, defaultId } = await rebuilt.list('analysis');
    expect(new Set(layouts.map((l) => l.name))).toEqual(new Set(['Rhythm first', 'Threads first']));
    expect(defaultId).toBe(b.id);
    expect((await rebuilt.get(a.id))!.syntax).toBe(a.syntax);
    freshIndex.close();
    index = freshIndex; // so afterEach close() is a harmless double-close guard
  });

  it('self-heals a cold projection on first read without an explicit rebuild', async () => {
    const a = await store.create({ surface: 'analysis', name: 'a', syntax: simple('a') });

    index.close();
    const freshIndex = new LayoutsIndex(':memory:');
    const cold = new DurableLayoutStore(blobs, freshIndex);
    // No rebuild() call — list() should notice the empty projection and heal.
    const { layouts } = await cold.list('analysis');
    expect(layouts.map((l) => l.id)).toEqual([a.id]);
    freshIndex.close();
    index = freshIndex;
  });
});

describe('createLayoutStore on the fs backend (the one this deployment runs)', () => {
  let root: string;
  let fsIndex: LayoutsIndex;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'journal-layouts-'));
    fsIndex = new LayoutsIndex(':memory:');
  });
  afterEach(async () => {
    fsIndex.close();
    await rm(root, { recursive: true, force: true });
  });

  const fsConfig = (): Config => ({ storageBackend: 'fs', journalDir: root }) as unknown as Config;

  it('writes <id>.dsl + <id>.meta.json and rebuilds from them after the index is wiped', async () => {
    const store = createLayoutStore(fsConfig(), fsIndex);
    const a = await store.create({ surface: 'analysis', name: 'Alpha', syntax: 'section "S"\n  panel todos\n' });
    const b = await store.create({ surface: 'analysis', name: 'Beta', syntax: 'section "S"\n  panel lists\n' });
    await store.setDefault('analysis', b.id);

    const files = (await readdir(join(root, 'derived/layouts'))).sort();
    expect(files).toEqual([`${a.id}.dsl`, `${a.id}.meta.json`, `${b.id}.dsl`, `${b.id}.meta.json`].sort());
    // The .dsl is the plain canonical text, not JSON-escaped.
    expect(await readFile(join(root, `derived/layouts/${a.id}.dsl`), 'utf8')).toBe(
      'layout "Alpha"\n\nsection "S"\n  panel todos\n',
    );
    const meta = JSON.parse(await readFile(join(root, `derived/layouts/${b.id}.meta.json`), 'utf8'));
    expect(meta).toMatchObject({ id: b.id, name: 'Beta', isDefault: true, surface: 'analysis' });

    // rm index.db && rebuild.
    fsIndex.close();
    const freshIndex = new LayoutsIndex(':memory:');
    const rebuilt = createLayoutStore(fsConfig(), freshIndex);
    const { layoutCount } = await rebuilt.rebuild();
    expect(layoutCount).toBe(2);
    const { layouts, defaultId } = await rebuilt.list('analysis');
    expect(new Set(layouts.map((l) => l.name))).toEqual(new Set(['Alpha', 'Beta']));
    expect(defaultId).toBe(b.id);
    freshIndex.close();
    fsIndex = freshIndex;
  });

  it('remove deletes both objects from disk', async () => {
    const store = createLayoutStore(fsConfig(), fsIndex);
    const a = await store.create({ surface: 'analysis', name: 'Gone', syntax: 'section "S"\n  panel todos\n' });
    await store.remove(a.id);
    expect(await readdir(join(root, 'derived/layouts'))).toEqual([]);
  });
});

describe('legacyPrefsToSyntax', () => {
  it('translates a default-ish prefs blob into the three registers', () => {
    const dsl = legacyPrefsToSyntax({}, 'My layout');
    expect(dsl).toBe(
      [
        'layout "My layout"',
        '',
        'section "Rhythms"',
        '  panel presence',
        '  panel register',
        '  panel horizon',
        '  panel matrix',
        '',
        'section "Tallies"',
        '  panel breakdown',
        '  panel correlation',
        '  panel reviews',
        '  panel rating-distribution',
        '  panel rating-spread',
        '',
        'section "Threads"',
        '  panel questions',
        '  panel todos',
        '  panel lists',
        '  panel concepts',
        '  panel aging',
        '',
      ].join('\n'),
    );
  });

  it('carries a non-default window, hidden panels, reordering, and calendar metrics', () => {
    const dsl = legacyPrefsToSyntax(
      {
        windowDays: 90,
        order: { rhythms: ['matrix', 'calendar'], threads: ['aging', 'todos'] },
        hidden: ['register', 'horizon', 'breakdowns', 'reviews', 'distribution', 'spread', 'questions', 'lists', 'concepts'],
        calendarMetrics: ['sleep', 'mood'],
      },
      'Mine',
    );
    expect(dsl).toBe(
      [
        'layout "Mine"',
        '  window: 90d',
        '',
        'section "Rhythms"',
        '  panel matrix',
        '  panel presence',
        '    metrics: sleep, mood',
        '',
        'section "Threads"',
        '  panel aging',
        '  panel todos',
        '',
      ].join('\n'),
    );
  });
});
