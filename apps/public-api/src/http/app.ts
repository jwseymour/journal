import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { PublicApiConfig } from '../config.js';
import type { PublicSourceType, PublishedIndexReader } from '../index-reader.js';
import type { PublicSearchReader } from '../public-search-reader.js';
import { slugFor, suffixFromSlug } from '../slug.js';
import type { StorageReader } from '../storage-reader.js';

/**
 * The entire public-facing HTTP surface (`requirements.md` §10, `plan.md`
 * M14/M15). **Read-only** — there is no `POST`, `PUT`, or `DELETE`
 * anywhere in this file, and no auth middleware, because there is nothing
 * here that needs protecting beyond what `PublishedIndexReader`/
 * `StorageReader` already refuse to serve.
 *
 * Every route reads a snapshot object from the `public/` mirror
 * (`Publisher`'s own doc comment on the private side explains why) and
 * trusts it completely — unlike M14's documents-only shape, there is no
 * separate "does the file itself still agree" check here, because a
 * snapshot's mere existence at its mirror key *is* the publish decision.
 * Nothing under `public/` was ever written for any reason other than
 * "this is meant to be public."
 */

interface DocumentSnapshot {
  id: string;
  title: string;
  created: string;
  updated: string;
  body: string;
  excerpt: string;
}

interface EntrySnapshot {
  id: string;
  created: string;
  body: string;
  excerpt: string;
}

export interface PublicDocumentSummary {
  slug: string;
  title: string;
  created: string;
  excerpt: string;
}

export interface PublicDocumentsListResponse {
  documents: PublicDocumentSummary[];
}

export interface PublicDocument extends PublicDocumentSummary {
  body: string;
}

export interface PublicEntrySummary {
  slug: string;
  created: string;
  excerpt: string;
}

export interface PublicEntriesListResponse {
  entries: PublicEntrySummary[];
}

export interface PublicEntry extends PublicEntrySummary {
  body: string;
}

export interface PublicSearchDocumentHit {
  sourceType: 'document';
  slug: string;
  title: string;
  passage: string;
}

export interface PublicSearchEntryHit {
  sourceType: 'entry';
  slug: string;
  created: string;
  passage: string;
}

export type PublicSearchHit = PublicSearchDocumentHit | PublicSearchEntryHit;

export interface PublicSearchResponse {
  hits: PublicSearchHit[];
}

const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 50;

function notFound(sourceType: PublicSourceType, slug: string) {
  return { error: { code: 'not_found' as const, message: `No ${sourceType} at '${slug}'.` } };
}

function invalidRequest(message: string) {
  return { error: { code: 'invalid_request' as const, message } };
}

/** An entry has no title, so its slug is derived from its `created` date
 * instead (`plan.md` M15) — `slugFor` just slugifies whatever text it's
 * given, and a bare `YYYY-MM-DD` slugifies to itself unchanged. */
function entrySlug(created: string, id: string): string {
  return slugFor(created.slice(0, 10), id);
}

