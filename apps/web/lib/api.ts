import type {
  ApiError,
  ApiErrorCode,
  CreateEntryRequest,
  CreateEntryResponse,
  Entry,
  EntryPage,
  UpdateEntryRequest,
  UpdateEntryResponse,
} from '@journal/contract';

/**
 * The only way this frontend reaches anything.
 *
 * Transport and nothing else — no parsing, no aggregation, no decisions about
 * entries. All of that lives behind the API (`requirements.md` §7.1,
 * `design.md` §6.3).
 *
 * It goes over HTTP even though both processes sit on the same machine. That is
 * the point: running locally does not license a shortcut across the boundary,
 * because going online later must be a deployment change rather than a rewrite
 * (`design.md` §6.4, `requirements.md` §7.2).
 */

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://127.0.0.1:4319';

/** A failure that reached us as a structured error, or as no response at all. */
export class ApiRequestError extends Error {
  readonly code: ApiErrorCode | 'unreachable';

  constructor(code: ApiErrorCode | 'unreachable', message: string) {
    super(message);
    this.name = 'ApiRequestError';
    this.code = code;
  }
}

const UNREACHABLE =
  'The journal backend is not answering. Start it with `npm run dev:api` and reload.';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      // Never a cached read. What is on disk is the truth, and a journal must
      // not show a stale copy of it.
      cache: 'no-store',
    });
  } catch {
    throw new ApiRequestError('unreachable', UNREACHABLE);
  }

  if (!response.ok) {
    let code: ApiErrorCode = 'internal';
    let message = `The request failed (${response.status}).`;
    try {
      const body = (await response.json()) as ApiError;
      if (body?.error?.code) {
        code = body.error.code;
        message = body.error.message;
      }
    } catch {
      /* a response with no structured body; the status is all we have */
    }
    throw new ApiRequestError(code, message);
  }

  // 204 No Content — DELETE's response. There is no body to parse.
  if (response.status === 204) return undefined as T;

  return (await response.json()) as T;
}

export function listEntries(options: { cursor?: string; limit?: number } = {}): Promise<EntryPage> {
  const query = new URLSearchParams();
  if (options.cursor) query.set('cursor', options.cursor);
  if (options.limit !== undefined) query.set('limit', String(options.limit));
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return request<EntryPage>(`/entries${suffix}`);
}

/** `null` for an entry that is not there, which is a normal answer, not a failure. */
export async function getEntry(id: string): Promise<Entry | null> {
  try {
    return await request<Entry>(`/entries/${encodeURIComponent(id)}`);
  } catch (error) {
    if (error instanceof ApiRequestError && error.code === 'entry_not_found') return null;
    throw error;
  }
}

export function createEntry(entry: CreateEntryRequest): Promise<CreateEntryResponse> {
  return request<CreateEntryResponse>('/entries', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(entry),
  });
}

/**
 * Change an entry's body. Throws `ApiRequestError` with code `edit_conflict`
 * if `input.contentHash` no longer matches what is on disk — the caller must
 * treat that as "stop and tell the user," never retry with the same hash.
 */
export function updateEntry(id: string, input: UpdateEntryRequest): Promise<UpdateEntryResponse> {
  return request<UpdateEntryResponse>(`/entries/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

/**
 * The one narrow deletion the format allows: discard a draft that turned out
 * to be whitespace-only (`format.md` §5). Never a general-purpose delete —
 * the backend itself refuses to remove anything with real content in it.
 */
export async function discardEntry(id: string): Promise<void> {
  await request<undefined>(`/entries/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
