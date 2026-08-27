import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { PublicApiConfig } from '../config.js';
import { readDocumentBody } from '../frontmatter-reader.js';
import type { PublicDocumentsReader } from '../index-reader.js';
import { slugFor, suffixFromSlug } from '../slug.js';
import type { StorageReader } from '../storage-reader.js';

/**
 * The entire public-facing HTTP surface (`requirements.md` §10, `plan.md`
 * M14). **Read-only** — there is no `POST`, `PUT`, or `DELETE` anywhere in
 * this file, and no auth middleware, because there is nothing here that
 * needs protecting beyond what `PublicDocumentsReader`/`StorageReader`
 * already refuse to serve.
 */

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

function notFound(slug: string) {
  return { error: { code: 'not_found' as const, message: `No document at '${slug}'.` } };
}

export function createApp(reader: PublicDocumentsReader, storage: StorageReader, config: PublicApiConfig): Hono {
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

  app.get('/documents', (c) => {
    const response: PublicDocumentsListResponse = {
      documents: reader.list().map((row) => ({
        slug: slugFor(row.title, row.id),
        title: row.title,
        created: row.created,
        excerpt: row.excerpt,
      })),
    };
    return c.json(response);
  });

  app.get('/documents/:slug', async (c) => {
    const slug = c.req.param('slug');
    const suffix = suffixFromSlug(slug);
    const row = suffix ? reader.findBySuffix(suffix) : null;
    if (!row) return c.json(notFound(slug), 404);

    const text = await storage.read(row.relPath);
    const parsed = text === null ? null : readDocumentBody(text);

    // Defence in depth (`requirements.md` §10): the index said this
    // document is public, but the file itself is the one true answer.
    // If it now disagrees — unpublished a moment ago, edited into
    // unreadability, gone — this never serves content on the strength of
    // the index alone, and the response is identical to "no such slug" so
    // nothing about a just-unpublished document's existence leaks either.
    if (!parsed || !parsed.public) return c.json(notFound(slug), 404);

    const response: PublicDocument = {
      slug: slugFor(row.title, row.id),
      title: row.title,
      created: row.created,
      excerpt: row.excerpt,
      body: parsed.body,
    };
    return c.json(response);
  });

  return app;
}
