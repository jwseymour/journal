import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  AddAttachmentResponse,
  ApiError,
  CreateEntryResponse,
  Entry,
  EntryPage,
  HealthResponse,
  MetricsResponse,
  SearchHit,
  SearchResponse,
  TemporalMetric,
  TranscribeResponse,
  UpdateEntryResponse,
} from '@journal/contract';
import type { Config } from '../../src/config.js';
import { transcriptionFailed } from '../../src/errors.js';
import { createApp } from '../../src/http/app.js';
import type { ListMetricsOptions, MetricsReader, TemporalMetricRecord } from '../../src/index/metrics-index.js';
import { SqliteIndex } from '../../src/index/sqlite-index.js';
import type { Searcher } from '../../src/search/searcher.js';
import { FsEntryStore } from '../../src/store/fs-entry-store.js';
import type { Transcriber } from '../../src/transcribe/transcriber.js';

/**
 * A `Transcriber` that never loads a real model — HTTP tests exercise the
 * endpoint's own contract (validation, error shapes, wiring), not whether the
 * local speech-to-text model is accurate. The real implementation is verified
 * separately, live, against real synthetic speech — see the M4 write-up.
 *
 * On failure this throws the same `AppError` shape the real
 * `LocalTranscriber` throws, not a bare `Error` — the endpoint itself does no
 * error translation, so a fake that threw a plain `Error` here would only
 * prove the generic `internal` handler works, not this endpoint's own
 * `transcription_failed` mapping.
 */
class FakeTranscriber implements Transcriber {
  calls: Array<{ samples: Float32Array; sampleRate: number }> = [];
  result: string | 'FAIL' = 'fake transcript';

  async transcribe(samples: Float32Array, sampleRate: number): Promise<string> {
    this.calls.push({ samples, sampleRate });
    if (this.result === 'FAIL') throw transcriptionFailed('model exploded');
    return this.result;
  }
}

/**
 * Same reasoning as `FakeTranscriber`: HTTP tests exercise `/search`'s own
 * contract (validation, limit clamping, response shape), not whether BM25
 * and vector fusion actually rank well — that is `search-index.test.ts` and
 * `searcher.test.ts`'s job.
 */
class FakeSearcher implements Searcher {
  calls: Array<{ query: string; limit: number }> = [];
  hits: SearchHit[] = [];

  async search(query: string, limit: number): Promise<SearchHit[]> {
    this.calls.push({ query, limit });
    return this.hits;
  }
}

/**
 * Same reasoning again: HTTP tests exercise `/metrics`'s own contract, not
 * extraction quality or the real gateway — that is `extractor.test.ts` and
 * a live drill's job (`plan.md` M7).
 */
class FakeMetricsReader implements MetricsReader {
  listCalls: ListMetricsOptions[] = [];
  removeCalls: string[] = [];
  records: TemporalMetricRecord[] = [];

  list(options: ListMetricsOptions): TemporalMetricRecord[] {
    this.listCalls.push(options);
    const filtered = options.metric ? this.records.filter((r) => r.metric === options.metric) : this.records;
    return filtered.slice(0, options.limit);
  }

  remove(id: string): void {
    this.removeCalls.push(id);
    this.records = this.records.filter((r) => r.id !== id);
  }
}

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
let transcriber: FakeTranscriber;
let searcher: FakeSearcher;
let metrics: FakeMetricsReader;
let index: SqliteIndex;

const config = (journalDir: string): Config => ({
  journalDir,
  host: '127.0.0.1',
  port: 4319,
  allowedOrigins: [ORIGIN],
  whisperModel: 'Xenova/whisper-tiny.en',
  whisperCacheDir: join(journalDir, '.whisper-cache-unused-in-tests'),
  indexDbPath: ':memory:',
  embeddingModel: 'Xenova/all-MiniLM-L6-v2',
  embeddingDimensions: 384,
  embeddingCacheDir: join(journalDir, '.embedding-cache-unused-in-tests'),
  aiGatewayApiKey: undefined,
  extractionModel: 'anthropic/claude-sonnet-5',
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'journal-http-'));
  transcriber = new FakeTranscriber();
  searcher = new FakeSearcher();
  metrics = new FakeMetricsReader();
  index = new SqliteIndex(':memory:');
  app = createApp(new FsEntryStore(root, index), config(root), transcriber, searcher, metrics);
});

