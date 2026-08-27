import { beforeEach, describe, expect, it } from 'vitest';
import type { PublicApiConfig } from '../../src/config.js';
import { createApp } from '../../src/http/app.js';
import type { PublicDocumentRow, PublicDocumentsReader } from '../../src/index-reader.js';
import { slugFor } from '../../src/slug.js';
import type { StorageReader } from '../../src/storage-reader.js';

/**
 * Fakes rather than real implementations — `index-reader.test.ts` and
 * `storage-reader`'s own behaviour (mirrored from the already-tested
 * private stores) are covered elsewhere. This file is only about what the
 * HTTP layer does with what those two seams hand it, in particular the
 * defence-in-depth check between them (`requirements.md` §10).
 */

class FakeReader implements Pick<PublicDocumentsReader, 'list' | 'findBySuffix'> {
  rows: PublicDocumentRow[] = [];

  list(): PublicDocumentRow[] {
    return this.rows;
  }

  findBySuffix(suffix: string): PublicDocumentRow | null {
    return this.rows.find((row) => row.id.toLowerCase().endsWith(suffix.toLowerCase())) ?? null;
  }
}

class FakeStorage implements StorageReader {
  files = new Map<string, string>();

  async read(relPath: string): Promise<string | null> {
    return this.files.get(relPath) ?? null;
  }
}

function fileFor(publicFlag: boolean, body: string): string {
  return `---\nid: x\npublic: ${publicFlag}\n---\n${body}`;
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
let storage: FakeStorage;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  reader = new FakeReader();
  storage = new FakeStorage();
  app = createApp(reader as unknown as PublicDocumentsReader, storage, CONFIG);
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
  it('is an empty list, not an error, with nothing public', async () => {
    const response = await app.request('/documents');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ documents: [] });
  });

  it('returns a slug, title, created and excerpt for each public document', async () => {
    reader.rows = [
      { id: '01K3F9X2VQ8N7M4TQXYZABCDEF', title: 'A project', created: '2026-07-26T22:55:13+01:00', excerpt: 'Notes.', relPath: 'documents/x.md' },
    ];

    const response = await app.request('/documents');
    const body = (await response.json()) as { documents: unknown[] };
    expect(body.documents).toEqual([
      { slug: 'a-project-abcdef', title: 'A project', created: '2026-07-26T22:55:13+01:00', excerpt: 'Notes.' },
    ]);
  });

  it('never includes a body — the list is summaries only', async () => {
    reader.rows = [
      { id: '01K3F9X2VQ8N7M4TQXYZABCDEF', title: 'x', created: '2026-07-26T22:55:13+01:00', excerpt: 'x', relPath: 'documents/x.md' },
    ];
    const response = await app.request('/documents');
    const body = (await response.json()) as { documents: unknown[] };
    expect(body.documents[0]).not.toHaveProperty('body');
  });
});

describe('GET /documents/:slug', () => {
  const ROW: PublicDocumentRow = {
    id: '01K3F9X2VQ8N7M4TQXYZABCDEF',
    title: 'A project',
    created: '2026-07-26T22:55:13+01:00',
    excerpt: 'Notes.',
    relPath: 'documents/x.md',
  };

  it('resolves a slug to its document and returns the body', async () => {
    reader.rows = [ROW];
    storage.files.set(ROW.relPath, fileFor(true, 'The real body.\n'));

    const response = await app.request(`/documents/${slugFor(ROW.title, ROW.id)}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      slug: 'a-project-abcdef',
      title: 'A project',
      created: ROW.created,
      excerpt: 'Notes.',
      body: 'The real body.\n',
    });
  });

  it('resolves by the bare id suffix, ignoring a stale or wrong descriptive prefix', async () => {
    reader.rows = [ROW];
    storage.files.set(ROW.relPath, fileFor(true, 'x\n'));

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

  it('404s when the index says public but the file itself says private — the file always wins', async () => {
    reader.rows = [ROW];
    storage.files.set(ROW.relPath, fileFor(false, 'x\n'));

    const response = await app.request(`/documents/${slugFor(ROW.title, ROW.id)}`);
    expect(response.status).toBe(404);
    expect((await errorOf(response)).code).toBe('not_found');
  });

  it('404s when the index says public but the file is gone', async () => {
    reader.rows = [ROW];

    const response = await app.request(`/documents/${slugFor(ROW.title, ROW.id)}`);
    expect(response.status).toBe(404);
  });

  it('404s when the file cannot even be read as a document', async () => {
    reader.rows = [ROW];
    storage.files.set(ROW.relPath, 'Not a document file at all.\n');

    const response = await app.request(`/documents/${slugFor(ROW.title, ROW.id)}`);
    expect(response.status).toBe(404);
  });
});

describe('the boundary', () => {
  it('allows an allowlisted browser origin, and says so in the response', async () => {
    const response = await app.request('/health', { headers: { Origin: 'http://localhost:3500' } });
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:3500');
  });

  it('never answers an unlisted origin with a wildcard or the origin itself', async () => {
    const response = await app.request('/health', { headers: { Origin: 'http://evil.example' } });
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('rejects a mutating method — this surface is read-only', async () => {
    const response = await app.request('/documents', { method: 'POST' });
    expect(response.status).toBe(404);
  });
});
