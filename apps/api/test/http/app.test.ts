import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  ApiError,
  CreateEntryResponse,
  Entry,
  EntryPage,
  HealthResponse,
  UpdateEntryResponse,
} from '@journal/contract';
import type { Config } from '../../src/config.js';
import { createApp } from '../../src/http/app.js';
import { FsEntryStore } from '../../src/store/fs-entry-store.js';

/**
 * The endpoints, exercised through Hono's own request path so that middleware,
 * status codes and error shapes are all real.
 *
 * `app.request()` sets a `Host` of `localhost`, which is what a browser on this
 * machine would send.
 */

const ORIGIN = 'http://localhost:3000';

let root: string;
let app: ReturnType<typeof createApp>;

const config = (journalDir: string): Config => ({
  journalDir,
  host: '127.0.0.1',
  port: 4319,
  allowedOrigins: [ORIGIN],
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'journal-http-'));
  app = createApp(new FsEntryStore(root), config(root));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function post(body: unknown, headers: Record<string, string> = {}) {
  return app.request('/entries', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

const errorOf = async (response: Response) => ((await response.json()) as ApiError).error;

describe('GET /health', () => {
  it('reports which journal is being served', async () => {
    const response = await app.request('/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual<HealthResponse>({
      status: 'ok',
      journalDir: root,
      entryCount: 0,
      unreadableCount: 0,
    });
  });

  it('counts unreadable files so damage is visible rather than silent', async () => {
    await mkdir(join(root, 'journal'), { recursive: true });
    await writeFile(join(root, 'journal/broken.md'), 'no frontmatter here\n');
    const health = (await (await app.request('/health')).json()) as HealthResponse;
    expect(health).toMatchObject({ entryCount: 0, unreadableCount: 1 });
  });
});

describe('POST /entries', () => {
  it('creates an entry and reports where it landed', async () => {
    const response = await post({
      body: 'Written over HTTP.',
      created: '2026-07-26T22:55:13+01:00',
      location: { lat: 51.5072, lon: -0.1276 },
    });

    expect(response.status).toBe(201);
    const created = (await response.json()) as CreateEntryResponse;
    expect(created.created).toBe('2026-07-26T22:55:13+01:00');
    expect(created.path).toMatch(/^journal\/2026\/07\/2026-07-26-2255-[0-9a-z]{6}\.md$/);

    // The file really is there, and it really is clean markdown.
    expect(await readFile(join(root, created.path), 'utf8')).toBe(
      `---\nid: ${created.id}\ncreated: 2026-07-26T22:55:13+01:00\n` +
        `location: { lat: 51.5072, lon: -0.1276 }\n---\nWritten over HTTP.\n`,
    );
  });

  it('works without created or location, so curl is usable', async () => {
    expect((await post({ body: 'Bare.' })).status).toBe(201);
  });

  it('rejects a body that is not valid JSON', async () => {
    const response = await app.request('/entries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ not json',
    });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('invalid_request');
  });

  it('rejects fields the format does not have', async () => {
    // `format.md` §3: three fields and no others. A title arriving here means a
    // client has invented one, and failing loudly is how that gets noticed.
    const response = await post({ body: 'x', title: 'My day' });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('invalid_request');
  });

  it('rejects a missing body, a non-string body, and impossible coordinates', async () => {
    for (const payload of [
      {},
      { body: 42 },
      { body: 'x', location: { lat: 91, lon: 0 } },
      { body: 'x', location: { lat: 0, lon: 181 } },
      { body: 'x', location: { lat: 0 } },
      { body: 'x', created: 'sometime yesterday' },
    ]) {
      const response = await post(payload);
      expect(response.status, JSON.stringify(payload)).toBe(400);
      expect((await errorOf(response)).code).toBe('invalid_request');
    }
  });

  it('declines to commit an entry that was never written', async () => {
    const response = await post({ body: '   \n  ' });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('invalid_request');
  });
});

