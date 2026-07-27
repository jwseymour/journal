import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import type {
  ApiError,
  CreateEntryResponse,
  Entry,
  EntryPage,
  HealthResponse,
} from '@journal/contract';
import type { Config } from '../config.js';
import { AppError, invalidRequest } from '../errors.js';
import { isUlid } from '../record/id.js';
import type { EntryStore } from './../store/entry-store.js';

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

function errorBody(code: ApiError['error']['code'], message: string): ApiError {
  return { error: { code, message } };
}

export function createApp(store: EntryStore, config: Config): Hono {
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
      allowMethods: ['GET', 'POST', 'OPTIONS'],
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
    const response: Entry = {
      id: entry.id,
      created: entry.created,
      ...(entry.location ? { location: entry.location } : {}),
      body: entry.body,
    };
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
