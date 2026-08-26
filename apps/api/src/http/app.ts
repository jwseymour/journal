import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import { authorizationUrl, beginFlow, exchangeCodeForIdentity } from '../auth/google.js';
import { sealFlow, unsealFlow } from '../auth/flow-cookie.js';
import { verifyPassword } from '../auth/password.js';
import { FixedWindowRateLimiter } from '../auth/rate-limit.js';
import { createSessionToken, verifySessionToken } from '../auth/session.js';
import type {
  AddAttachmentResponse,
  ApiError,
  ApproveCategoryRequest,
  CategoriesResponse,
  ChatResponse,
  CreateDocumentResponse,
  CreateEntryResponse,
  Document,
  DocumentPage,
  Entry,
  EntryPage,
  EntryPeriodsResponse,
  HealthResponse,
  ListItemsResponse,
  ListItemUpdateSuggestionsResponse,
  ListsSummaryResponse,
  MetricFieldsResponse,
  MetricFieldSummaryResponse,
  MetricFieldSuggestionsResponse,
  MetricFieldValuesResponse,
  MetricsResponse,
  MetricsSummaryResponse,
  MetricUpdateSuggestionsResponse,
  OpinionStatementsResponse,
  OpinionStatementUpdateSuggestionsResponse,
  OpinionSummariesResponse,
  QuestionsResponse,
  QuestionsSummaryResponse,
  QuestionUpdateSuggestionsResponse,
  ReviewsResponse,
  ReviewsSummaryResponse,
  ReviewUpdateSuggestionsResponse,
  SearchResponse,
  StructureType,
  SuggestionsResponse,
  TranscribeResponse,
  UpdateDocumentResponse,
  UpdateEntryResponse,
} from '@journal/contract';
import type { Config } from '../config.js';
import { AppError, invalidRequest, recordNotFound, unauthorized } from '../errors.js';
import type { CategoriesReader } from '../index/categories-index.js';
import type { ListItemsReader } from '../index/lists-index.js';
import { resolveNumericField, type MetricFieldsReader } from '../index/metric-fields-index.js';
import type { MetricsReader } from '../index/metrics-index.js';
import type { OpinionStatementsReader } from '../index/opinion-statements-index.js';
import type { OpinionSummariesReader } from '../index/opinion-summaries-index.js';
import type { QuestionsReader } from '../index/questions-index.js';
import type { ReviewsReader } from '../index/reviews-index.js';
import type { ChatAnswerer } from '../model/chat-orchestrator.js';
import { isUlid, ulid } from '../record/id.js';
import { nowTimestamp } from '../record/time.js';
import type { Searcher } from '../search/searcher.js';
import type { Transcriber } from '../transcribe/transcriber.js';
import type { DocumentStore } from './../store/document-store.js';
import type { EntryStore } from './../store/entry-store.js';

const STRUCTURE_TYPES: readonly StructureType[] = ['metric', 'review_medium', 'list_type', 'opinion_subject'];

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
const DEFAULT_SEARCH_LIMIT = 20;
/** A month is enough for a small-multiples sparkline (`design.md` §5.3) to
 * show a real pattern without asking the browser to render a year of tiles. */
const METRICS_SUMMARY_WINDOW_DAYS = 30;
/** A generous ceiling on a field-summary window, not a tuned one — a decade
 * comfortably covers "all time" for a personal journal without letting the
 * query be truly unbounded. */
const MAX_FIELD_SUMMARY_WINDOW_DAYS = 3650;

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
  const hosts = new Set([config.host, 'localhost', '127.0.0.1', '[::1]', '::1']);
  if (config.publicUrl) hosts.add(new URL(config.publicUrl).hostname);
  return hosts;
}

/**
 * The redirect URI Google is told to send the browser back to — the
 * frontend's own origin, at the `/api/auth/google/callback` path
 * `next.config.ts`'s rewrite forwards to this route, **not** this API's own
 * `config.publicUrl`. That distinction matters for exactly one reason: the
 * session cookie this callback sets is scoped to whichever origin actually
 * answers the browser's request. If Google redirected the browser straight
 * to this API's own domain, the cookie would land there — but every later
 * request the browser makes goes to the *frontend's* origin (proxied from
 * there to here), so that cookie would never be sent back. Routing the
 * callback back through the same proxy the rest of the app already uses is
 * what keeps the whole flow same-origin from the browser's point of view.
 */
function googleRedirectUri(config: Config): string {
  const webOrigin = config.allowedOrigins[0];
  return new URL('/api/auth/google/callback', webOrigin ?? 'http://localhost:3000').toString();
}

/** Where a failed sign-in sends the browser back to, with a message the
 * login page can actually show — a bare thrown error here would otherwise
 * render as raw JSON on a full-page navigation, which looks exactly like
 * "nothing happened" to whoever is looking at it. */
