import { beforeEach, describe, expect, it } from 'vitest';
import type { PublicApiConfig } from '../../src/config.js';
import { createApp } from '../../src/http/app.js';
import type { PublicSourceType, PublishedIndexReader, PublishedRow } from '../../src/index-reader.js';
import type { PublicSearchHit, PublicSearchReader } from '../../src/public-search-reader.js';
import { slugFor } from '../../src/slug.js';
import type { StorageReader } from '../../src/storage-reader.js';

/**
 * Fakes rather than real implementations — `index-reader.test.ts` and
 * `storage-reader`'s own behaviour (mirrored from the already-tested
 * private stores) are covered elsewhere. This file is only about what the
 * HTTP layer does with what those two seams hand it.
 */

class FakeReader implements Pick<PublishedIndexReader, 'list' | 'findBySuffix' | 'getBySourceId'> {
  rows: PublishedRow[] = [];

  list(sourceType: PublicSourceType): PublishedRow[] {
    return this.rows.filter((row) => row.sourceType === sourceType);
  }

  findBySuffix(sourceType: PublicSourceType, suffix: string): PublishedRow | null {
    return (
      this.rows.find(
        (row) => row.sourceType === sourceType && row.sourceId.toLowerCase().endsWith(suffix.toLowerCase()),
      ) ?? null
    );
  }

  getBySourceId(sourceType: PublicSourceType, sourceId: string): PublishedRow | null {
    return this.rows.find((row) => row.sourceType === sourceType && row.sourceId === sourceId) ?? null;
  }
}

class FakeStorage implements StorageReader {
  files = new Map<string, string>();

  async read(relPath: string): Promise<string | null> {
    return this.files.get(relPath) ?? null;
  }
}

class FakeSearchReader implements Pick<PublicSearchReader, 'search'> {
  hits: PublicSearchHit[] = [];
  calls: { query: string; limit: number }[] = [];

  search(query: string, limit: number): PublicSearchHit[] {
    this.calls.push({ query, limit });
    return this.hits;
  }
}

const CONFIG: PublicApiConfig = {
  host: '127.0.0.1',
  port: 4320,
  allowedOrigins: ['http://localhost:3500'],
  storageBackend: 'fs',
  journalDir: '/dev/null',
  s3Bucket: undefined,
  awsRegion: undefined,
  awsAccessKeyId: undefined,
  awsSecretAccessKey: undefined,
  indexDbPath: '/dev/null',
};

let reader: FakeReader;
let searchReader: FakeSearchReader;
let storage: FakeStorage;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  reader = new FakeReader();
  searchReader = new FakeSearchReader();
  storage = new FakeStorage();
  app = createApp(
    reader as unknown as PublishedIndexReader,
    searchReader as unknown as PublicSearchReader,
    storage,
    CONFIG,
  );
});

async function errorOf(response: Response): Promise<{ code: string; message: string }> {
  return ((await response.json()) as { error: { code: string; message: string } }).error;
}

