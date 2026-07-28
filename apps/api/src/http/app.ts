import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import type {
  AddAttachmentResponse,
  ApiError,
  CreateEntryResponse,
  Entry,
  EntryPage,
  HealthResponse,
  TranscribeResponse,
  UpdateEntryResponse,
} from '@journal/contract';
import type { Config } from '../config.js';
import { AppError, invalidRequest } from '../errors.js';
import { isUlid } from '../record/id.js';
import type { Transcriber } from '../transcribe/transcriber.js';
import type { EntryStore } from './../store/entry-store.js';

/** A generous ceiling, not a tuned one — big enough for a long spoken entry's
 * worth of raw PCM, small enough that a request cannot hold the process open
 * reading an unbounded body. */
const MAX_ATTACHMENT_BYTES = 200 * 1024 * 1024;
const MAX_AUDIO_BYTES = 100 * 1024 * 1024;

/**
 * The HTTP surface. **Thin — no logic** (`plan.md` repository shape).
 *
 * Everything here is transport: parse, delegate, serialise. Anything that looks
 * like a decision about entries belongs in `store/` or `record/`, because this
 * layer is the part most likely to be swapped and the least worth trusting.
 */

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 200;

/**
 * Hosts this server will answer to.
 *
 * Binding to loopback is not by itself a defence: DNS rebinding lets a page at
 * `evil.example` resolve to 127.0.0.1, at which point the browser considers the
 * request same-origin and sends **no** `Origin` header at all — so the origin
 * allowlist below never sees it. The `Host` header still says `evil.example`,
 * which is what this catches.
 */
function allowedHosts(config: Config): ReadonlySet<string> {
  return new Set([config.host, 'localhost', '127.0.0.1', '[::1]', '::1']);
}

const CoordinatesSchema = z
  .object({
    lat: z.number().finite().min(-90).max(90),
    lon: z.number().finite().min(-180).max(180),
  })
  .strict();

const CreateEntrySchema = z
  .object({
    body: z.string(),
    created: z.string().optional(),
    location: CoordinatesSchema.optional(),
  })
  .strict();

const UpdateEntrySchema = z
  .object({
    body: z.string(),
    contentHash: z.string().min(1),
  })
  .strict();

function entryResponse(entry: {
  id: string;
  created: string;
  location?: { lat: number; lon: number };
  body: string;
  contentHash: string;
}): Entry {
  return {
    id: entry.id,
    created: entry.created,
    ...(entry.location ? { location: entry.location } : {}),
    body: entry.body,
    contentHash: entry.contentHash,
  };
}

function errorBody(code: ApiError['error']['code'], message: string): ApiError {
  return { error: { code, message } };
}