afterEach(async () => {
  index.close();
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

describe('POST /entries/:id/attachments', () => {
  function upload(id: string, filename: string, data: Uint8Array | string, type = 'application/octet-stream') {
    const form = new FormData();
    form.set('file', new File([data], filename, { type }));
    // No explicit Content-Type header: FormData needs to set its own boundary.
    return app.request(`/entries/${id}/attachments`, { method: 'POST', body: form });
  }

  it('stores the file and returns the relative link for the body', async () => {
    const created = (await (await post({ body: 'A photo from today.' })).json()) as CreateEntryResponse;
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);

    const response = await upload(created.id, 'photo.jpg', bytes, 'image/jpeg');
    expect(response.status).toBe(201);
    const body = (await response.json()) as AddAttachmentResponse;
    expect(body.relativeLink).toMatch(/^[0-9a-z-]+\/photo\.jpg$/);
    expect(body.relativeLink).not.toContain('journal/');
  });

  it('reports a missing entry as not found', async () => {
    const response = await upload('01ARZ3NDEKTSV4RRFFQ69G5FAV', 'x.jpg', 'x');
    expect(response.status).toBe(404);
    expect((await errorOf(response)).code).toBe('entry_not_found');
  });

  it('rejects a request with no file field', async () => {
    const created = (await (await post({ body: 'x' })).json()) as CreateEntryResponse;
    const form = new FormData();
    form.set('notFile', 'nope');
    const response = await app.request(`/entries/${created.id}/attachments`, { method: 'POST', body: form });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('invalid_request');
  });

  it('rejects a second attachment with the same filename', async () => {
    const created = (await (await post({ body: 'x' })).json()) as CreateEntryResponse;
    expect((await upload(created.id, 'voice.m4a', 'first')).status).toBe(201);

    const response = await upload(created.id, 'voice.m4a', 'second');
    expect(response.status).toBe(409);
    expect((await errorOf(response)).code).toBe('attachment_conflict');
  });

  it('rejects a filename that is a path traversal attempt', async () => {
    const created = (await (await post({ body: 'x' })).json()) as CreateEntryResponse;
    const response = await upload(created.id, '../../etc/passwd', 'x');
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('invalid_request');
  });
});

describe('POST /transcribe', () => {
  function transcribe(samples: Float32Array, sampleRate: number | string | undefined) {
    const query = sampleRate === undefined ? '' : `?sampleRate=${sampleRate}`;
    return app.request(`/transcribe${query}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: samples.buffer as ArrayBuffer,
    });
  }

  it('transcribes and hands the samples and rate straight to the Transcriber', async () => {
    transcriber.result = 'hello world';
    const samples = new Float32Array([0.1, -0.2, 0.3, 0]);

    const response = await transcribe(samples, 48_000);
    expect(response.status).toBe(200);
    const body = (await response.json()) as TranscribeResponse;
    expect(body.text).toBe('hello world');

    expect(transcriber.calls).toHaveLength(1);
    expect(transcriber.calls[0]!.sampleRate).toBe(48_000);
    expect(Array.from(transcriber.calls[0]!.samples)).toEqual(Array.from(samples));
  });

  it('rejects a missing or invalid sampleRate', async () => {
    const samples = new Float32Array([0.1, 0.2]);
    for (const rate of [undefined, '0', '-1', 'nope']) {
      const response = await transcribe(samples, rate);
      expect(response.status, String(rate)).toBe(400);
      expect((await errorOf(response)).code).toBe('invalid_request');
    }
  });

  it('rejects a body whose byte length is not a multiple of 4', async () => {
    const response = await app.request('/transcribe?sampleRate=16000', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array([1, 2, 3]),
    });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('invalid_request');
  });

  it('rejects an empty body', async () => {
    const response = await app.request('/transcribe?sampleRate=16000', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array([]),
    });
    expect(response.status).toBe(400);
  });

  it('surfaces a Transcriber failure as transcription_failed', async () => {
    transcriber.result = 'FAIL';
    const response = await transcribe(new Float32Array([0.1]), 16_000);
    expect(response.status).toBe(503);
    expect((await errorOf(response)).code).toBe('transcription_failed');
  });
});

describe('GET /search', () => {
  it('passes the query and default limit straight to the Searcher', async () => {
    const response = await app.request('/search?q=lighthouse');
    expect(response.status).toBe(200);
    const body = (await response.json()) as SearchResponse;
    expect(body).toEqual({ hits: [] });
    expect(searcher.calls).toEqual([{ query: 'lighthouse', limit: 20 }]);
  });

  it('returns whatever hits the Searcher produces, unmodified', async () => {
    const hit: SearchHit = { entryId: '01ARZ3NDEKTSV4RRFFQ69G5FAV', created: '2026-07-01T09:00:00Z', passage: 'a lighthouse on the point' };
    searcher.hits = [hit];

    const response = await app.request('/search?q=lighthouse');
    const body = (await response.json()) as SearchResponse;
    expect(body.hits).toEqual([hit]);
  });

  it('respects a custom limit', async () => {
    await app.request('/search?q=x&limit=5');
    expect(searcher.calls[0]!.limit).toBe(5);
  });

  it('rejects a missing q', async () => {
    const response = await app.request('/search');
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('invalid_request');
  });

  it('rejects an empty or whitespace-only q', async () => {
    for (const q of ['', '   ']) {
      const response = await app.request(`/search?q=${encodeURIComponent(q)}`);
      expect(response.status, JSON.stringify(q)).toBe(400);
    }
  });

  it('rejects a limit outside 1..200', async () => {
    for (const limit of ['0', '-1', '201', 'nope']) {
      const response = await app.request(`/search?q=x&limit=${limit}`);
      expect(response.status, limit).toBe(400);
      expect((await errorOf(response)).code).toBe('invalid_request');
    }
  });
});

describe('GET /metrics', () => {
  const record = (overrides: Partial<TemporalMetricRecord> = {}): TemporalMetricRecord => ({
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    entryId: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
    metric: 'exercise',
    eventTime: '2026-07-20T09:00:00+01:00',
    eventEpochMs: Date.parse('2026-07-20T08:00:00Z'),
    eventTimeExplicit: true,
    detail: 'a 5k run',
    extractedAt: '2026-07-20T10:00:00+01:00',
    ...overrides,
  });

  it('is empty, not an error, when nothing has been extracted', async () => {
    const response = await app.request('/metrics');
    expect(response.status).toBe(200);
    expect((await response.json()) as MetricsResponse).toEqual({ metrics: [] });
  });

  it('returns whatever the MetricsReader produces, without the internal-only fields', async () => {
    metrics.records = [record()];
    const response = await app.request('/metrics');
    const body = (await response.json()) as MetricsResponse;
    const expected: TemporalMetric = {
      id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      entryId: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
      metric: 'exercise',
      eventTime: '2026-07-20T09:00:00+01:00',
      eventTimeExplicit: true,
      detail: 'a 5k run',
    };
    expect(body.metrics).toEqual([expected]);
  });

  it('passes a metric filter and the default limit straight to the MetricsReader', async () => {
    await app.request('/metrics?metric=sleep');
    expect(metrics.listCalls).toEqual([{ metric: 'sleep', limit: 30 }]);
  });

  it('respects a custom limit', async () => {
    await app.request('/metrics?limit=5');
    expect(metrics.listCalls[0]).toEqual({ limit: 5 });
  });

  it('rejects a limit outside 1..200', async () => {
    for (const limit of ['0', '-1', '201', 'nope']) {
      const response = await app.request(`/metrics?limit=${limit}`);
      expect(response.status, limit).toBe(400);
      expect((await errorOf(response)).code).toBe('invalid_request');
    }
  });
});

describe('DELETE /metrics/:id', () => {
  it('removes the record', async () => {
    const response = await app.request('/metrics/01ARZ3NDEKTSV4RRFFQ69G5FAV', { method: 'DELETE' });
    expect(response.status).toBe(204);
    expect(metrics.removeCalls).toEqual(['01ARZ3NDEKTSV4RRFFQ69G5FAV']);
  });

  it('is a no-op, not an error, for a malformed id', async () => {
    const response = await app.request('/metrics/not-a-ulid', { method: 'DELETE' });
    expect(response.status).toBe(204);
    expect(metrics.removeCalls).toEqual([]);
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
