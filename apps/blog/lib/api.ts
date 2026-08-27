/**
 * The only way this app reaches anything (`requirements.md` §10, `plan.md`
 * M14) — transport and nothing else, mirroring `apps/web/lib/api.ts`'s own
 * rule for the same reason, even though this app talks to a different,
 * read-only API. There is no write function anywhere in this file, on
 * purpose: this app has nothing to write.
 */

export interface PublicDocumentSummary {
  slug: string;
  title: string;
  created: string;
  excerpt: string;
}

export interface PublicDocument extends PublicDocumentSummary {
  body: string;
}

export interface PublicEntrySummary {
  slug: string;
  created: string;
  excerpt: string;
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

/**
 * Same-origin by default — `next.config.ts`'s rewrite forwards `/api/*` to
 * `apps/public-api` server-side. But every route here is a Server Component
 * (there is no client-side fetch anywhere in this app), which runs in
 * Node — a relative path has no page origin to resolve against there and
 * `fetch` throws immediately. So the base is resolved fresh inside each
 * call, not baked into a module-level constant, exactly the fix
 * `apps/web/lib/api.ts` already needed for its one Server Component
 * (its own doc comment there explains why a `typeof window` check must be
 * evaluated per-call rather than once at module load).
 */
function resolveBase(): string {
  if (process.env.NEXT_PUBLIC_API_URL) return process.env.NEXT_PUBLIC_API_URL;
  if (typeof window === 'undefined') return process.env.PUBLIC_API_INTERNAL_URL ?? 'http://127.0.0.1:4320';
  return '/api';
}

async function request<T>(path: string): Promise<T> {
  const response = await fetch(`${resolveBase()}${path}`, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Request to ${path} failed with status ${response.status}.`);
  }
  return (await response.json()) as T;
}

export async function listPublicDocuments(): Promise<PublicDocumentSummary[]> {
  const { documents } = await request<{ documents: PublicDocumentSummary[] }>('/documents');
  return documents;
}

/** `null` for a slug that resolves to nothing — a normal answer (the
 * document was never public, or no longer is), not a failure. */
export async function getPublicDocument(slug: string): Promise<PublicDocument | null> {
  const response = await fetch(`${resolveBase()}/documents/${encodeURIComponent(slug)}`, { cache: 'no-store' });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Request for '${slug}' failed with status ${response.status}.`);
  }
  return (await response.json()) as PublicDocument;
}

/** Entries alongside documents (`plan.md` M15) — same shape, just no title:
 * an entry's slug is derived from its date instead. */
export async function listPublicEntries(): Promise<PublicEntrySummary[]> {
  const { entries } = await request<{ entries: PublicEntrySummary[] }>('/entries');
  return entries;
}

export async function getPublicEntry(slug: string): Promise<PublicEntry | null> {
  const response = await fetch(`${resolveBase()}/entries/${encodeURIComponent(slug)}`, { cache: 'no-store' });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Request for '${slug}' failed with status ${response.status}.`);
  }
  return (await response.json()) as PublicEntry;
}

/** `plan.md` M17 — searches only what is published, via `apps/public-api`'s
 * own small BM25-only index (`requirements.md` §8, §10). The one function
 * in this file called from a Client Component (`app/search/page.tsx`),
 * since a live search box has no server-rendered equivalent — `resolveBase`
 * already handles being called from either side. */
export async function searchPublic(query: string): Promise<PublicSearchHit[]> {
  const { hits } = await request<{ hits: PublicSearchHit[] }>(`/search?q=${encodeURIComponent(query)}`);
  return hits;
}