describe('GET /entries', () => {
  const write = (created: string, body: string) => post({ body, created });

  it('is an empty page, not an error, on an empty journal', async () => {
    const response = await app.request('/entries');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual<EntryPage>({ entries: [], nextCursor: null });
  });

  it('returns newest first with excerpts already cut', async () => {
    await write('2026-07-01T09:00:00+01:00', 'The first one.');
    await write('2026-07-02T09:00:00+01:00', `${'long '.repeat(300)}`);

    const page = (await (await app.request('/entries')).json()) as EntryPage;
    expect(page.entries).toHaveLength(2);
    expect(page.entries[0]!.excerpt).toMatch(/…$/);
    expect(page.entries[1]!.excerpt).toBe('The first one.');
    // The frontend receives a string and is told nothing about how it was cut.
    expect(page.entries[0]).not.toHaveProperty('body');
    expect(page.entries[0]).not.toHaveProperty('path');
  });

  it('pages with an opaque cursor', async () => {
    for (let i = 1; i <= 5; i += 1) {
      await write(`2026-07-0${i}T09:00:00Z`, `Entry ${i}`);
    }
    const first = (await (await app.request('/entries?limit=2')).json()) as EntryPage;
    expect(first.entries.map((e) => e.excerpt)).toEqual(['Entry 5', 'Entry 4']);
    expect(first.nextCursor).toBeTruthy();

    const second = (await (
      await app.request(`/entries?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`)
    ).json()) as EntryPage;
    expect(second.entries.map((e) => e.excerpt)).toEqual(['Entry 3', 'Entry 2']);
  });

  it('rejects a cursor it did not issue', async () => {
    const response = await app.request('/entries?cursor=fabricated');
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('invalid_cursor');
  });

  it('rejects an unusable limit', async () => {
    for (const limit of ['0', '-1', '201', 'ten', '1.5']) {
      const response = await app.request(`/entries?limit=${limit}`);
      expect(response.status, limit).toBe(400);
      expect((await errorOf(response)).code).toBe('invalid_request');
    }
  });
});