describe('GET /health', () => {
  it('answers ok with no reader or storage involvement', async () => {
    const response = await app.request('/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });
});

describe('GET /documents', () => {
  it('is an empty list, not an error, with nothing published', async () => {
    const response = await app.request('/documents');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ documents: [] });
  });

  it('returns a slug, title, created and excerpt for each published document', async () => {
    const ROW: PublishedRow = {
      sourceType: 'document',
      sourceId: '01K3F9X2VQ8N7M4TQXYZABCDEF',
      mirrorKey: 'public/documents/01K3F9X2VQ8N7M4TQXYZABCDEF.json',
    };
    reader.rows = [ROW];
    storage.files.set(
      ROW.mirrorKey,
      JSON.stringify({
        id: ROW.sourceId,
        title: 'A project',
        created: '2026-07-26T22:55:13+01:00',
        updated: '2026-07-26T22:55:13+01:00',
        body: 'The real body.\n',
        excerpt: 'Notes.',
      }),
    );

    const response = await app.request('/documents');
    const body = (await response.json()) as { documents: unknown[] };
    expect(body.documents).toEqual([
      { slug: 'a-project-abcdef', title: 'A project', created: '2026-07-26T22:55:13+01:00', excerpt: 'Notes.' },
    ]);
  });

  it('never includes a body — the list is summaries only', async () => {
    const ROW: PublishedRow = {
      sourceType: 'document',
      sourceId: '01K3F9X2VQ8N7M4TQXYZABCDEF',
      mirrorKey: 'public/documents/x.json',
    };
    reader.rows = [ROW];
    storage.files.set(
      ROW.mirrorKey,
      JSON.stringify({ id: ROW.sourceId, title: 'x', created: 'x', updated: 'x', body: 'x', excerpt: 'x' }),
    );
    const response = await app.request('/documents');
    const body = (await response.json()) as { documents: unknown[] };
    expect(body.documents[0]).not.toHaveProperty('body');
  });

  it('skips a row whose snapshot has gone missing rather than erroring', async () => {
    reader.rows = [{ sourceType: 'document', sourceId: '01K3F9X2VQ8N7M4TQXYZABCDEF', mirrorKey: 'public/documents/gone.json' }];
    const response = await app.request('/documents');
    expect(await response.json()).toEqual({ documents: [] });
  });

  it('never returns an entry mixed in with documents', async () => {
    reader.rows = [{ sourceType: 'entry', sourceId: '01K3F9X2VQ8N7M4TQXYZABCDEF', mirrorKey: 'public/entries/x.json' }];
    storage.files.set('public/entries/x.json', JSON.stringify({ id: 'x', created: 'x', body: 'x', excerpt: 'x' }));
    const response = await app.request('/documents');
    expect(await response.json()).toEqual({ documents: [] });
  });
});

describe('GET /documents/:slug', () => {
  const ROW: PublishedRow = {
    sourceType: 'document',
    sourceId: '01K3F9X2VQ8N7M4TQXYZABCDEF',
    mirrorKey: 'public/documents/01K3F9X2VQ8N7M4TQXYZABCDEF.json',
  };
  const SNAPSHOT = {
    id: ROW.sourceId,
    title: 'A project',
    created: '2026-07-26T22:55:13+01:00',
    updated: '2026-07-26T22:55:13+01:00',
    body: 'The real body.\n',
    excerpt: 'Notes.',
  };

  it('resolves a slug to its document and returns the body', async () => {
    reader.rows = [ROW];
    storage.files.set(ROW.mirrorKey, JSON.stringify(SNAPSHOT));

    const response = await app.request(`/documents/${slugFor(SNAPSHOT.title, SNAPSHOT.id)}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      slug: 'a-project-abcdef',
      title: 'A project',
      created: SNAPSHOT.created,
      excerpt: 'Notes.',
      body: 'The real body.\n',
    });
  });

  it('resolves by the bare id suffix, ignoring a stale or wrong descriptive prefix', async () => {
    reader.rows = [ROW];
    storage.files.set(ROW.mirrorKey, JSON.stringify(SNAPSHOT));

    const response = await app.request('/documents/anything-at-all-abcdef');
    expect(response.status).toBe(200);
  });

  it('404s for a slug with no matching id fragment', async () => {
    const response = await app.request('/documents/no-such-thing');
    expect(response.status).toBe(404);
    expect((await errorOf(response)).code).toBe('not_found');
  });

  it('404s for a suffix that matches nothing', async () => {
    const response = await app.request('/documents/nothing-here-zzzzzz');
    expect(response.status).toBe(404);
  });

  it('404s when the index has a row but the snapshot is gone — never guesses', async () => {
    reader.rows = [ROW];
    const response = await app.request(`/documents/${slugFor(SNAPSHOT.title, SNAPSHOT.id)}`);
    expect(response.status).toBe(404);
  });
});

describe('GET /entries', () => {
  it('is an empty list, not an error, with nothing published', async () => {
    const response = await app.request('/entries');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ entries: [] });
  });

  it('derives a slug from the date, not a title — entries have none', async () => {
    const ROW: PublishedRow = {
      sourceType: 'entry',
      sourceId: '01K3F9X2VQ8N7M4TQXYZABCDEF',
      mirrorKey: 'public/entries/01K3F9X2VQ8N7M4TQXYZABCDEF.json',
    };
    reader.rows = [ROW];
    storage.files.set(
      ROW.mirrorKey,
      JSON.stringify({ id: ROW.sourceId, created: '2026-08-27T09:00:00+01:00', body: 'What I did today.\n', excerpt: 'What I did today.' }),
    );

    const response = await app.request('/entries');
    expect(await response.json()).toEqual({
      entries: [{ slug: '2026-08-27-abcdef', created: '2026-08-27T09:00:00+01:00', excerpt: 'What I did today.' }],
    });
  });
});

describe('GET /entries/:slug', () => {
  it('resolves by date-slug and returns the body', async () => {
    const ROW: PublishedRow = {
      sourceType: 'entry',
      sourceId: '01K3F9X2VQ8N7M4TQXYZABCDEF',
      mirrorKey: 'public/entries/x.json',
    };
    reader.rows = [ROW];
    storage.files.set(
      ROW.mirrorKey,
      JSON.stringify({ id: ROW.sourceId, created: '2026-08-27T09:00:00+01:00', body: 'Body.\n', excerpt: 'Body.' }),
    );

    const response = await app.request('/entries/2026-08-27-abcdef');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      slug: '2026-08-27-abcdef',
      created: '2026-08-27T09:00:00+01:00',
      excerpt: 'Body.',
      body: 'Body.\n',
    });
  });

  it('404s for a slug matching nothing', async () => {
    const response = await app.request('/entries/2026-08-27-zzzzzz');
    expect(response.status).toBe(404);
    expect((await errorOf(response)).code).toBe('not_found');
  });

  it('never resolves an entry slug against a document row, or vice versa', async () => {
    reader.rows = [{ sourceType: 'document', sourceId: '01K3F9X2VQ8N7M4TQXYZABCDEF', mirrorKey: 'public/documents/x.json' }];
    const response = await app.request('/entries/2026-08-27-abcdef');
    expect(response.status).toBe(404);
  });
});

describe('GET /search', () => {
  it('is an empty list, not an error, with nothing matching', async () => {
    const response = await app.request('/search?q=lighthouse');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ hits: [] });
  });

  it('resolves a document chunk hit to its slug, title and passage', async () => {
    const ROW: PublishedRow = {
      sourceType: 'document',
      sourceId: '01K3F9X2VQ8N7M4TQXYZABCDEF',
      mirrorKey: 'public/documents/01K3F9X2VQ8N7M4TQXYZABCDEF.json',
    };
    reader.rows = [ROW];
    storage.files.set(
      ROW.mirrorKey,
      JSON.stringify({
        id: ROW.sourceId,
        title: 'A project',
        created: '2026-07-26T22:55:13+01:00',
        updated: '2026-07-26T22:55:13+01:00',
        body: 'Notes about a lighthouse.',
        excerpt: 'Notes.',
      }),
    );
    searchReader.hits = [{ sourceType: 'document', sourceId: ROW.sourceId, text: 'Notes about a lighthouse.' }];

    const response = await app.request('/search?q=lighthouse');
    expect(await response.json()).toEqual({
      hits: [{ sourceType: 'document', slug: 'a-project-abcdef', title: 'A project', passage: 'Notes about a lighthouse.' }],
    });
  });

  it('resolves an entry chunk hit to its date-slug and passage', async () => {
    const ROW: PublishedRow = {
      sourceType: 'entry',
      sourceId: '01K3F9X2VQ8N7M4TQXYZABCDEF',
      mirrorKey: 'public/entries/01K3F9X2VQ8N7M4TQXYZABCDEF.json',
    };
    reader.rows = [ROW];
    storage.files.set(
      ROW.mirrorKey,
      JSON.stringify({
        id: ROW.sourceId,
        created: '2026-08-27T09:00:00+01:00',
        body: 'A walk past the lighthouse.',
        excerpt: 'A walk.',
      }),
    );
    searchReader.hits = [{ sourceType: 'entry', sourceId: ROW.sourceId, text: 'A walk past the lighthouse.' }];

    const response = await app.request('/search?q=lighthouse');
    expect(await response.json()).toEqual({
      hits: [{ sourceType: 'entry', slug: '2026-08-27-abcdef', created: '2026-08-27T09:00:00+01:00', passage: 'A walk past the lighthouse.' }],
    });
  });

  it('skips a chunk hit whose source is no longer published', async () => {
    searchReader.hits = [{ sourceType: 'document', sourceId: 'gone', text: 'a stale chunk' }];
    const response = await app.request('/search?q=x');
    expect(await response.json()).toEqual({ hits: [] });
  });

  it('passes the query and default limit straight to the reader', async () => {
    await app.request('/search?q=lighthouse');
    expect(searchReader.calls).toEqual([{ query: 'lighthouse', limit: 20 }]);
  });

  it('respects a custom limit', async () => {
    await app.request('/search?q=x&limit=5');
    expect(searchReader.calls[0]!.limit).toBe(5);
  });

  it('rejects a missing or empty q', async () => {
    for (const q of [undefined, '', '   ']) {
      const response = await app.request(q === undefined ? '/search' : `/search?q=${encodeURIComponent(q)}`);
      expect(response.status).toBe(400);
      expect((await errorOf(response)).code).toBe('invalid_request');
    }
  });

  it('rejects a limit outside 1..50', async () => {
    for (const limit of ['0', '-1', '51', 'nope']) {
      const response = await app.request(`/search?q=x&limit=${limit}`);
      expect(response.status, limit).toBe(400);
      expect((await errorOf(response)).code).toBe('invalid_request');
    }
  });
});