function loginFailureRedirect(config: Config, message: string): string {
  const webOrigin = config.allowedOrigins[0] ?? 'http://localhost:3000';
  const url = new URL('/login', webOrigin);
  url.searchParams.set('error', message);
  return url.toString();
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

/** A document is directly authored like an entry, never AI-derived, so its
 * `PUT` body is a full replace — every editable field required — not the
 * partial-patch shape the M10 `Update*Schema`s below use. */
const CreateDocumentSchema = z
  .object({
    title: z.string().min(1),
    body: z.string(),
    citedEntries: z.array(z.string()).optional(),
  })
  .strict();

const UpdateDocumentSchema = z
  .object({
    title: z.string().min(1),
    body: z.string(),
    citedEntries: z.array(z.string()).optional(),
    contentHash: z.string().min(1),
  })
  .strict();

const ApproveCategorySchema = z
  .object({
    structureType: z.enum(['metric', 'review_medium', 'list_type', 'opinion_subject']),
    name: z.string().min(1),
  })
  .strict();

const MetricFieldTypeSchema = z.enum(['numeric', 'enum', 'text', 'score']);

const DefineMetricFieldSchema = z
  .object({
    metric: z.string().min(1),
    fieldKey: z.string().min(1),
    label: z.string().min(1),
    fieldType: MetricFieldTypeSchema,
    unit: z.string().min(1).optional(),
    scoreMin: z.number().optional(),
    scoreMax: z.number().optional(),
    description: z.string().min(1),
  })
  .strict();

const ApproveMetricFieldValueSchema = z.object({ value: z.string().min(1) }).strict();

/** `PUT` bodies for the five touchable derived-record types (`plan.md`
 * M10). Every field optional — only what's present changes, the rest is
 * left as stored, same partial-edit shape as `UpdateMetricRequest` and
 * siblings in `@journal/contract`. */
const UpdateMetricSchema = z
  .object({
    detail: z.string().min(1).optional(),
    fields: z.record(z.string(), z.union([z.string(), z.number(), z.null()])).optional(),
    eventTime: z.string().optional(),
    eventTimeExplicit: z.boolean().optional(),
  })
  .strict();

const UpdateReviewSchema = z
  .object({
    title: z.string().min(1).optional(),
    rating: z.number().nullable().optional(),
    progress: z.number().nullable().optional(),
    opinion: z.string().optional(),
    eventTime: z.string().optional(),
    eventTimeExplicit: z.boolean().optional(),
  })
  .strict();

const UpdateListItemSchema = z
  .object({
    text: z.string().min(1).optional(),
    context: z.string().optional(),
    importance: z.number().nullable().optional(),
    eventTime: z.string().optional(),
    eventTimeExplicit: z.boolean().optional(),
  })
  .strict();

const UpdateOpinionStatementSchema = z
  .object({
    statement: z.string().min(1).optional(),
    eventTime: z.string().optional(),
    eventTimeExplicit: z.boolean().optional(),
  })
  .strict();

const UpdateQuestionSchema = z
  .object({
    question: z.string().min(1).optional(),
    eventTime: z.string().optional(),
    eventTimeExplicit: z.boolean().optional(),
  })
  .strict();

/** Parses and validates a `PUT` body against one of the schemas above,
 * throwing the same `invalid_request` shape every other body-validating
 * route in this file throws. Shared because all five follow the identical
 * pattern (`plan.md` M10). */
async function parseUpdateBody<T>(c: { req: { json: () => Promise<unknown> } }, schema: z.ZodType<T>): Promise<T> {
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    throw invalidRequest('The request body is not valid JSON.');
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    const at = issue && issue.path.length > 0 ? ` at '${issue.path.join('.')}'` : '';
    throw invalidRequest(`${issue?.message ?? 'Invalid request body.'}${at}`);
  }
  return parsed.data;
}

function optionalStatus(raw: string | undefined): 'pending' | 'approved' | 'rejected' | undefined {
  if (raw === undefined) return undefined;
  if (!['pending', 'approved', 'rejected'].includes(raw)) {
    throw invalidRequest("'status' must be one of: pending, approved, rejected.");
  }
  return raw as 'pending' | 'approved' | 'rejected';
}

/** Bounds one chat turn's per-request cost — with no persistence (`plan.md`
 * — v1 is ephemeral), the client resends the whole conversation on every
 * turn, so this is the only limit on how large that gets. */
const MAX_CHAT_MESSAGES = 40;

const ChatMessageSchema = z
  .object({
    role: z.enum(['user', 'assistant']),
    content: z.string().min(1),
  })
  .strict();