describe('GET /entries/:id', () => {
  it('returns the metadata and the full body', async () => {
    const created = (await (
      await post({ body: 'Line one\n\nLine two\n', created: '2026-07-26T22:55:13+01:00' })
    ).json()) as CreateEntryResponse;

    const response = await app.request(`/entries/${created.id}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual<Entry>({
      id: created.id,
      created: '2026-07-26T22:55:13+01:00',
      body: 'Line one\n\nLine two\n',
      contentHash: created.contentHash,
    });
  });

  it('reports a missing entry as not found, including for a malformed id', async () => {
    for (const id of ['01ARZ3NDEKTSV4RRFFQ69G5FAV', 'nonsense', '../../etc/passwd']) {
      const response = await app.request(`/entries/${encodeURIComponent(id)}`);
      expect(response.status, id).toBe(404);
      expect((await errorOf(response)).code).toBe('entry_not_found');
    }
  });
});

describe('PUT /entries/:id', () => {
  function put(id: string, body: unknown) {
    return app.request(`/entries/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('changes the body and returns the entry with a new contentHash', async () => {
    const created = (await (
      await post({ body: 'First draft.', created: '2026-07-26T22:55:13+01:00' })
    ).json()) as CreateEntryResponse;

    const response = await put(created.id, { body: 'Revised.', contentHash: created.contentHash });
    expect(response.status).toBe(200);
    const updated = (await response.json()) as UpdateEntryResponse;
    expect(updated).toEqual<Entry>({
      id: created.id,
      created: created.created,
      body: 'Revised.\n',
      contentHash: updated.contentHash,
    });
    expect(updated.contentHash).not.toBe(created.contentHash);

    // And it is really on disk, readable through GET.
    const reread = (await (await app.request(`/entries/${created.id}`)).json()) as Entry;
    expect(reread.body).toBe('Revised.\n');
  });

  it('rejects a stale contentHash with a 409 and does not touch the file', async () => {
    const created = (await (
      await post({ body: 'Original.', created: '2026-07-26T22:55:13+01:00' })
    ).json()) as CreateEntryResponse;
    await put(created.id, { body: 'First edit.', contentHash: created.contentHash });

    // Retrying with the now-stale hash from the original creation.
    const response = await put(created.id, { body: 'Conflicting edit.', contentHash: created.contentHash });
    expect(response.status).toBe(409);
    expect((await errorOf(response)).code).toBe('edit_conflict');

    const reread = (await (await app.request(`/entries/${created.id}`)).json()) as Entry;
    expect(reread.body).toBe('First edit.\n');
  });

  it('reports a missing entry as not found', async () => {
    const response = await put('01ARZ3NDEKTSV4RRFFQ69G5FAV', { body: 'x', contentHash: 'whatever' });
    expect(response.status).toBe(404);
    expect((await errorOf(response)).code).toBe('entry_not_found');
  });

  it('rejects a missing contentHash and a missing body', async () => {
    const created = (await (await post({ body: 'x' })).json()) as CreateEntryResponse;
    for (const payload of [{ body: 'y' }, { contentHash: created.contentHash }, {}]) {
      const response = await put(created.id, payload);
      expect(response.status, JSON.stringify(payload)).toBe(400);
      expect((await errorOf(response)).code).toBe('invalid_request');
    }
  });

  it('rejects fields the format does not have', async () => {
    const created = (await (await post({ body: 'x' })).json()) as CreateEntryResponse;
    const response = await put(created.id, {
      body: 'y',
      contentHash: created.contentHash,
      title: 'Nope',
    });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('invalid_request');
  });
});

describe('DELETE /entries/:id', () => {
  function del(id: string) {
    return app.request(`/entries/${id}`, { method: 'DELETE' });
  }

  it('discards a whitespace-only entry', async () => {
    const created = (await (await post({ body: 'placeholder' })).json()) as CreateEntryResponse;
    await app.request(`/entries/${created.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: '   ', contentHash: created.contentHash }),
    });

    const response = await del(created.id);
    expect(response.status).toBe(204);

    expect((await app.request(`/entries/${created.id}`)).status).toBe(404);
  });

  it('refuses to discard an entry with real content, and leaves it readable', async () => {
    const created = (await (await post({ body: 'Real writing.' })).json()) as CreateEntryResponse;

    const response = await del(created.id);
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('invalid_request');

    expect((await app.request(`/entries/${created.id}`)).status).toBe(200);
  });

  it('is idempotent — deleting an already-gone or never-existed entry still succeeds quietly', async () => {
    expect((await del('01ARZ3NDEKTSV4RRFFQ69G5FAV')).status).toBe(204);
  });
});

describe('the boundary', () => {
  it('allows an allowlisted browser origin, and says so in the response', async () => {
    const response = await app.request('/entries', { headers: { Origin: ORIGIN } });
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN);
  });

  it('refuses an origin that is not on the allowlist', async () => {
    const response = await app.request('/entries', {
      headers: { Origin: 'http://evil.example' },
    });
    expect(response.status).toBe(403);
    expect((await errorOf(response)).code).toBe('forbidden_origin');
  });

  it('never answers with a wildcard origin', async () => {
    const response = await app.request('/entries', { headers: { Origin: ORIGIN } });
    expect(response.headers.get('access-control-allow-origin')).not.toBe('*');
  });

  it('allows a request with no Origin at all, which is what curl sends', async () => {
    expect((await app.request('/entries')).status).toBe(200);
  });

  it('refuses a host it does not serve, which is what defeats DNS rebinding', async () => {
    // Under rebinding the browser thinks it is same-origin and sends no Origin
    // header, so the allowlist above never sees the request. The Host does.
    const response = await app.request('http://evil.example/entries');
    expect(response.status).toBe(403);
    expect((await errorOf(response)).code).toBe('forbidden_origin');
  });

  it('answers on loopback under either name', async () => {
    expect((await app.request('http://127.0.0.1:4319/entries')).status).toBe(200);
    expect((await app.request('http://localhost:3000/entries')).status).toBe(200);
  });
});

describe('errors', () => {
  it('are structured, with a stable machine-readable code', async () => {
    const response = await app.request('/nowhere');
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
    const body = (await response.json()) as ApiError;
    expect(body.error).toMatchObject({ code: expect.any(String), message: expect.any(String) });
  });
});