export function createApp(
  reader: PublishedIndexReader,
  searchReader: PublicSearchReader,
  storage: StorageReader,
  config: PublicApiConfig,
): Hono {
  const app = new Hono();
  const origins = new Set(config.allowedOrigins);

  app.use(
    '*',
    cors({
      // Echo the allowlisted origin back, or nothing — same posture
      // `apps/api`'s CORS setup takes, for the same reason (never a
      // wildcard, `plan.md` M1).
      origin: (origin) => (origins.has(origin) ? origin : null),
      allowMethods: ['GET', 'OPTIONS'],
      maxAge: 600,
    }),
  );

  app.get('/health', (c) => c.json({ status: 'ok' as const }));

  app.get('/documents', async (c) => {
    const documents: PublicDocumentSummary[] = [];
    for (const row of reader.list('document')) {
      const text = await storage.read(row.mirrorKey);
      if (!text) continue;
      const snapshot = JSON.parse(text) as DocumentSnapshot;
      documents.push({
        slug: slugFor(snapshot.title, snapshot.id),
        title: snapshot.title,
        created: snapshot.created,
        excerpt: snapshot.excerpt,
      });
    }
    const response: PublicDocumentsListResponse = { documents };
    return c.json(response);
  });

  app.get('/documents/:slug', async (c) => {
    const slug = c.req.param('slug');
    const suffix = suffixFromSlug(slug);
    const row = suffix ? reader.findBySuffix('document', suffix) : null;
    if (!row) return c.json(notFound('document', slug), 404);

    const text = await storage.read(row.mirrorKey);
    if (!text) return c.json(notFound('document', slug), 404);
    const snapshot = JSON.parse(text) as DocumentSnapshot;

    const response: PublicDocument = {
      slug: slugFor(snapshot.title, snapshot.id),
      title: snapshot.title,
      created: snapshot.created,
      excerpt: snapshot.excerpt,
      body: snapshot.body,
    };
    return c.json(response);
  });

  app.get('/entries', async (c) => {
    const entries: PublicEntrySummary[] = [];
    for (const row of reader.list('entry')) {
      const text = await storage.read(row.mirrorKey);
      if (!text) continue;
      const snapshot = JSON.parse(text) as EntrySnapshot;
      entries.push({
        slug: entrySlug(snapshot.created, snapshot.id),
        created: snapshot.created,
        excerpt: snapshot.excerpt,
      });
    }
    const response: PublicEntriesListResponse = { entries };
    return c.json(response);
  });

  app.get('/entries/:slug', async (c) => {
    const slug = c.req.param('slug');
    const suffix = suffixFromSlug(slug);
    const row = suffix ? reader.findBySuffix('entry', suffix) : null;
    if (!row) return c.json(notFound('entry', slug), 404);

    const text = await storage.read(row.mirrorKey);
    if (!text) return c.json(notFound('entry', slug), 404);
    const snapshot = JSON.parse(text) as EntrySnapshot;

    const response: PublicEntry = {
      slug: entrySlug(snapshot.created, snapshot.id),
      created: snapshot.created,
      excerpt: snapshot.excerpt,
      body: snapshot.body,
    };
    return c.json(response);
  });

  app.get('/search', async (c) => {
    const q = c.req.query('q');
    if (q === undefined || q.trim().length === 0) {
      return c.json(invalidRequest("A non-empty 'q' query parameter is required."), 400);
    }

    const rawLimit = c.req.query('limit');
    let limit = DEFAULT_SEARCH_LIMIT;
    if (rawLimit !== undefined && rawLimit !== '') {
      const value = Number(rawLimit);
      if (!Number.isInteger(value) || value < 1 || value > MAX_SEARCH_LIMIT) {
        return c.json(invalidRequest(`'limit' must be a whole number between 1 and ${MAX_SEARCH_LIMIT}.`), 400);
      }
      limit = value;
    }

    // Only ever searches what was deliberately published (`plan.md` M17) —
    // `public_chunks` never contains anything else, so there is no
    // separate check needed here to keep an unpublished item from
    // surfacing.
    const hits: PublicSearchHit[] = [];
    for (const chunkHit of searchReader.search(q, limit)) {
      const row = reader.getBySourceId(chunkHit.sourceType, chunkHit.sourceId);
      if (!row) continue; // unpublished since the chunk was indexed — resync will clear it out
      const text = await storage.read(row.mirrorKey);
      if (!text) continue;

      if (chunkHit.sourceType === 'document') {
        const snapshot = JSON.parse(text) as DocumentSnapshot;
        hits.push({
          sourceType: 'document',
          slug: slugFor(snapshot.title, snapshot.id),
          title: snapshot.title,
          passage: chunkHit.text,
        });
      } else {
        const snapshot = JSON.parse(text) as EntrySnapshot;
        hits.push({
          sourceType: 'entry',
          slug: entrySlug(snapshot.created, snapshot.id),
          created: snapshot.created,
          passage: chunkHit.text,
        });
      }
    }

    const response: PublicSearchResponse = { hits };
    return c.json(response);
  });

  return app;
}