const ChatRequestSchema = z
  .object({
    messages: z.array(ChatMessageSchema).min(1).max(MAX_CHAT_MESSAGES),
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

function documentResponse(document: {
  id: string;
  title: string;
  created: string;
  updated: string;
  citedEntries?: string[];
  body: string;
  contentHash: string;
}): Document {
  return {
    id: document.id,
    title: document.title,
    created: document.created,
    updated: document.updated,
    ...(document.citedEntries && document.citedEntries.length > 0
      ? { citedEntries: document.citedEntries }
      : {}),
    body: document.body,
    contentHash: document.contentHash,
  };
}

function errorBody(code: ApiError['error']['code'], message: string): ApiError {
  return { error: { code, message } };
}

const SESSION_COOKIE = 'journal_session';
const FLOW_COOKIE = 'journal_oauth_flow';
/** Whether cookies this process sets should carry the `Secure` attribute.
 * Deliberately not tied to `NODE_ENV` — nothing in this deployment ever
 * sets it (not `infra/journal-api.service`, not `.env`), so that check was
 * silently always false in production. `config.publicUrl` is a more
 * direct signal anyway: it's only ever set once this server is genuinely
 * behind a real HTTPS domain (`docs/deployment.md`), which is exactly the
 * condition `Secure` exists to key off. Missing `Secure` doesn't just miss
 * a hardening opportunity here — some browsers (Safari's ITP notably)
 * apply much stricter dropping rules to cookies without it across a
 * cross-site redirect chain, which is exactly the shape of an OAuth flow. */
function secureCookies(config: Config): boolean {
  return config.publicUrl?.startsWith('https://') ?? false;
}

/** One key for the whole process (`plan.md` M11) — this is a single-user
 * system, so limiting the *total* guess rate matters more than trying to
 * attribute attempts to a caller, which a rotated IP defeats anyway. */
const LOGIN_RATE_LIMIT_KEY = 'password-login';
const loginRateLimiter = new FixedWindowRateLimiter(5, 15 * 60 * 1000);

const LoginSchema = z.object({ password: z.string().min(1) }).strict();

export function createApp(
  store: EntryStore,
  documentStore: DocumentStore,
  config: Config,
  transcriber: Transcriber,
  searcher: Searcher,
  metrics: MetricsReader,
  metricFields: MetricFieldsReader,
  reviews: ReviewsReader,
  lists: ListItemsReader,
  categories: CategoriesReader,
  opinionStatements: OpinionStatementsReader,
  opinionSummaries: OpinionSummariesReader,
  questions: QuestionsReader,
  chat: ChatAnswerer,
): Hono {
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

  // Single-user auth boundary (`plan.md` M11). Enforced only when
  // `SESSION_SECRET` is configured — its absence means auth has not been set
  // up yet, the same local-dev-unaffected-by-default posture
  // `STORAGE_BACKEND` takes, not a silent hole in a deployment where it is
  // expected to be set (`config.ts`).
  app.use('*', async (c, next) => {
    if (c.req.path === '/health' || c.req.path.startsWith('/auth/')) return next();
    if (!config.sessionSecret) return next();

    const authHeader = c.req.header('Authorization');
    const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : undefined;
    const usedCookie = bearer === undefined;
    const token = bearer ?? getCookie(c, SESSION_COOKIE);

    const payload = token ? verifySessionToken(config.sessionSecret, token) : null;
    if (!payload || payload.sub !== config.authorizedEmail) {
      return c.json(errorBody('unauthorized', 'Sign in required.'), 401);
    }

    // Tightened specifically for the cookie path (`plan.md` M11): a bearer
    // caller supplies its credential explicitly and is unaffected by CSRF,
    // but a cookie is sent automatically by the browser, so a
    // state-changing cookie-authenticated request with no `Origin` at all is
    // now suspicious rather than the normal "curl has no Origin" case the
    // earlier, looser check (above) was written for.
    const method = c.req.method.toUpperCase();
    if (usedCookie && method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      if (c.req.header('Origin') === undefined) {
        return c.json(
          errorBody('forbidden_origin', 'A state-changing, cookie-authenticated request must carry an Origin header.'),
          403,
        );
      }
    }

    return next();
  });

  app.get('/auth/google/start', async (c) => {
    if (!config.sessionSecret) throw invalidRequest('Auth is not configured on this server.');
    if (!config.googleClientId || !config.googleClientSecret) {
      throw invalidRequest('Google sign-in is not configured on this server.');
    }

    const flow = beginFlow();
    setCookie(c, FLOW_COOKIE, sealFlow(config.sessionSecret, flow), {
      httpOnly: true,
      secure: secureCookies(config),
      sameSite: 'Lax',
      maxAge: 600,
      path: '/',
    });

    const redirectUri = googleRedirectUri(config);
    return c.redirect(authorizationUrl(config.googleClientId, redirectUri, flow));
  });

  app.get('/auth/google/callback', async (c) => {
    if (!config.sessionSecret) throw invalidRequest('Auth is not configured on this server.');
    if (!config.googleClientId || !config.googleClientSecret) {
      throw invalidRequest('Google sign-in is not configured on this server.');
    }

    const code = c.req.query('code');
    const state = c.req.query('state');
    const sealed = getCookie(c, FLOW_COOKIE);
    deleteCookie(c, FLOW_COOKIE, { path: '/' });

    const flow = sealed ? unsealFlow(config.sessionSecret, sealed) : null;
    if (!code || !state || !flow || flow.state !== state) {
      return c.redirect(
        loginFailureRedirect(config, 'The Google sign-in attempt could not be verified. Try again.'),
      );
    }

    let identity;
    try {
      const redirectUri = googleRedirectUri(config);
      identity = await exchangeCodeForIdentity(
        config.googleClientId,
        config.googleClientSecret,
        redirectUri,
        code,
        flow.codeVerifier,
      );
    } catch (cause) {
      console.error('[journal] google token exchange failed', cause);
      return c.redirect(loginFailureRedirect(config, 'Google sign-in failed. Try again.'));
    }

    if (!identity.emailVerified || identity.email !== config.authorizedEmail) {
      return c.redirect(
        loginFailureRedirect(config, 'This Google account is not authorized for this journal.'),
      );
    }

    setCookie(c, SESSION_COOKIE, createSessionToken(config.sessionSecret, config.authorizedEmail), {
      httpOnly: true,
      secure: secureCookies(config),
      sameSite: 'Lax',
      maxAge: 30 * 24 * 60 * 60,
      path: '/',
    });

    const redirectTarget = config.allowedOrigins[0] ?? '/';
    return c.redirect(redirectTarget);
  });

  app.post('/auth/login', async (c) => {
    if (!config.sessionSecret || !config.authPasswordHash) {
      throw invalidRequest('Password sign-in is not configured on this server.');
    }
    if (!loginRateLimiter.attempt(LOGIN_RATE_LIMIT_KEY)) {
      throw unauthorized('Too many attempts. Try again later.');
    }

    const body = await parseUpdateBody(c, LoginSchema);
    const ok = await verifyPassword(config.authPasswordHash, body.password);
    if (!ok) throw unauthorized('Incorrect password.');

    setCookie(c, SESSION_COOKIE, createSessionToken(config.sessionSecret, config.authorizedEmail), {
      httpOnly: true,
      secure: secureCookies(config),
      sameSite: 'Lax',
      maxAge: 30 * 24 * 60 * 60,
      path: '/',
    });
    return c.body(null, 204);
  });

  app.post('/auth/logout', async (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.body(null, 204);
  });

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
    const rawYear = c.req.query('year');
    const rawMonth = c.req.query('month');

    let limit = DEFAULT_LIMIT;
    if (rawLimit !== undefined && rawLimit !== '') {
      const value = Number(rawLimit);
      if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
        throw invalidRequest(`'limit' must be a whole number between 1 and ${MAX_LIMIT}.`);
      }
      limit = value;
    }

    if ((rawYear === undefined) !== (rawMonth === undefined)) {
      throw invalidRequest(`'year' and 'month' must be given together.`);
    }

    let period: { year: number; month: number } | undefined;
    if (rawYear !== undefined && rawMonth !== undefined) {
      const year = Number(rawYear);
      const month = Number(rawMonth);
      if (!Number.isInteger(year) || year < 1) {
        throw invalidRequest(`'year' must be a positive whole number.`);
      }
      if (!Number.isInteger(month) || month < 1 || month > 12) {
        throw invalidRequest(`'month' must be a whole number between 1 and 12.`);
      }
      period = { year, month };
    }

    const result = await store.list({
      limit,
      ...(cursor !== undefined && cursor !== '' ? { cursor } : {}),
      ...(period ?? {}),
    });
    const page: EntryPage = { entries: result.entries, nextCursor: result.nextCursor };
    return c.json(page);
  });

  app.get('/entries/periods', async (c) => {
    const result = await store.listPeriods();
    const response: EntryPeriodsResponse = { periods: result.periods };
    return c.json(response);
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

  app.post('/documents', async (c) => {
    const { title, body, citedEntries } = await parseUpdateBody(c, CreateDocumentSchema);
    const document = await documentStore.create({
      title,
      body,
      ...(citedEntries !== undefined ? { citedEntries } : {}),
    });
    const response: CreateDocumentResponse = {
      id: document.id,
      created: document.created,
      path: document.path,
      contentHash: document.contentHash,
    };
    return c.json(response, 201);
  });

  app.get('/documents', async (c) => {
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

    const result = await documentStore.list({
      limit,
      ...(cursor !== undefined && cursor !== '' ? { cursor } : {}),
    });
    const page: DocumentPage = { documents: result.documents, nextCursor: result.nextCursor };
    return c.json(page);
  });

  app.get('/documents/:id', async (c) => {
    const id = c.req.param('id');
    if (!isUlid(id)) throw recordNotFound('document', id);
    const document = await documentStore.get(id);
    if (!document) throw recordNotFound('document', id);
    return c.json(documentResponse(document));
  });

  app.put('/documents/:id', async (c) => {
    const id = c.req.param('id');
    if (!isUlid(id)) throw recordNotFound('document', id);

    const { title, body, citedEntries, contentHash } = await parseUpdateBody(c, UpdateDocumentSchema);
    const document = await documentStore.update(id, {
      title,
      body,
      contentHash,
      ...(citedEntries !== undefined ? { citedEntries } : {}),
    });
    const response: UpdateDocumentResponse = documentResponse(document);
    return c.json(response);
  });

  app.get('/search', async (c) => {
    const q = c.req.query('q');
    if (q === undefined || q.trim().length === 0) {
      throw invalidRequest("A non-empty 'q' query parameter is required.");
    }

    const rawLimit = c.req.query('limit');
    let limit = DEFAULT_SEARCH_LIMIT;
    if (rawLimit !== undefined && rawLimit !== '') {
      const value = Number(rawLimit);
      if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
        throw invalidRequest(`'limit' must be a whole number between 1 and ${MAX_LIMIT}.`);
      }
      limit = value;
    }

    const hits = await searcher.search(q, limit);
    const response: SearchResponse = { hits };
    return c.json(response);
  });

  app.get('/metrics', async (c) => {
    const metric = c.req.query('metric');
    const rawLimit = c.req.query('limit');

    let limit = DEFAULT_LIMIT;
    if (rawLimit !== undefined && rawLimit !== '') {
      const value = Number(rawLimit);
      if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
        throw invalidRequest(`'limit' must be a whole number between 1 and ${MAX_LIMIT}.`);
      }
      limit = value;
    }

    const records = metrics.list({ limit, ...(metric ? { metric } : {}) });
    const response: MetricsResponse = {
      metrics: records.map((record) => ({
        id: record.id,
        entryId: record.entryId,
        metric: record.metric,
        eventTime: record.eventTime,
        eventTimeExplicit: record.eventTimeExplicit,
        detail: record.detail,
        fields: record.fields,
        touched: record.touched,
      })),
    };
    return c.json(response);
  });

  app.delete('/metrics/:id', async (c) => {
    const id = c.req.param('id');
    // The same tolerance as DELETE /entries/:id: a malformed or already-gone
    // id is simply nothing to do, not an error (`requirements.md` §6.2 —
    // correcting a mistake should be this easy, not fussy about repeats).
    if (isUlid(id)) metrics.remove(id);
    return c.body(null, 204);
  });

  // Touch/edit surface (`plan.md` M10). Unlike DELETE above, PUT carries
  // real content — dropping it silently on a bad id would be worse than the
  // tolerant-no-op convention, so this 404s instead.
  app.put('/metrics/:id', async (c) => {
    const id = c.req.param('id');
    const body = await parseUpdateBody(c, UpdateMetricSchema);
    const updated = metrics.update(id, body, nowTimestamp().canonical);
    if (!updated) throw recordNotFound('metric', id);
    return c.body(null, 204);
  });

  app.post('/metrics/:id/validate', async (c) => {
    const id = c.req.param('id');
    if (isUlid(id)) metrics.validate(id, nowTimestamp().canonical);
    return c.body(null, 204);
  });

  app.post('/metrics/:id/untouch', async (c) => {
    const id = c.req.param('id');
    if (isUlid(id)) metrics.untouch(id, nowTimestamp().canonical);
    return c.body(null, 204);
  });

  app.get('/metrics/update-suggestions', async (c) => {
    const status = optionalStatus(c.req.query('status'));
    const suggestions = metrics.listUpdateSuggestions(status ? { status } : {});
    const response: MetricUpdateSuggestionsResponse = { suggestions };
    return c.json(response);
  });

  app.post('/metrics/update-suggestions/:id/approve', async (c) => {
    metrics.decideUpdate(c.req.param('id'), 'approved', nowTimestamp().canonical);
    return c.body(null, 204);
  });

  app.post('/metrics/update-suggestions/:id/reject', async (c) => {
    metrics.decideUpdate(c.req.param('id'), 'rejected', nowTimestamp().canonical);
    return c.body(null, 204);
  });

  app.get('/metrics/fields', async (c) => {
    const metric = c.req.query('metric');
    const fields = metric ? metricFields.listForMetric(metric) : metricFields.listAll();
    const response: MetricFieldsResponse = {
      fields: fields.map((field) => ({
        id: field.id,
        metric: field.metric,
        fieldKey: field.fieldKey,
        label: field.label,
        fieldType: field.fieldType,
        unit: field.unit,
        scoreMin: field.scoreMin,
        scoreMax: field.scoreMax,
        description: field.description,
      })),
    };
    return c.json(response);
  });

  app.post('/metrics/fields', async (c) => {
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      throw invalidRequest('The request body is not valid JSON.');
    }

    const parsed = DefineMetricFieldSchema.safeParse(json);
    if (!parsed.success) {
      const [issue] = parsed.error.issues;
      const at = issue && issue.path.length > 0 ? ` at '${issue.path.join('.')}'` : '';
      throw invalidRequest(`${issue?.message ?? 'Invalid request body.'}${at}`);
    }

    // The user defining a field directly (`requirements.md` §5.3's second
    // route, extended from category names to fields) — approved
    // immediately, no suggestion or review step.
    // Not matched against `DefineMetricFieldRequest` by type here — Zod's
    // `.optional()` output types an absent field as `string | undefined`,
    // which `exactOptionalPropertyTypes` treats as distinct from "the key
    // is simply not present," even though both parse identically.
    const { metric, fieldKey, label, fieldType, unit, scoreMin, scoreMax, description } = parsed.data;
    metricFields.define({
      id: ulid(Date.now()),
      metric,
      fieldKey,
      label,
      fieldType,
      unit: unit ?? null,
      scoreMin: scoreMin ?? null,
      scoreMax: scoreMax ?? null,
      description,
      now: nowTimestamp().canonical,
    });
    return c.body(null, 204);
  });

  app.delete('/metrics/fields/:id', async (c) => {
    const id = c.req.param('id');
    if (isUlid(id)) metricFields.remove(id);
    return c.body(null, 204);
  });

  app.get('/metrics/fields/suggestions', async (c) => {
    const metric = c.req.query('metric');
    const rawStatus = c.req.query('status');
    if (rawStatus !== undefined && !['pending', 'approved', 'rejected'].includes(rawStatus)) {
      throw invalidRequest("'status' must be one of: pending, approved, rejected.");
    }

    const suggestions = metricFields.listSuggestions({
      ...(metric ? { metric } : {}),
      ...(rawStatus ? { status: rawStatus as 'pending' | 'approved' | 'rejected' } : {}),
    });
    const response: MetricFieldSuggestionsResponse = { suggestions };
    return c.json(response);
  });

  app.post('/metrics/fields/suggestions/:id/approve', async (c) => {
    metricFields.decide(c.req.param('id'), 'approved', nowTimestamp().canonical);
    return c.body(null, 204);
  });

  app.post('/metrics/fields/suggestions/:id/reject', async (c) => {
    metricFields.decide(c.req.param('id'), 'rejected', nowTimestamp().canonical);
    return c.body(null, 204);
  });

  // An enum field's approved values reuse `CategoriesIndex` unchanged, via
  // the `metric_field:<metric>:<fieldKey>` structure-type family — the same
  // suggest/approve mechanism every other open-ended category uses.
  // Suggestions this mechanism produces are decided through the existing
  // `POST /categories/suggestions/:id/{approve,reject}`, which operates
  // purely by suggestion id and needs no change to support them.
  app.get('/metrics/fields/:id/values', async (c) => {
    const field = metricFields.get(c.req.param('id'));
    const emptyResponse: MetricFieldValuesResponse = { values: [] };
    if (!field) return c.json(emptyResponse);
    const response: MetricFieldValuesResponse = {
      values: categories.approvedNames(`metric_field:${field.metric}:${field.fieldKey}`),
    };
    return c.json(response);
  });

  app.post('/metrics/fields/:id/values', async (c) => {
    const field = metricFields.get(c.req.param('id'));
    if (!field) throw invalidRequest('No such field.');
    if (field.fieldType !== 'enum') throw invalidRequest('Only an enum-typed field has approved values.');

    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      throw invalidRequest('The request body is not valid JSON.');
    }
    const parsed = ApproveMetricFieldValueSchema.safeParse(json);
    if (!parsed.success) {
      const [issue] = parsed.error.issues;
      const at = issue && issue.path.length > 0 ? ` at '${issue.path.join('.')}'` : '';
      throw invalidRequest(`${issue?.message ?? 'Invalid request body.'}${at}`);
    }

    categories.approveDirectly(`metric_field:${field.metric}:${field.fieldKey}`, parsed.data.value, nowTimestamp().canonical);
    return c.body(null, 204);
  });

  app.get('/metrics/fields/:id/values/suggestions', async (c) => {
    const field = metricFields.get(c.req.param('id'));
    if (!field) return c.json({ suggestions: [] });
    const rawStatus = c.req.query('status');
    if (rawStatus !== undefined && !['pending', 'approved', 'rejected'].includes(rawStatus)) {
      throw invalidRequest("'status' must be one of: pending, approved, rejected.");
    }
    const suggestions = categories.listSuggestions({
      structureType: `metric_field:${field.metric}:${field.fieldKey}`,
      ...(rawStatus ? { status: rawStatus as 'pending' | 'approved' | 'rejected' } : {}),
    });
    const response: SuggestionsResponse = { suggestions };
    return c.json(response);
  });

  app.get('/reviews', async (c) => {
    const medium = c.req.query('medium');
    const rawLimit = c.req.query('limit');

    let limit = DEFAULT_LIMIT;
    if (rawLimit !== undefined && rawLimit !== '') {
      const value = Number(rawLimit);
      if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
        throw invalidRequest(`'limit' must be a whole number between 1 and ${MAX_LIMIT}.`);
      }
      limit = value;
    }

    const records = reviews.list({ limit, ...(medium ? { medium } : {}) });
    const response: ReviewsResponse = {
      reviews: records.map((record) => ({
        id: record.id,
        entryId: record.entryId,
        title: record.title,
        medium: record.medium,
        rating: record.rating,
        progress: record.progress,
        opinion: record.opinion,
        eventTime: record.eventTime,
        eventTimeExplicit: record.eventTimeExplicit,
        touched: record.touched,
      })),
    };
    return c.json(response);
  });

  app.delete('/reviews/:id', async (c) => {
    const id = c.req.param('id');
    if (isUlid(id)) reviews.remove(id);
    return c.body(null, 204);
  });

  app.put('/reviews/:id', async (c) => {
    const id = c.req.param('id');
    const body = await parseUpdateBody(c, UpdateReviewSchema);
    const updated = reviews.update(id, body, nowTimestamp().canonical);
    if (!updated) throw recordNotFound('review', id);
    return c.body(null, 204);
  });

  app.post('/reviews/:id/validate', async (c) => {
    const id = c.req.param('id');
    if (isUlid(id)) reviews.validate(id, nowTimestamp().canonical);
    return c.body(null, 204);
  });

  app.post('/reviews/:id/untouch', async (c) => {
    const id = c.req.param('id');
    if (isUlid(id)) reviews.untouch(id, nowTimestamp().canonical);
    return c.body(null, 204);
  });

  app.get('/reviews/update-suggestions', async (c) => {
    const status = optionalStatus(c.req.query('status'));
    const suggestions = reviews.listUpdateSuggestions(status ? { status } : {});
    const response: ReviewUpdateSuggestionsResponse = { suggestions };
    return c.json(response);
  });

  app.post('/reviews/update-suggestions/:id/approve', async (c) => {
    reviews.decideUpdate(c.req.param('id'), 'approved', nowTimestamp().canonical);
    return c.body(null, 204);
  });

  app.post('/reviews/update-suggestions/:id/reject', async (c) => {
    reviews.decideUpdate(c.req.param('id'), 'rejected', nowTimestamp().canonical);
    return c.body(null, 204);
  });

  app.get('/lists', async (c) => {
    const listType = c.req.query('listType');
    const rawLimit = c.req.query('limit');
    const rawOrderBy = c.req.query('orderBy');

    let limit = DEFAULT_LIMIT;
    if (rawLimit !== undefined && rawLimit !== '') {
      const value = Number(rawLimit);
      if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
        throw invalidRequest(`'limit' must be a whole number between 1 and ${MAX_LIMIT}.`);
      }
      limit = value;
    }

    if (rawOrderBy !== undefined && rawOrderBy !== 'recent' && rawOrderBy !== 'importance') {
      throw invalidRequest(`'orderBy' must be 'recent' or 'importance'.`);
    }
    const orderBy = rawOrderBy as 'recent' | 'importance' | undefined;

    const records = lists.list({ limit, ...(listType ? { listType } : {}), ...(orderBy ? { orderBy } : {}) });
    const response: ListItemsResponse = {
      items: records.map((record) => ({
        id: record.id,
        entryId: record.entryId,
        listType: record.listType,
        text: record.text,
        context: record.context,
        importance: record.importance,
        eventTime: record.eventTime,
        eventTimeExplicit: record.eventTimeExplicit,
        touched: record.touched,
      })),
    };
    return c.json(response);
  });

  app.delete('/lists/:id', async (c) => {
    const id = c.req.param('id');
    if (isUlid(id)) lists.remove(id);
    return c.body(null, 204);
  });

  app.put('/lists/:id', async (c) => {
    const id = c.req.param('id');
    const body = await parseUpdateBody(c, UpdateListItemSchema);
    const updated = lists.update(id, body, nowTimestamp().canonical);
    if (!updated) throw recordNotFound('list item', id);
    return c.body(null, 204);
  });

  app.post('/lists/:id/validate', async (c) => {
    const id = c.req.param('id');
    if (isUlid(id)) lists.validate(id, nowTimestamp().canonical);
    return c.body(null, 204);
  });

  app.post('/lists/:id/untouch', async (c) => {
    const id = c.req.param('id');
    if (isUlid(id)) lists.untouch(id, nowTimestamp().canonical);
    return c.body(null, 204);
  });

  app.get('/lists/update-suggestions', async (c) => {
    const status = optionalStatus(c.req.query('status'));
    const suggestions = lists.listUpdateSuggestions(status ? { status } : {});
    const response: ListItemUpdateSuggestionsResponse = { suggestions };
    return c.json(response);
  });

  app.post('/lists/update-suggestions/:id/approve', async (c) => {
    lists.decideUpdate(c.req.param('id'), 'approved', nowTimestamp().canonical);
    return c.body(null, 204);
  });

  app.post('/lists/update-suggestions/:id/reject', async (c) => {
    lists.decideUpdate(c.req.param('id'), 'rejected', nowTimestamp().canonical);
    return c.body(null, 204);
  });

  app.get('/opinions/statements', async (c) => {
    const subject = c.req.query('subject');
    const rawLimit = c.req.query('limit');

    let limit = DEFAULT_LIMIT;
    if (rawLimit !== undefined && rawLimit !== '') {
      const value = Number(rawLimit);
      if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
        throw invalidRequest(`'limit' must be a whole number between 1 and ${MAX_LIMIT}.`);
      }
      limit = value;
    }

    const records = opinionStatements.list({ limit, ...(subject ? { subject } : {}) });
    const response: OpinionStatementsResponse = {
      statements: records.map((record) => ({
        id: record.id,
        entryId: record.entryId,
        subject: record.subject,
        statement: record.statement,
        eventTime: record.eventTime,
        eventTimeExplicit: record.eventTimeExplicit,
        touched: record.touched,
      })),
    };
    return c.json(response);
  });

  app.delete('/opinions/statements/:id', async (c) => {
    const id = c.req.param('id');
    // The same tolerance as every other correction endpoint
    // (`requirements.md` §6.2).
    if (isUlid(id)) opinionStatements.remove(id);
    return c.body(null, 204);
  });

  app.put('/opinions/statements/:id', async (c) => {
    const id = c.req.param('id');
    const body = await parseUpdateBody(c, UpdateOpinionStatementSchema);
    const updated = opinionStatements.update(id, body, nowTimestamp().canonical);
    if (!updated) throw recordNotFound('opinion statement', id);
    return c.body(null, 204);
  });

  app.post('/opinions/statements/:id/validate', async (c) => {
    const id = c.req.param('id');
    if (isUlid(id)) opinionStatements.validate(id, nowTimestamp().canonical);
    return c.body(null, 204);
  });

  app.post('/opinions/statements/:id/untouch', async (c) => {
    const id = c.req.param('id');
    if (isUlid(id)) opinionStatements.untouch(id, nowTimestamp().canonical);
    return c.body(null, 204);
  });

  app.get('/opinions/statements/update-suggestions', async (c) => {
    const status = optionalStatus(c.req.query('status'));
    const suggestions = opinionStatements.listUpdateSuggestions(status ? { status } : {});
    const response: OpinionStatementUpdateSuggestionsResponse = { suggestions };
    return c.json(response);
  });

  app.post('/opinions/statements/update-suggestions/:id/approve', async (c) => {
    opinionStatements.decideUpdate(c.req.param('id'), 'approved', nowTimestamp().canonical);
    return c.body(null, 204);
  });

  app.post('/opinions/statements/update-suggestions/:id/reject', async (c) => {
    opinionStatements.decideUpdate(c.req.param('id'), 'rejected', nowTimestamp().canonical);
    return c.body(null, 204);
  });

  app.get('/opinions/summaries', async (c) => {
    const subject = c.req.query('subject');
    const parts = opinionSummaries.list(subject);

    // Grouped by subject, in generation order — a summary is meaningless
    // split across entries, unlike every other list endpoint here.
    const bySubject = new Map<string, typeof parts>();
    for (const part of parts) {
      const existing = bySubject.get(part.subject);
      if (existing) existing.push(part);
      else bySubject.set(part.subject, [part]);
    }

    const response: OpinionSummariesResponse = {
      summaries: [...bySubject.entries()].map(([subjectName, subjectParts]) => ({
        subject: subjectName,
        generatedAt: subjectParts[0]?.generatedAt ?? '',
        parts: subjectParts.map((part) => ({
          text: part.text,
          sourceStatementIds: part.sourceStatementIds,
          sourceEntryIds: part.sourceEntryIds,
        })),
      })),
    };
    return c.json(response);
  });

  app.get('/questions', async (c) => {
    const rawStatus = c.req.query('status');
    if (rawStatus !== undefined && rawStatus !== 'open' && rawStatus !== 'resolved') {
      throw invalidRequest(`'status' must be 'open' or 'resolved'.`);
    }
    const status = rawStatus as 'open' | 'resolved' | undefined;

    const rawLimit = c.req.query('limit');
    let limit = DEFAULT_LIMIT;
    if (rawLimit !== undefined && rawLimit !== '') {
      const value = Number(rawLimit);
      if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
        throw invalidRequest(`'limit' must be a whole number between 1 and ${MAX_LIMIT}.`);
      }
      limit = value;
    }

    const records = questions.list({ limit, ...(status ? { status } : {}) });
    const response: QuestionsResponse = {
      questions: records.map((record) => ({
        id: record.id,
        entryId: record.entryId,
        question: record.question,
        eventTime: record.eventTime,
        eventTimeExplicit: record.eventTimeExplicit,
        status: record.status,
        resolvedEntryId: record.resolvedEntryId,
        resolution: record.resolution,
        touched: record.touched,
      })),
    };
    return c.json(response);
  });

  app.delete('/questions/:id', async (c) => {
    const id = c.req.param('id');
    // The same tolerance as every other correction endpoint
    // (`requirements.md` §6.2).
    if (isUlid(id)) questions.remove(id);
    return c.body(null, 204);
  });

  app.post('/questions/:id/reopen', async (c) => {
    const id = c.req.param('id');
    if (isUlid(id)) questions.reopen(id);
    return c.body(null, 204);
  });

  app.put('/questions/:id', async (c) => {
    const id = c.req.param('id');
    const body = await parseUpdateBody(c, UpdateQuestionSchema);
    const updated = questions.update(id, body, nowTimestamp().canonical);
    if (!updated) throw recordNotFound('question', id);
    return c.body(null, 204);
  });

  app.post('/questions/:id/validate', async (c) => {
    const id = c.req.param('id');
    if (isUlid(id)) questions.validate(id, nowTimestamp().canonical);
    return c.body(null, 204);
  });

  app.post('/questions/:id/untouch', async (c) => {
    const id = c.req.param('id');
    if (isUlid(id)) questions.untouch(id, nowTimestamp().canonical);
    return c.body(null, 204);
  });

  app.get('/questions/update-suggestions', async (c) => {
    const status = optionalStatus(c.req.query('status'));
    const suggestions = questions.listUpdateSuggestions(status ? { status } : {});
    const response: QuestionUpdateSuggestionsResponse = { suggestions };
    return c.json(response);
  });

  app.post('/questions/update-suggestions/:id/approve', async (c) => {
    questions.decideUpdate(c.req.param('id'), 'approved', nowTimestamp().canonical);
    return c.body(null, 204);
  });

  app.post('/questions/update-suggestions/:id/reject', async (c) => {
    questions.decideUpdate(c.req.param('id'), 'rejected', nowTimestamp().canonical);
    return c.body(null, 204);
  });

  app.get('/categories', async (c) => {
    const response: CategoriesResponse = {
      metric: categories.approvedNames('metric'),
      review_medium: categories.approvedNames('review_medium'),
      list_type: categories.approvedNames('list_type'),
      opinion_subject: categories.approvedNames('opinion_subject'),
    };
    return c.json(response);
  });

  app.post('/categories', async (c) => {
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      throw invalidRequest('The request body is not valid JSON.');
    }

    const parsed = ApproveCategorySchema.safeParse(json);
    if (!parsed.success) {
      const [issue] = parsed.error.issues;
      const at = issue && issue.path.length > 0 ? ` at '${issue.path.join('.')}'` : '';
      throw invalidRequest(`${issue?.message ?? 'Invalid request body.'}${at}`);
    }

    // The user requesting a category directly (`requirements.md` §5.3's
    // second route) — approved immediately, no suggestion or review step.
    // 204, not 201: there is no server-generated representation to hand
    // back (unlike an entry's id and hash) — the caller already knows
    // exactly what it asked to approve, the same reasoning that makes
    // `POST /categories/suggestions/:id/approve` a 204 too.
    const { structureType, name } = parsed.data satisfies ApproveCategoryRequest;
    categories.approveDirectly(structureType, name, nowTimestamp().canonical);
    return c.body(null, 204);
  });

  app.get('/categories/suggestions', async (c) => {
    const rawStructureType = c.req.query('structureType');
    if (rawStructureType !== undefined && !STRUCTURE_TYPES.includes(rawStructureType as StructureType)) {
      throw invalidRequest(`'structureType' must be one of: ${STRUCTURE_TYPES.join(', ')}.`);
    }
    const rawStatus = c.req.query('status');
    if (rawStatus !== undefined && !['pending', 'approved', 'rejected'].includes(rawStatus)) {
      throw invalidRequest("'status' must be one of: pending, approved, rejected.");
    }

    const suggestions = categories.listSuggestions({
      ...(rawStructureType ? { structureType: rawStructureType as StructureType } : {}),
      ...(rawStatus ? { status: rawStatus as 'pending' | 'approved' | 'rejected' } : {}),
    });
    // An explicit filter is already validated against the 4 core types
    // above, so this only ever trims the unfiltered case: metric-field enum
    // value suggestions share this same table (they reuse `CategoriesIndex`
    // unchanged), but belong to the dedicated
    // `/metrics/fields/:id/values/suggestions` surface, not this one.
    const filtered = rawStructureType
      ? suggestions
      : suggestions.filter((s) => STRUCTURE_TYPES.includes(s.structureType));
    const response: SuggestionsResponse = { suggestions: filtered };
    return c.json(response);
  });

  app.post('/categories/suggestions/:id/approve', async (c) => {
    categories.decide(c.req.param('id'), 'approved', nowTimestamp().canonical);
    return c.body(null, 204);
  });

  app.post('/categories/suggestions/:id/reject', async (c) => {
    categories.decide(c.req.param('id'), 'rejected', nowTimestamp().canonical);
    return c.body(null, 204);
  });

  // Aggregated, not raw — the analysis surfaces' own material
  // (`plan.md` M8, `design.md` §5.3). Computed here, never in the frontend
  // (`requirements.md` §7.1).
  app.get('/analysis/metrics', async (c) => {
    const approvedNames = categories.approvedNames('metric');
    const summaries = metrics.summarize(approvedNames, METRICS_SUMMARY_WINDOW_DAYS);
    const response: MetricsSummaryResponse = { summaries, windowDays: METRICS_SUMMARY_WINDOW_DAYS };
    return c.json(response);
  });

  app.get('/analysis/metrics/:metric/fields/:fieldKey', async (c) => {
    const metric = c.req.param('metric');
    const fieldKey = c.req.param('fieldKey');
    const field = resolveNumericField(metricFields, metric, fieldKey);
    if (!field) throw invalidRequest('No such field, or it is not a numeric or score field that can be summed.');

    const rawFilter = c.req.query('filter');
    let filter: { field: string; value: string } | undefined;
    if (rawFilter !== undefined && rawFilter !== '') {
      const separator = rawFilter.indexOf(':');
      if (separator <= 0 || separator === rawFilter.length - 1) {
        throw invalidRequest("'filter' must be in the form field:value.");
      }
      filter = { field: rawFilter.slice(0, separator), value: rawFilter.slice(separator + 1) };
    }

    const rawWindowDays = c.req.query('windowDays');
    let windowDays = METRICS_SUMMARY_WINDOW_DAYS;
    if (rawWindowDays !== undefined && rawWindowDays !== '') {
      const value = Number(rawWindowDays);
      if (!Number.isInteger(value) || value < 1 || value > MAX_FIELD_SUMMARY_WINDOW_DAYS) {
        throw invalidRequest(`'windowDays' must be a whole number between 1 and ${MAX_FIELD_SUMMARY_WINDOW_DAYS}.`);
      }
      windowDays = value;
    }

    const summary = metrics.sumByField(metric, fieldKey, windowDays, filter);
    const response: MetricFieldSummaryResponse = {
      metric,
      fieldKey,
      unit: field.unit,
      filter: filter ?? null,
      total: summary.total,
      average: summary.average,
      count: summary.count,
      windowDays,
      days: summary.days,
    };
    return c.json(response);
  });

  app.get('/analysis/reviews', async (c) => {
    const approvedMedia = categories.approvedNames('review_medium');
    const response: ReviewsSummaryResponse = { summaries: reviews.summarize(approvedMedia) };
    return c.json(response);
  });

  app.get('/analysis/lists', async (c) => {
    const approvedTypes = categories.approvedNames('list_type');
    const response: ListsSummaryResponse = { summaries: lists.summarize(approvedTypes) };
    return c.json(response);
  });

  app.get('/analysis/questions', async (c) => {
    const response: QuestionsSummaryResponse = questions.summarize();
    return c.json(response);
  });

  // Ephemeral — no conversation is stored server-side (`plan.md` — v1 has no
  // chat persistence). The client sends the whole conversation so far on
  // every turn, and this route holds none of it once the response is sent.
  app.post('/chat', async (c) => {
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      throw invalidRequest('The request body is not valid JSON.');
    }

    const parsed = ChatRequestSchema.safeParse(json);
    if (!parsed.success) {
      const [issue] = parsed.error.issues;
      const at = issue && issue.path.length > 0 ? ` at '${issue.path.join('.')}'` : '';
      throw invalidRequest(`${issue?.message ?? 'Invalid request body.'}${at}`);
    }

    const { messages } = parsed.data;
    if (messages[messages.length - 1]!.role !== 'user') {
      throw invalidRequest('The conversation must end with a user message.');
    }

    const response: ChatResponse = await chat.answer(messages);
    return c.json(response);
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