export function createApp(store: EntryStore, config: Config, transcriber: Transcriber): Hono {
  const app = new Hono();
  const origins = new Set(config.allowedOrigins);
  const hosts = allowedHosts(config);

  app.use('*', async (c, next) => {
    // Taken from the request URL rather than the `Host` header directly: the
    // Node adapter builds that URL *from* the Host header, so this is the same
    // value with the port already stripped — and unlike the raw header it is
    // also present when the app is driven through `app.request()`.
    const host = new URL(c.req.url).hostname;
    if (!hosts.has(host)) {
      return c.json(
        errorBody('forbidden_origin', `This server does not answer to the host '${host}'.`),
        403,
      );
    }

    // Absent on curl and on same-origin navigations, which is correct: the
    // header exists to identify a *browser* caller, and there is nothing to
    // check when there is no browser.
    const origin = c.req.header('Origin');
    if (origin !== undefined && !origins.has(origin)) {
      return c.json(
        errorBody('forbidden_origin', `The origin '${origin}' is not on the allowlist.`),
        403,
      );
    }

    return next();
  });

  app.use(
    '*',
    cors({
      // A function rather than the array form, so an unlisted origin is echoed
      // back as nothing at all rather than as a wildcard.
      origin: (origin) => (origins.has(origin) ? origin : null),
      allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type'],
      maxAge: 600,
    }),
  );

  app.get('/health', async (c) => {
    const { entryCount, unreadableCount } = await store.stats();
    const health: HealthResponse = {
      status: 'ok',
      journalDir: config.journalDir,
      entryCount,
      unreadableCount,
    };
    return c.json(health);
  });

  app.post('/entries', async (c) => {
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      throw invalidRequest('The request body is not valid JSON.');
    }

    const parsed = CreateEntrySchema.safeParse(json);
    if (!parsed.success) {
      const [issue] = parsed.error.issues;
      const at = issue && issue.path.length > 0 ? ` at '${issue.path.join('.')}'` : '';
      throw invalidRequest(`${issue?.message ?? 'Invalid request body.'}${at}`);
    }

    // Spread conditionally rather than passing `parsed.data` straight through:
    // zod's `.optional()` yields `string | undefined`, and an explicit
    // `created: undefined` is a different thing from an absent `created`.
    const { body, created, location } = parsed.data;
    const entry = await store.create({
      body,
      ...(created !== undefined ? { created } : {}),
      ...(location !== undefined ? { location } : {}),
    });
    const response: CreateEntryResponse = {
      id: entry.id,
      created: entry.created,
      path: entry.path,
      contentHash: entry.contentHash,
    };
    return c.json(response, 201);
  });

  app.get('/entries', async (c) => {
    const cursor = c.req.query('cursor');
    const rawLimit = c.req.query('limit');

    let limit = DEFAULT_LIMIT;
    if (rawLimit !== undefined && rawLimit !== '') {
      const value = Number(rawLimit);
      if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
        throw invalidRequest(`'limit' must be a whole number between 1 and ${MAX_LIMIT}.`);
      }
      limit = value;
    }

    const result = await store.list({
      limit,
      ...(cursor !== undefined && cursor !== '' ? { cursor } : {}),
    });
    const page: EntryPage = { entries: result.entries, nextCursor: result.nextCursor };
    return c.json(page);
  });

  app.get('/entries/:id', async (c) => {
    const id = c.req.param('id');
    // A malformed id is reported as "no such entry" rather than as a bad
    // request: from the caller's side both mean the same thing, and a stale
    // link should land on the not-found surface, not an error one.
    const entry = isUlid(id) ? await store.get(id) : null;
    if (!entry) {
      return c.json(errorBody('entry_not_found', `No entry with id ${id}.`), 404);
    }
    return c.json(entryResponse(entry));
  });

  app.put('/entries/:id', async (c) => {
    const id = c.req.param('id');
    if (!isUlid(id)) {
      return c.json(errorBody('entry_not_found', `No entry with id ${id}.`), 404);
    }

    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      throw invalidRequest('The request body is not valid JSON.');
    }

    const parsed = UpdateEntrySchema.safeParse(json);
    if (!parsed.success) {
      const [issue] = parsed.error.issues;
      const at = issue && issue.path.length > 0 ? ` at '${issue.path.join('.')}'` : '';
      throw invalidRequest(`${issue?.message ?? 'Invalid request body.'}${at}`);
    }

    const entry = await store.update(id, parsed.data);
    const response: UpdateEntryResponse = entryResponse(entry);
    return c.json(response);
  });

  app.delete('/entries/:id', async (c) => {
    const id = c.req.param('id');
    // Deleting something that was never there is not an error — see
    // EntryStore.discardIfBlank. A malformed id is simply "nothing to do."
    if (isUlid(id)) await store.discardIfBlank(id);
    return c.body(null, 204);
  });

  app.post('/entries/:id/attachments', async (c) => {
    const id = c.req.param('id');
    if (!isUlid(id)) {
      return c.json(errorBody('entry_not_found', `No entry with id ${id}.`), 404);
    }

    const contentLength = Number(c.req.header('content-length') ?? '0');
    if (contentLength > MAX_ATTACHMENT_BYTES) {
      throw invalidRequest(`The attachment is larger than the ${MAX_ATTACHMENT_BYTES} byte limit.`);
    }

    let body: Record<string, unknown>;
    try {
      body = await c.req.parseBody();
    } catch {
      throw invalidRequest('The request body is not valid multipart/form-data.');
    }

    const file = body['file'];
    if (!(file instanceof File)) {
      throw invalidRequest("A 'file' field carrying the attachment is required.");
    }

    const data = Buffer.from(await file.arrayBuffer());
    const result = await store.addAttachment(id, { filename: file.name, data });
    const response: AddAttachmentResponse = result;
    return c.json(response, 201);
  });

  app.post('/transcribe', async (c) => {
    const contentLength = Number(c.req.header('content-length') ?? '0');
    if (contentLength > MAX_AUDIO_BYTES) {
      throw invalidRequest(`The recording is larger than the ${MAX_AUDIO_BYTES} byte limit.`);
    }

    const rawSampleRate = c.req.query('sampleRate');
    const sampleRate = Number(rawSampleRate);
    if (!rawSampleRate || !Number.isFinite(sampleRate) || sampleRate <= 0) {
      throw invalidRequest("A positive 'sampleRate' query parameter is required.");
    }

    let buffer: ArrayBuffer;
    try {
      buffer = await c.req.arrayBuffer();
    } catch {
      throw invalidRequest('Could not read the recording body.');
    }
    if (buffer.byteLength === 0 || buffer.byteLength % 4 !== 0) {
      throw invalidRequest('The recording body must be raw 32-bit float PCM samples.');
    }

    const samples = new Float32Array(buffer);
    const text = await transcriber.transcribe(samples, sampleRate);
    const response: TranscribeResponse = { text };
    return c.json(response);
  });

  app.notFound((c) => c.json(errorBody('invalid_request', 'No such endpoint.'), 404));

  app.onError((error, c) => {
    if (error instanceof AppError) {
      return c.json(errorBody(error.code, error.message), error.status as ContentfulStatusCode);
    }
    // Never leak an internal message across the boundary; log it instead.
    console.error('[journal] unhandled error', error);
    return c.json(errorBody('internal', 'The request could not be completed.'), 500);
  });

  return app;
}
