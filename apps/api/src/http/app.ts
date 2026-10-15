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
  ApproveBatchResponse,
  ApproveCategoryRequest,
  CategoriesResponse,
  ChatResponse,
  CreateDocumentResponse,
  CreateEntryResponse,
  Document,
  DocumentPage,
  Entry,
  EntryMediaResponse,
  EntryPage,
  EntryPeriodsResponse,
  EntryStatusResponse,
  HealthResponse,
  ListItemsResponse,
  ListItemUpdateSuggestionsResponse,
  ListsSummaryResponse,
  CompileLayoutResponse,
  Layout,
  LayoutsResponse,
  LayoutSurface,
  MediaPage,
  MetricFieldsResponse,
  MetricFieldSummaryResponse,
  MetricFieldSuggestionsResponse,
  MetricFieldValuesResponse,
  MetricsResponse,
  MetricsSummaryResponse,
  MetricUpdateSuggestionsResponse,
  OpinionStatementsResponse,
  OpinionStatementUpdateSuggestionsResponse,
  OpinionSubjectSummariesResponse,
  OpinionSummariesResponse,
  PendingItemsResponse,
  ProcessEntryResponse,
  PublishDocumentResponse,
  PublishQueueResponse,
  QuestionsResponse,
  QuestionsSummaryResponse,
  QuestionUpdateSuggestionsResponse,
  ParseLayoutResponse,
  ResolvedLayout,
  SetDefaultLayoutResponse,
  ReviewsHistogramResponse,
  ReviewsResponse,
  ReviewsSummaryResponse,
  ReviewUpdateSuggestionsResponse,
  SearchResponse,
  StructureType,
  SuggestionsResponse,
  UpdateMetricFieldResponse,
  VisibilityDefaultsResponse,
  Todo,
  TodoCompletionSuggestionsResponse,
  TodosResponse,
  TodosSummaryResponse,
  TodoUpdateSuggestionsResponse,
  TranscribeResponse,
  UpdateDocumentResponse,
  UpdateEntryResponse,
  UploadMediaResponse,
} from '@journal/contract';
import type { Config } from '../config.js';
import {
  AppError,
  editConflict,
  invalidRequest,
  layoutInvalid,
  layoutNotFound,
  recordNotFound,
  unauthorized,
  unsupportedMediaType,
} from '../errors.js';
import { buildAnalysisCatalog } from '../layout/catalog.js';
import type { LayoutCompiling } from '../layout/compile.js';
import { parseLayout } from '../layout/parse.js';
import { legacyPrefsToSyntax, type LegacyAnalysisPrefs } from '../layout/legacy-prefs.js';
import { parseAndCanonicalise, renderAnalysisLayout } from '../layout/render.js';
import type { LayoutsReader } from '../index/layouts-index.js';
import type { LayoutStore } from '../store/layout-store.js';
import type { CategoriesReader, CoreStructureType } from '../index/categories-index.js';
import type { EntryProcessingStatusReader } from '../index/entry-processing-status-index.js';
import type { ListItemsReader } from '../index/lists-index.js';
import { resolveNumericField, type MetricFieldsReader } from '../index/metric-fields-index.js';
import type { MetricsReader } from '../index/metrics-index.js';
import type { OpinionStatementsReader } from '../index/opinion-statements-index.js';
import type { OpinionSummariesReader } from '../index/opinion-summaries-index.js';
import type { PendingItemsReader } from '../index/pending-items-index.js';
import type { PublishableSourceType } from '../index/published-index.js';
import type { QuestionsReader } from '../index/questions-index.js';
import type { ReviewsReader } from '../index/reviews-index.js';
import type { TodosReader } from '../index/todos-index.js';
import type { VisibilityDefaultsReader } from '../index/visibility-defaults-index.js';
import type { TouchedMirror } from '../durable/touched-mirror.js';
import type { ChatAnswerer } from '../model/chat-orchestrator.js';
import type { PendingItemApplying } from '../model/pending-item-applier.js';
import type { LivePendingProcessing } from '../model/pending-processor.js';
import type { Publisher } from '../publish/publisher.js';
import { attachmentContentType } from '../record/attachment-content-type.js';
import { isUlid, ulid } from '../record/id.js';
import { isSupportedMediaContentType, mediaRelativePath } from '../record/media-filename.js';
import { nowTimestamp, parseTimestamp } from '../record/time.js';
import type { Searcher } from '../search/searcher.js';
import type { Transcriber } from '../transcribe/transcriber.js';
import type { DocumentStore } from './../store/document-store.js';
import type { EntryStore } from './../store/entry-store.js';
import type { MediaStore } from './../store/media-store.js';

const STRUCTURE_TYPES: readonly StructureType[] = ['metric', 'review_medium', 'list_type', 'opinion_subject'];

/** Same ceiling as an entry attachment — video pushes closer to it than a
 * photo ever will, but this is a personal-scale library on a small host,
 * not a place for an unbounded upload. */
const MAX_MEDIA_BYTES = 200 * 1024 * 1024;

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

/** Shared `?windowDays=` parsing for every windowed analysis route — the
 * field-summary endpoint had this inline first; `/analysis/metrics` grew
 * the identical need once the analysis page's shared time-window control
 * (`design.md` §5.3) needed month/year views, not just the fixed 30-day
 * default. Same ceiling, same validation message, one place to keep them
 * agreeing. */
function parseWindowDays(c: { req: { query: (key: string) => string | undefined } }, fallback: number): number {
  const raw = c.req.query('windowDays');
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_FIELD_SUMMARY_WINDOW_DAYS) {
    throw invalidRequest(`'windowDays' must be a whole number between 1 and ${MAX_FIELD_SUMMARY_WINDOW_DAYS}.`);
  }
  return value;
}

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

/** Attaching an existing media-library item to an entry, rather than
 * uploading fresh bytes (`plan.md` M19). */
const AttachMediaSchema = z.object({ mediaId: z.string().min(1) }).strict();

const RenderLayoutRequestSchema = z
  .object({
    layoutId: z.string().min(1).optional(),
    syntax: z.string().optional(),
    windowDays: z.number().int().positive().optional(),
  })
  .strict();

const ApproveCategorySchema = z
  .object({
    structureType: z.enum(['metric', 'review_medium', 'list_type', 'opinion_subject']),
    name: z.string().min(1),
  })
  .strict();

/** Setting a category's "public by default" flag (`requirements.md` §11,
 * `plan.md` M16) — the same four core structure types `ApproveCategorySchema`
 * validates against; questions have no category and so never appear here. */
const SetVisibilityDefaultSchema = z
  .object({
    structureType: z.enum(['metric', 'review_medium', 'list_type', 'opinion_subject']),
    category: z.string().min(1),
    defaultPublic: z.boolean(),
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

/** Editing a field already defined (`PATCH /metrics/fields/:id`) —
 * everything optional, `metric`/`fieldKey`/`fieldType` deliberately absent
 * (`UpdateFieldInput`'s own comment). `.nullable().optional()` on `unit`
 * and the score bounds, same convention `UpdateReviewSchema.rating`
 * already uses, so a caller can explicitly clear one rather than only ever
 * being able to set it. */
const UpdateMetricFieldSchema = z
  .object({
    label: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    unit: z.string().min(1).nullable().optional(),
    scoreMin: z.number().nullable().optional(),
    scoreMax: z.number().nullable().optional(),
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

const UpdateTodoSchema = z
  .object({
    text: z.string().min(1).optional(),
    eventTime: z.string().optional(),
    eventTimeExplicit: z.boolean().optional(),
  })
  .strict();

/** A to-do created directly in the UI, not extracted — the deliberate
 * exception to every other structure type, which only ever originates from
 * an entry (`requirements.md` §2, §11). */
const CreateTodoSchema = z.object({ text: z.string().min(1) }).strict();

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

function entryResponse(
  entry: {
    id: string;
    created: string;
    location?: { lat: number; lon: number };
    body: string;
    contentHash: string;
  },
  published: boolean,
): Entry {
  return {
    id: entry.id,
    created: entry.created,
    ...(entry.location ? { location: entry.location } : {}),
    published,
    body: entry.body,
    contentHash: entry.contentHash,
  };
}

/** `published` is passed in rather than read off `document`, because the
 * store never knows it — it comes from `Publisher.isPublished`
 * (`requirements.md` §9.3, `plan.md` M15). */
function documentResponse(
  document: {
    id: string;
    title: string;
    created: string;
    updated: string;
    citedEntries?: string[];
    body: string;
    contentHash: string;
  },
  published: boolean,
): Document {
  return {
    id: document.id,
    title: document.title,
    created: document.created,
    updated: document.updated,
    ...(document.citedEntries && document.citedEntries.length > 0
      ? { citedEntries: document.citedEntries }
      : {}),
    published,
    body: document.body,
    contentHash: document.contentHash,
  };
}

function errorBody(code: ApiError['error']['code'], message: string): ApiError {
  return { error: { code, message } };
}

/** The bare filename a media-library item lands under once attached to an
 * entry (`plan.md` M19) — `<id>.<ext>`, never the uploader's own
 * `originalFilename`, so this is always a valid attachment filename with no
 * validation surface to get wrong (`mediaRelativePath` already threw at
 * upload time if the content type were unsupported). */
function attachmentFilenameForMedia(media: { id: string; contentType: string }): string {
  const path = mediaRelativePath(media.id, media.contentType);
  return path.slice(path.lastIndexOf('/') + 1);
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
  mediaStore: MediaStore,
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
  todos: TodosReader,
  pendingProcessor: LivePendingProcessing,
  pendingItems: PendingItemsReader,
  pendingItemApplier: PendingItemApplying,
  entryProcessingStatus: EntryProcessingStatusReader,
  chat: ChatAnswerer,
  publisher: Publisher,
  visibilityDefaults: VisibilityDefaultsReader,
  touchedMirror: TouchedMirror,
  layoutStore: LayoutStore,
  layouts: LayoutsReader,
  layoutCompiler: LayoutCompiling,
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
    return c.json(entryResponse(entry, publisher.isPublished('entry', entry.id)));
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
    // If this entry is currently published, the mirror copy is kept in
    // sync inline — a published entry that changes should never silently
    // drift from what the public surface serves (`plan.md` M15).
    await publisher.resyncIfPublished('entry', id);
    const response: UpdateEntryResponse = entryResponse(entry, publisher.isPublished('entry', entry.id));
    return c.json(response);
  });

  app.delete('/entries/:id', async (c) => {
    const id = c.req.param('id');
    // Deleting something that was never there is not an error — see
    // EntryStore.discardIfBlank. A malformed id is simply "nothing to do."
    if (isUlid(id)) await store.discardIfBlank(id);
    return c.body(null, 204);
  });

  // Visibility (`requirements.md` §9.3, §11, `plan.md` M15) — an entry
  // never carries a field for this (§4.3's "nothing else" is absolute); a
  // publish/unpublish action route, tolerant of a malformed or already
  // published/unpublished id, matching `validate`/`untouch`'s convention
  // (`plan.md` M10) rather than the strict `record_not_found` a `PUT`
  // carrying content would deserve.
  app.post('/entries/:id/publish', async (c) => {
    const id = c.req.param('id');
    if (isUlid(id)) await publisher.publish('entry', id);
    return c.body(null, 204);
  });

  app.post('/entries/:id/unpublish', async (c) => {
    const id = c.req.param('id');
    if (isUlid(id)) await publisher.unpublish('entry', id);
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

  /**
   * Attach a media-library item to an entry (`plan.md` M19) — the bytes are
   * copied server-side, entirely in-process, from `mediaStore` into the
   * entry's own attachment directory via the very same `addAttachment` a
   * direct upload goes through. Nothing about the attachment's own
   * write-once/self-contained contract (`format.md` §4) changes depending on
   * where the bytes came from; only the source of the bytes differs.
   */
  app.post('/entries/:id/attachments/from-media', async (c) => {
    const id = c.req.param('id');
    if (!isUlid(id)) {
      return c.json(errorBody('entry_not_found', `No entry with id ${id}.`), 404);
    }

    const { mediaId } = await parseUpdateBody(c, AttachMediaSchema);
    if (!isUlid(mediaId)) throw recordNotFound('media', mediaId);
    const media = await mediaStore.get(mediaId);
    if (!media) throw recordNotFound('media', mediaId);
    const bytes = await mediaStore.getBytes(mediaId);
    if (!bytes) throw recordNotFound('media', mediaId);

    const filename = attachmentFilenameForMedia(media);
    const result = await store.addAttachment(id, { filename, data: bytes.data });
    const response: AddAttachmentResponse = result;
    return c.json(response, 201);
  });

  /** An attachment's raw bytes, for `<img>`/`<audio>` `src` (`plan.md`
   * M19) — the entry-attachment twin of `GET /media/:id/file`. Attachments
   * are write-once, so this is safe to cache hard, the same as media. */
  app.get('/entries/:id/attachments/:filename', async (c) => {
    const id = c.req.param('id');
    const filename = c.req.param('filename');
    const entry = isUlid(id) ? await store.get(id) : null;
    if (!entry) {
      return c.json(errorBody('entry_not_found', `No entry with id ${id}.`), 404);
    }

    const bytes = await store.getAttachment(id, filename);
    if (!bytes) throw recordNotFound('attachment', filename);
    return c.body(new Uint8Array(bytes.data), 200, {
      'Content-Type': bytes.contentType,
      'Cache-Control': 'private, max-age=31536000, immutable',
    });
  });

  /**
   * Every media-library item captured on this entry's own local calendar
   * day (`requirements.md` — photo library, M19) — a pure, computed join
   * against `capturedAt`, nothing stored on either side (`MediaStore`'s own
   * doc comment). Uses the entry's local wall-clock date, not its instant:
   * two entries either side of midnight in the writer's own timezone must
   * not be treated as the same day just because they are close together in
   * UTC (`record/time.ts`'s wall-clock/instant distinction).
   */
  app.get('/entries/:id/media', async (c) => {
    const id = c.req.param('id');
    const entry = isUlid(id) ? await store.get(id) : null;
    if (!entry) {
      return c.json(errorBody('entry_not_found', `No entry with id ${id}.`), 404);
    }

    const created = parseTimestamp(entry.created);
    /* c8 ignore next 3 -- `entry.created` is always a value this same parser produced */
    if (!created) {
      return c.json({ media: [] } satisfies EntryMediaResponse);
    }
    const date = `${String(created.year).padStart(4, '0')}-${String(created.month).padStart(2, '0')}-${String(created.day).padStart(2, '0')}`;

    const media = await mediaStore.listByCapturedDate(date);
    const response: EntryMediaResponse = { media };
    return c.json(response);
  });

  /**
   * Live, single-entry extraction (`plan.md` M15, rewritten M18) — every
   * structure type, for this one entry. **No longer commits anything
   * directly**: every candidate becomes a `PendingExtractionItem` awaiting
   * explicit approval (`GET/POST /pending-items*` below) — the mechanism
   * behind `requirements.md` §6.1's rewrite. No longer triggered
   * automatically by finishing a new entry or an edit either — a visible
   * **Process** button is now the only trigger (`plan.md` M18), so this
   * route is reached only by an explicit user action, never as a side
   * effect of writing. Safe to call more than once on the same entry: a
   * fresh run supersedes any still-undecided leftovers from an earlier run
   * on the same entry and diffs its candidates against everything already
   * live, not only what has been touched (`LivePendingProcessor`'s own
   * comment). Fails as `extraction_failed` (503) if `AI_GATEWAY_API_KEY` is
   * not configured — see `UnconfiguredModelClient`.
   */
  app.post('/entries/:id/process', async (c) => {
    const id = c.req.param('id');
    const entry = isUlid(id) ? await store.get(id) : null;
    if (!entry) {
      return c.json(errorBody('entry_not_found', `No entry with id ${id}.`), 404);
    }

    const result = await pendingProcessor.processEntry(entry);
    entryProcessingStatus.recordProcessed(entry.id, entry.contentHash, nowTimestamp().canonical);
    const response: ProcessEntryResponse = result;
    return c.json(response);
  });

  /**
   * Whether a live Process run is current for this entry (`plan.md` M18) —
   * compares the entry's present `contentHash` against the hash recorded
   * the last time a run completed. `'never_processed'` if no run has ever
   * completed at all. Says nothing about whether that run's pending items
   * were ever approved — "processed" means "a run happened," not "fully
   * reviewed" (`EntryProcessingStatusIndex`'s own comment).
   */
  app.get('/entries/:id/status', async (c) => {
    const id = c.req.param('id');
    const entry = isUlid(id) ? await store.get(id) : null;
    if (!entry) {
      return c.json(errorBody('entry_not_found', `No entry with id ${id}.`), 404);
    }

    const status = entryProcessingStatus.get(entry.id);
    const state: EntryStatusResponse['state'] = !status
      ? 'never_processed'
      : status.lastProcessedContentHash === entry.contentHash
        ? 'up_to_date'
        : 'stale';
    const response: EntryStatusResponse = { state };
    return c.json(response);
  });

  const PENDING_ITEM_STRUCTURE_TYPES = ['metric', 'review', 'list_item', 'opinion_statement', 'question', 'todo'] as const;
  const PENDING_ITEM_STATUSES = ['pending', 'approved', 'rejected', 'superseded'] as const;

  /**
   * Every candidate a live `POST /entries/:id/process` run produced, still
   * awaiting a decision or already decided (`plan.md` M18) — powers both
   * the popup (`entryId` given) and the fallback queue
   * (`status=pending`, unscoped) with the same one query.
   */
  app.get('/pending-items', async (c) => {
    const entryId = c.req.query('entryId');
    const rawStructureType = c.req.query('structureType');
    const rawStatus = c.req.query('status');
    if (rawStructureType !== undefined && !PENDING_ITEM_STRUCTURE_TYPES.includes(rawStructureType as (typeof PENDING_ITEM_STRUCTURE_TYPES)[number])) {
      throw invalidRequest(`'structureType' must be one of: ${PENDING_ITEM_STRUCTURE_TYPES.join(', ')}.`);
    }
    if (rawStatus !== undefined && !PENDING_ITEM_STATUSES.includes(rawStatus as (typeof PENDING_ITEM_STATUSES)[number])) {
      throw invalidRequest(`'status' must be one of: ${PENDING_ITEM_STATUSES.join(', ')}.`);
    }

    const items = pendingItems.list({
      ...(entryId ? { entryId } : {}),
      ...(rawStructureType ? { structureType: rawStructureType as (typeof PENDING_ITEM_STRUCTURE_TYPES)[number] } : {}),
      ...(rawStatus ? { status: rawStatus as (typeof PENDING_ITEM_STATUSES)[number] } : {}),
    });
    const response: PendingItemsResponse = { items };
    return c.json(response);
  });

  /** Approving flips the row's status, then commits the actual change via
   * `PendingItemApplier` — the only place that translation happens
   * (`plan.md` M18). A no-op, not an error, if `id` is not currently
   * pending, the same tolerance every other `decide`-shaped route already
   * has. */
  app.post('/pending-items/:id/approve', async (c) => {
    const now = nowTimestamp().canonical;
    const decided = pendingItems.decide(c.req.param('id'), 'approved', now);
    if (decided) await pendingItemApplier.apply(decided, now);
    return c.body(null, 204);
  });

  app.post('/pending-items/:id/reject', async (c) => {
    pendingItems.decide(c.req.param('id'), 'rejected', nowTimestamp().canonical);
    return c.body(null, 204);
  });

  const ApproveBatchSchema = z.object({ ids: z.array(z.string().min(1)) }).strict();

  /** What makes "approve all pending metrics" one click (`plan.md` M18) —
   * each id is approved and applied independently, so one bad item in the
   * batch cannot block the rest; `failed` reports which ones, and why,
   * rather than the whole request failing. */
  app.post('/pending-items/approve-batch', async (c) => {
    const { ids } = await parseUpdateBody(c, ApproveBatchSchema);
    const now = nowTimestamp().canonical;
    const approved: string[] = [];
    const failed: { id: string; error: string }[] = [];
    for (const id of ids) {
      try {
        const decided = pendingItems.decide(id, 'approved', now);
        if (!decided) {
          failed.push({ id, error: 'Not currently pending.' });
          continue;
        }
        await pendingItemApplier.apply(decided, now);
        approved.push(id);
      } catch (error) {
        failed.push({ id, error: error instanceof Error ? error.message : 'Unknown error.' });
      }
    }
    const response: ApproveBatchResponse = { approved, failed };
    return c.json(response);
  });

  /**
   * Bulk-upload the media library (`requirements.md` — photo library, M19)
   * — one file per request; a multi-file picker on the frontend is a loop
   * of these, not a bulk endpoint of its own. Independent of any entry, the
   * same way `POST /documents` is: there is no `:id` in this path at all.
   * Metadata (dimensions, `capturedAt`) is extracted from the file's own
   * bytes at upload time — see `record/media-metadata.ts` — never supplied
   * by the caller.
   */
  app.post('/media', async (c) => {
    const contentLength = Number(c.req.header('content-length') ?? '0');
    if (contentLength > MAX_MEDIA_BYTES) {
      throw invalidRequest(`The upload is larger than the ${MAX_MEDIA_BYTES} byte limit.`);
    }

    let body: Record<string, unknown>;
    try {
      body = await c.req.parseBody();
    } catch {
      throw invalidRequest('The request body is not valid multipart/form-data.');
    }

    const file = body['file'];
    if (!(file instanceof File)) {
      throw invalidRequest("A 'file' field carrying the media item is required.");
    }
    if (!isSupportedMediaContentType(file.type)) {
      throw unsupportedMediaType(file.type);
    }

    const data = Buffer.from(await file.arrayBuffer());
    const stored = await mediaStore.upload({ contentType: file.type, data, originalFilename: file.name });
    const response: UploadMediaResponse = stored;
    return c.json(response, 201);
  });

  app.get('/media', async (c) => {
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

    const result = await mediaStore.list({ limit, ...(cursor !== undefined && cursor !== '' ? { cursor } : {}) });
    const page: MediaPage = { media: result.media, nextCursor: result.nextCursor };
    return c.json(page);
  });

  app.get('/media/:id', async (c) => {
    const id = c.req.param('id');
    if (!isUlid(id)) throw recordNotFound('media', id);
    const media = await mediaStore.get(id);
    if (!media) throw recordNotFound('media', id);
    return c.json(media satisfies UploadMediaResponse);
  });

  /** The item's raw bytes, for `<img>`/`<video>` `src` — the one route in
   * this app that ever returns something other than JSON. */
  app.get('/media/:id/file', async (c) => {
    const id = c.req.param('id');
    if (!isUlid(id)) throw recordNotFound('media', id);
    const bytes = await mediaStore.getBytes(id);
    if (!bytes) throw recordNotFound('media', id);
    // `Buffer`'s own `.buffer` is typed `ArrayBufferLike` (it may be a
    // pooled/shared allocation); Hono's `Data` type wants a plain
    // `Uint8Array<ArrayBuffer>`. Copying into a fresh `Uint8Array` is the
    // simplest way to satisfy that without leaking Node's `Buffer` type
    // into the one route in this app that returns raw bytes.
    return c.body(new Uint8Array(bytes.data), 200, {
      'Content-Type': bytes.contentType,
      // Immutable once uploaded (`MediaStore`'s own doc comment) — safe to
      // cache hard, the same as any other write-once asset.
      'Cache-Control': 'private, max-age=31536000, immutable',
    });
  });

  app.delete('/media/:id', async (c) => {
    const id = c.req.param('id');
    if (isUlid(id)) await mediaStore.remove(id);
    return c.body(null, 204);
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
    const page: DocumentPage = {
      documents: result.documents.map((document) => ({
        ...document,
        published: publisher.isPublished('document', document.id),
      })),
      nextCursor: result.nextCursor,
    };
    return c.json(page);
  });

  app.get('/documents/:id', async (c) => {
    const id = c.req.param('id');
    if (!isUlid(id)) throw recordNotFound('document', id);
    const document = await documentStore.get(id);
    if (!document) throw recordNotFound('document', id);
    return c.json(documentResponse(document, publisher.isPublished('document', id)));
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
    // Same inline resync a published entry gets above (`plan.md` M15).
    await publisher.resyncIfPublished('document', id);
    const response: UpdateDocumentResponse = documentResponse(document, publisher.isPublished('document', id));
    return c.json(response);
  });

  // Visibility (`requirements.md` §9.3, §11, `plan.md` M15) — publishing
  // copies a snapshot into the `public/` mirror rather than flipping a
  // field on the document itself (`Publisher`'s own doc comment explains
  // why); no request body, since there is nothing to submit and nothing to
  // guard with a `contentHash` — publishing never writes to the document.
  app.post('/documents/:id/publish', async (c) => {
    const id = c.req.param('id');
    if (!isUlid(id)) throw recordNotFound('document', id);
    await publisher.publish('document', id);
    const document = await documentStore.get(id);
    if (!document) throw recordNotFound('document', id);
    const response: PublishDocumentResponse = documentResponse(document, true);
    return c.json(response);
  });

  app.post('/documents/:id/unpublish', async (c) => {
    const id = c.req.param('id');
    if (!isUlid(id)) throw recordNotFound('document', id);
    await publisher.unpublish('document', id);
    const document = await documentStore.get(id);
    if (!document) throw recordNotFound('document', id);
    const response: PublishDocumentResponse = documentResponse(document, false);
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
        published: publisher.isPublished('metric', record.id),
      })),
    };
    return c.json(response);
  });

  app.delete('/metrics/:id', async (c) => {
    const id = c.req.param('id');
    // The same tolerance as DELETE /entries/:id: a malformed or already-gone
    // id is simply nothing to do, not an error (`requirements.md` §6.2 —
    // correcting a mistake should be this easy, not fussy about repeats).
    if (isUlid(id)) {
      metrics.remove(id);
      await touchedMirror.sync('metric', id);
    }
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
    await touchedMirror.sync('metric', id);
    return c.body(null, 204);
  });

  app.post('/metrics/:id/validate', async (c) => {
    const id = c.req.param('id');
    if (isUlid(id)) {
      metrics.validate(id, nowTimestamp().canonical);
      await touchedMirror.sync('metric', id);
    }
    return c.body(null, 204);
  });

  app.post('/metrics/:id/untouch', async (c) => {
    const id = c.req.param('id');
    if (isUlid(id)) {
      metrics.untouch(id, nowTimestamp().canonical);
      await touchedMirror.sync('metric', id);
    }
    return c.body(null, 204);
  });

  // Visibility (`requirements.md` §11, `plan.md` M16) — same tolerant
  // action-route shape as `validate`/`untouch` above and the entry
  // publish/unpublish routes (`plan.md` M15): a malformed or
  // already-published/unpublished id is simply nothing to do.
  app.post('/metrics/:id/publish', async (c) => {
    const id = c.req.param('id');
    if (isUlid(id)) await publisher.publish('metric', id);
    return c.body(null, 204);
  });

  app.post('/metrics/:id/unpublish', async (c) => {
    const id = c.req.param('id');
    if (isUlid(id)) await publisher.unpublish('metric', id);
    return c.body(null, 204);
  });

  app.get('/metrics/update-suggestions', async (c) => {
    const status = optionalStatus(c.req.query('status'));
    const suggestions = metrics.listUpdateSuggestions(status ? { status } : {});
    const response: MetricUpdateSuggestionsResponse = { suggestions };
    return c.json(response);
  });

  app.post('/metrics/update-suggestions/:id/approve', async (c) => {
    const id = c.req.param('id');
    const suggestion = metrics.listUpdateSuggestions().find((s) => s.id === id);
    metrics.decideUpdate(id, 'approved', nowTimestamp().canonical);
    if (suggestion) await touchedMirror.sync('metric', suggestion.recordId);
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

  app.patch('/metrics/fields/:id', async (c) => {
    const id = c.req.param('id');
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      throw invalidRequest('The request body is not valid JSON.');
    }

    const parsed = UpdateMetricFieldSchema.safeParse(json);
    if (!parsed.success) {
      const [issue] = parsed.error.issues;
      const at = issue && issue.path.length > 0 ? ` at '${issue.path.join('.')}'` : '';
      throw invalidRequest(`${issue?.message ?? 'Invalid request body.'}${at}`);
    }

    const updated = metricFields.update(id, parsed.data);
    if (!updated) throw recordNotFound('field', id);
    const response: UpdateMetricFieldResponse = updated;
    return c.json(response);
  });

  app.delete('/metrics/fields/:id', async (c) => {
    const id = c.req.param('id');
    if (isUlid(id)) metricFields.remove(id);
    return c.body(null, 204);
  });

  app.get('/metrics/fields/suggestions', async (c) => {
    const metric = c.req.query('metric');
    const rawStatus = c.req.query('status');
    if (rawStatus !== undefined && !['pending', 'approved', 'rejected', 'parked'].includes(rawStatus)) {
      throw invalidRequest("'status' must be one of: pending, approved, rejected, parked.");
    }

    const suggestions = metricFields.listSuggestions({
      ...(metric ? { metric } : {}),
      ...(rawStatus ? { status: rawStatus as 'pending' | 'approved' | 'rejected' | 'parked' } : {}),
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

  /** Set aside to reconsider later, neither approved nor rejected
   * (`plan.md` M18) — a plain, passive shelf with no reminders or
   * resurfacing (non-negotiable #12). */
  app.post('/metrics/fields/suggestions/:id/park', async (c) => {
    metricFields.decide(c.req.param('id'), 'parked', nowTimestamp().canonical);
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
    if (rawStatus !== undefined && !['pending', 'approved', 'rejected', 'parked'].includes(rawStatus)) {
      throw invalidRequest("'status' must be one of: pending, approved, rejected, parked.");
    }
    const suggestions = categories.listSuggestions({
      structureType: `metric_field:${field.metric}:${field.fieldKey}`,
      ...(rawStatus ? { status: rawStatus as 'pending' | 'approved' | 'rejected' | 'parked' } : {}),
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
        published: publisher.isPublished('review', record.id),
      })),
    };
    return c.json(response);
  });

  app.delete('/reviews/:id', async (c) => {
    const id = c.req.param('id');
    if (isUlid(id)) {
      reviews.remove(id);
      await touchedMirror.sync('review', id);
    }
    return c.body(null, 204);
  });

  app.put('/reviews/:id', async (c) => {
    const id = c.req.param('id');
    const body = await parseUpdateBody(c, UpdateReviewSchema);
    const updated = reviews.update(id, body, nowTimestamp().canonical);
    if (!updated) throw recordNotFound('review', id);
    await touchedMirror.sync('review', id);
    return c.body(null, 204);
  });

  app.post('/reviews/:id/validate', async (c) => {
    const id = c.req.param('id');
    if (isUlid(id)) {
      reviews.validate(id, nowTimestamp().canonical);
      await touchedMirror.sync('review', id);
    }
    return c.body(null, 204);
  });

  app.post('/reviews/:id/untouch', async (c) => {
    const id = c.req.param('id');
    if (isUlid(id)) {
      reviews.untouch(id, nowTimestamp().canonical);
      await touchedMirror.sync('review', id);
    }
    return c.body(null, 204);
  });

  // Visibility (`requirements.md` §11, `plan.md` M16) — see `/metrics/:id/publish`.
  app.post('/reviews/:id/publish', async (c) => {
    const id = c.req.param('id');
    if (isUlid(id)) await publisher.publish('review', id);
    return c.body(null, 204);
  });

  app.post('/reviews/:id/unpublish', async (c) => {
    const id = c.req.param('id');
    if (isUlid(id)) await publisher.unpublish('review', id);
    return c.body(null, 204);
  });

  app.get('/reviews/update-suggestions', async (c) => {
    const status = optionalStatus(c.req.query('status'));
    const suggestions = reviews.listUpdateSuggestions(status ? { status } : {});
    const response: ReviewUpdateSuggestionsResponse = { suggestions };
    return c.json(response);
  });

  app.post('/reviews/update-suggestions/:id/approve', async (c) => {
    const id = c.req.param('id');
    const suggestion = reviews.listUpdateSuggestions().find((s) => s.id === id);
    reviews.decideUpdate(id, 'approved', nowTimestamp().canonical);
    if (suggestion) await touchedMirror.sync('review', suggestion.recordId);
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
        published: publisher.isPublished('list_item', record.id),
      })),
    };
    return c.json(response);
  });

  app.delete('/lists/:id', async (c) => {
    const id = c.req.param('id');
    if (isUlid(id)) {
      lists.remove(id);
      await touchedMirror.sync('list_item', id);
    }
    return c.body(null, 204);
  });

  app.put('/lists/:id', async (c) => {
    const id = c.req.param('id');
    const body = await parseUpdateBody(c, UpdateListItemSchema);
    const updated = lists.update(id, body, nowTimestamp().canonical);
    if (!updated) throw recordNotFound('list item', id);
    await touchedMirror.sync('list_item', id);
    return c.body(null, 204);
  });

  app.post('/lists/:id/validate', async (c) => {
    const id = c.req.param('id');
    if (isUlid(id)) {
      lists.validate(id, nowTimestamp().canonical);
      await touchedMirror.sync('list_item', id);
    }
    return c.body(null, 204);
  });

  app.post('/lists/:id/untouch', async (c) => {
    const id = c.req.param('id');
    if (isUlid(id)) {
      lists.untouch(id, nowTimestamp().canonical);
      await touchedMirror.sync('list_item', id);
    }
    return c.body(null, 204);
  });

  // Visibility (`requirements.md` §11, `plan.md` M16) — see `/metrics/:id/publish`.
  app.post('/lists/:id/publish', async (c) => {
    const id = c.req.param('id');
    if (isUlid(id)) await publisher.publish('list_item', id);
    return c.body(null, 204);
  });

  app.post('/lists/:id/unpublish', async (c) => {
    const id = c.req.param('id');
    if (isUlid(id)) await publisher.unpublish('list_item', id);
    return c.body(null, 204);
  });

  app.get('/lists/update-suggestions', async (c) => {
    const status = optionalStatus(c.req.query('status'));
    const suggestions = lists.listUpdateSuggestions(status ? { status } : {});
    const response: ListItemUpdateSuggestionsResponse = { suggestions };
    return c.json(response);
  });

  app.post('/lists/update-suggestions/:id/approve', async (c) => {
    const id = c.req.param('id');
    const suggestion = lists.listUpdateSuggestions().find((s) => s.id === id);
    lists.decideUpdate(id, 'approved', nowTimestamp().canonical);
    if (suggestion) await touchedMirror.sync('list_item', suggestion.recordId);
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
        kind: record.kind,
        status: record.status,
        resolvedEntryId: record.resolvedEntryId,
        resolution: record.resolution,
        touched: record.touched,
        published: publisher.isPublished('opinion_statement', record.id),
      })),
    };
    return c.json(response);
  });

  app.delete('/opinions/statements/:id', async (c) => {
    const id = c.req.param('id');
    // The same tolerance as every other correction endpoint
    // (`requirements.md` §6.2).
    if (isUlid(id)) {
      opinionStatements.remove(id);
      await touchedMirror.sync('opinion_statement', id);
    }
    return c.body(null, 204);
  });

  app.put('/opinions/statements/:id', async (c) => {
    const id = c.req.param('id');
    const body = await parseUpdateBody(c, UpdateOpinionStatementSchema);
    const updated = opinionStatements.update(id, body, nowTimestamp().canonical);
    if (!updated) throw recordNotFound('opinion statement', id);
    await touchedMirror.sync('opinion_statement', id);
    return c.body(null, 204);
  });

  app.post('/opinions/statements/:id/validate', async (c) => {
    const id = c.req.param('id');
    if (isUlid(id)) {
      opinionStatements.validate(id, nowTimestamp().canonical);
      await touchedMirror.sync('opinion_statement', id);
    }
    return c.body(null, 204);
  });

  app.post('/opinions/statements/:id/untouch', async (c) => {
    const id = c.req.param('id');
    if (isUlid(id)) {
      opinionStatements.untouch(id, nowTimestamp().canonical);
      await touchedMirror.sync('opinion_statement', id);
    }
    return c.body(null, 204);
  });

  // Manual-only, mirrors `POST /questions/:id/reopen` — a `kind: 'question'`
  // statement only ever becomes resolved via the pending-item pipeline, but
  // reopening one (deciding it isn't actually settled) is a direct action,
  // same as questions.
  app.post('/opinions/statements/:id/reopen', async (c) => {
    const id = c.req.param('id');
    if (isUlid(id)) {
      opinionStatements.reopen(id);
      await touchedMirror.sync('opinion_statement', id);
    }
    return c.body(null, 204);
  });

  // Visibility (`requirements.md` §11, `plan.md` M16) — see `/metrics/:id/publish`.
  app.post('/opinions/statements/:id/publish', async (c) => {
    const id = c.req.param('id');
    if (isUlid(id)) await publisher.publish('opinion_statement', id);
    return c.body(null, 204);
  });

  app.post('/opinions/statements/:id/unpublish', async (c) => {
    const id = c.req.param('id');
    if (isUlid(id)) await publisher.unpublish('opinion_statement', id);
    return c.body(null, 204);
  });

  app.get('/opinions/statements/update-suggestions', async (c) => {
    const status = optionalStatus(c.req.query('status'));
    const suggestions = opinionStatements.listUpdateSuggestions(status ? { status } : {});
    const response: OpinionStatementUpdateSuggestionsResponse = { suggestions };
    return c.json(response);
  });

  app.post('/opinions/statements/update-suggestions/:id/approve', async (c) => {
    const id = c.req.param('id');
    const suggestion = opinionStatements.listUpdateSuggestions().find((s) => s.id === id);
    opinionStatements.decideUpdate(id, 'approved', nowTimestamp().canonical);
    if (suggestion) await touchedMirror.sync('opinion_statement', suggestion.recordId);
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
        published: publisher.isPublished('question', record.id),
      })),
    };
    return c.json(response);
  });

  app.delete('/questions/:id', async (c) => {
    const id = c.req.param('id');
    // The same tolerance as every other correction endpoint
    // (`requirements.md` §6.2).
    if (isUlid(id)) {
      questions.remove(id);
      await touchedMirror.sync('question', id);
    }
    return c.body(null, 204);
  });

  app.post('/questions/:id/reopen', async (c) => {
    const id = c.req.param('id');
    if (isUlid(id)) {
      questions.reopen(id);
      await touchedMirror.sync('question', id);
    }
    return c.body(null, 204);
  });

  app.put('/questions/:id', async (c) => {
    const id = c.req.param('id');
    const body = await parseUpdateBody(c, UpdateQuestionSchema);
    const updated = questions.update(id, body, nowTimestamp().canonical);
    if (!updated) throw recordNotFound('question', id);
    await touchedMirror.sync('question', id);
    return c.body(null, 204);
  });

  app.post('/questions/:id/validate', async (c) => {
    const id = c.req.param('id');
    if (isUlid(id)) {
      questions.validate(id, nowTimestamp().canonical);
      await touchedMirror.sync('question', id);
    }
    return c.body(null, 204);
  });

  app.post('/questions/:id/untouch', async (c) => {
    const id = c.req.param('id');
    if (isUlid(id)) {
      questions.untouch(id, nowTimestamp().canonical);
      await touchedMirror.sync('question', id);
    }
    return c.body(null, 204);
  });

  // Visibility (`requirements.md` §11, `plan.md` M16) — see
  // `/metrics/:id/publish`. Questions have no category, so unlike the other
  // four structures there is no default/`/publish-queue` participation.
  app.post('/questions/:id/publish', async (c) => {
    const id = c.req.param('id');
    if (isUlid(id)) await publisher.publish('question', id);
    return c.body(null, 204);
  });

  app.post('/questions/:id/unpublish', async (c) => {
    const id = c.req.param('id');
    if (isUlid(id)) await publisher.unpublish('question', id);
    return c.body(null, 204);
  });

  app.get('/questions/update-suggestions', async (c) => {
    const status = optionalStatus(c.req.query('status'));
    const suggestions = questions.listUpdateSuggestions(status ? { status } : {});
    const response: QuestionUpdateSuggestionsResponse = { suggestions };
    return c.json(response);
  });

  app.post('/questions/update-suggestions/:id/approve', async (c) => {
    const id = c.req.param('id');
    const suggestion = questions.listUpdateSuggestions().find((s) => s.id === id);
    questions.decideUpdate(id, 'approved', nowTimestamp().canonical);
    if (suggestion) await touchedMirror.sync('question', suggestion.recordId);
    return c.body(null, 204);
  });

  app.post('/questions/update-suggestions/:id/reject', async (c) => {
    questions.decideUpdate(c.req.param('id'), 'rejected', nowTimestamp().canonical);
    return c.body(null, 204);
  });

  app.get('/todos', async (c) => {
    const rawStatus = c.req.query('status');
    if (rawStatus !== undefined && rawStatus !== 'open' && rawStatus !== 'done') {
      throw invalidRequest(`'status' must be 'open' or 'done'.`);
    }
    const status = rawStatus as 'open' | 'done' | undefined;

    const rawLimit = c.req.query('limit');
    let limit = DEFAULT_LIMIT;
    if (rawLimit !== undefined && rawLimit !== '') {
      const value = Number(rawLimit);
      if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
        throw invalidRequest(`'limit' must be a whole number between 1 and ${MAX_LIMIT}.`);
      }
      limit = value;
    }

    const records = todos.list({ limit, ...(status ? { status } : {}) });
    const response: TodosResponse = {
      todos: records.map((record) => ({
        id: record.id,
        entryId: record.entryId,
        text: record.text,
        eventTime: record.eventTime,
        eventTimeExplicit: record.eventTimeExplicit,
        status: record.status,
        doneEntryId: record.doneEntryId,
        resolution: record.resolution,
        origin: record.origin,
        touched: record.touched,
      })),
    };
    return c.json(response);
  });

  // Not a copy of any AI-only route — the closest real precedent is
  // `POST /documents`, a genuinely user-authored record. This is the
  // deliberate, named exception to "origination is always automatic"
  // (`requirements.md` §2, §11).
  app.post('/todos', async (c) => {
    const { text } = await parseUpdateBody(c, CreateTodoSchema);
    const now = nowTimestamp().canonical;
    const record = todos.createDirect({ id: ulid(Date.now()), text, now });
    // A direct-created to-do starts touched (`todos-index.ts`'s own doc
    // comment) — there is no entry behind it to ever regenerate it, so it
    // needs durable backing from the moment it exists, not only from its
    // first edit.
    await touchedMirror.sync('todo', record.id);
    const response: Todo = {
      id: record.id,
      entryId: record.entryId,
      text: record.text,
      eventTime: record.eventTime,
      eventTimeExplicit: record.eventTimeExplicit,
      status: record.status,
      doneEntryId: record.doneEntryId,
      resolution: record.resolution,
      origin: record.origin,
      touched: record.touched,
    };
    return c.json(response, 201);
  });

  app.delete('/todos/:id', async (c) => {
    const id = c.req.param('id');
    if (isUlid(id)) {
      todos.remove(id);
      await touchedMirror.sync('todo', id);
    }
    return c.body(null, 204);
  });

  app.post('/todos/:id/reopen', async (c) => {
    const id = c.req.param('id');
    if (isUlid(id)) {
      todos.reopen(id);
      await touchedMirror.sync('todo', id);
    }
    return c.body(null, 204);
  });

  app.post('/todos/:id/complete', async (c) => {
    const id = c.req.param('id');
    if (isUlid(id)) {
      todos.completeDirect(id, nowTimestamp().canonical);
      await touchedMirror.sync('todo', id);
    }
    return c.body(null, 204);
  });

  app.put('/todos/:id', async (c) => {
    const id = c.req.param('id');
    const body = await parseUpdateBody(c, UpdateTodoSchema);
    const updated = todos.update(id, body, nowTimestamp().canonical);
    if (!updated) throw recordNotFound('todo', id);
    await touchedMirror.sync('todo', id);
    return c.body(null, 204);
  });

  app.post('/todos/:id/validate', async (c) => {
    const id = c.req.param('id');
    if (isUlid(id)) {
      todos.validate(id, nowTimestamp().canonical);
      await touchedMirror.sync('todo', id);
    }
    return c.body(null, 204);
  });

  app.post('/todos/:id/untouch', async (c) => {
    const id = c.req.param('id');
    if (isUlid(id)) {
      todos.untouch(id, nowTimestamp().canonical);
      await touchedMirror.sync('todo', id);
    }
    return c.body(null, 204);
  });

  app.get('/todos/update-suggestions', async (c) => {
    const status = optionalStatus(c.req.query('status'));
    const suggestions = todos.listUpdateSuggestions(status ? { status } : {});
    const response: TodoUpdateSuggestionsResponse = { suggestions };
    return c.json(response);
  });

  app.post('/todos/update-suggestions/:id/approve', async (c) => {
    const id = c.req.param('id');
    const suggestion = todos.listUpdateSuggestions().find((s) => s.id === id);
    todos.decideUpdate(id, 'approved', nowTimestamp().canonical);
    if (suggestion) await touchedMirror.sync('todo', suggestion.recordId);
    return c.body(null, 204);
  });

  app.post('/todos/update-suggestions/:id/reject', async (c) => {
    todos.decideUpdate(c.req.param('id'), 'rejected', nowTimestamp().canonical);
    return c.body(null, 204);
  });

  app.get('/todos/completion-suggestions', async (c) => {
    const status = optionalStatus(c.req.query('status'));
    const suggestions = todos.listCompletionSuggestions(status ? { status } : {});
    const response: TodoCompletionSuggestionsResponse = { suggestions };
    return c.json(response);
  });

  app.post('/todos/completion-suggestions/:id/approve', async (c) => {
    const id = c.req.param('id');
    const suggestion = todos.listCompletionSuggestions().find((s) => s.id === id);
    todos.decideCompletion(id, 'approved', nowTimestamp().canonical);
    if (suggestion) await touchedMirror.sync('todo', suggestion.recordId);
    return c.body(null, 204);
  });

  app.post('/todos/completion-suggestions/:id/reject', async (c) => {
    todos.decideCompletion(c.req.param('id'), 'rejected', nowTimestamp().canonical);
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
    if (rawStatus !== undefined && !['pending', 'approved', 'rejected', 'parked'].includes(rawStatus)) {
      throw invalidRequest("'status' must be one of: pending, approved, rejected, parked.");
    }

    const suggestions = categories.listSuggestions({
      ...(rawStructureType ? { structureType: rawStructureType as StructureType } : {}),
      ...(rawStatus ? { status: rawStatus as 'pending' | 'approved' | 'rejected' | 'parked' } : {}),
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

  /** Set aside to reconsider later (`plan.md` M18) — see
   * `/metrics/fields/suggestions/:id/park`'s comment. Covers enum field
   * values too, which reuse this exact mechanism (see the route above). */
  app.post('/categories/suggestions/:id/park', async (c) => {
    categories.decide(c.req.param('id'), 'parked', nowTimestamp().canonical);
    return c.body(null, 204);
  });

  // "Public by default" settings, one per category (`requirements.md` §11,
  // `plan.md` M16). Setting one never publishes anything by itself — it only
  // changes what `/publish-queue` below surfaces for confirmation.
  app.get('/visibility-defaults', async (c) => {
    const response: VisibilityDefaultsResponse = { defaults: visibilityDefaults.list() };
    return c.json(response);
  });

  app.put('/visibility-defaults', async (c) => {
    const { structureType, category, defaultPublic } = await parseUpdateBody(c, SetVisibilityDefaultSchema);
    visibilityDefaults.set(structureType, category, defaultPublic);
    return c.body(null, 204);
  });

  // Records in a "public by default" category that are not yet published —
  // never auto-published, only ever offered for one-click confirmation
  // (`requirements.md` §11, `plan.md` M16). Questions never appear here —
  // they have no category (`QuestionsIndex`'s own doc comment explains why).
  app.get('/publish-queue', async (c) => {
    const items: PublishQueueResponse['items'] = [];
    for (const { structureType, category, defaultPublic } of visibilityDefaults.list()) {
      if (!defaultPublic) continue;

      if (structureType === 'metric') {
        const published = publisher.publishedIds('metric');
        for (const record of metrics.allByMetric(category)) {
          if (!published.has(record.id)) {
            items.push({ structureType, category, id: record.id, preview: record.detail, eventTime: record.eventTime });
          }
        }
      } else if (structureType === 'review_medium') {
        const published = publisher.publishedIds('review');
        for (const record of reviews.allByMedium(category)) {
          if (!published.has(record.id)) {
            items.push({ structureType, category, id: record.id, preview: record.title, eventTime: record.eventTime });
          }
        }
      } else if (structureType === 'list_type') {
        const published = publisher.publishedIds('list_item');
        for (const record of lists.allByListType(category)) {
          if (!published.has(record.id)) {
            items.push({ structureType, category, id: record.id, preview: record.text, eventTime: record.eventTime });
          }
        }
      } else {
        const published = publisher.publishedIds('opinion_statement');
        for (const record of opinionStatements.bySubject(category)) {
          if (!published.has(record.id)) {
            items.push({ structureType, category, id: record.id, preview: record.statement, eventTime: record.eventTime });
          }
        }
      }
    }
    const response: PublishQueueResponse = { items };
    return c.json(response);
  });

  // Aggregated, not raw — the analysis surfaces' own material
  // (`plan.md` M8, `design.md` §5.3). Computed here, never in the frontend
  // (`requirements.md` §7.1).
  app.get('/analysis/metrics', async (c) => {
    const approvedNames = categories.approvedNames('metric');
    const windowDays = parseWindowDays(c, METRICS_SUMMARY_WINDOW_DAYS);
    const summaries = metrics.summarize(approvedNames, windowDays);
    const response: MetricsSummaryResponse = { summaries, windowDays };
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

    const windowDays = parseWindowDays(c, METRICS_SUMMARY_WINDOW_DAYS);

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

  app.get('/analysis/reviews/histogram', async (c) => {
    const approvedMedia = categories.approvedNames('review_medium');
    const response: ReviewsHistogramResponse = reviews.histogram(approvedMedia);
    return c.json(response);
  });

  app.get('/analysis/opinions', async (c) => {
    const approvedSubjects = categories.approvedNames('opinion_subject');
    const response: OpinionSubjectSummariesResponse = { summaries: opinionStatements.summarize(approvedSubjects) };
    return c.json(response);
  });

  app.get('/analysis/questions', async (c) => {
    const response: QuestionsSummaryResponse = questions.summarize();
    return c.json(response);
  });

  app.get('/analysis/todos', async (c) => {
    const response: TodosSummaryResponse = todos.summarize();
    return c.json(response);
  });

  const layoutExecutorDeps = () => ({
    metrics,
    metricFields,
    reviews,
    lists,
    categories,
    opinionStatements,
    questions,
    todos,
  });

  // One round trip replaces the ~15 `/analysis/*` calls the pre-M20 page
  // stitched together itself — letting the frontend read a spec to decide
  // which calls to make *is* spec execution in the frontend, the thing
  // `requirements.md` §7.1 forbids. `layoutId` names a stored layout;
  // `syntax` renders an unsaved draft; neither renders the stored default,
  // and failing that the built-in `DEFAULT_ANALYSIS_LAYOUT`.
  app.post('/analysis/render', async (c) => {
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      throw invalidRequest('The request body is not valid JSON.');
    }
    const parsed = RenderLayoutRequestSchema.safeParse(json ?? {});
    if (!parsed.success) throw invalidRequest('Expected { layoutId?, syntax?, windowDays? }.');

    const { layoutId, syntax, windowDays } = parsed.data;

    // Resolve which DSL to render. An explicit draft wins; then a named
    // layout; then the surface's stored default; then nothing (built-in).
    let effectiveSyntax = syntax;
    let effectiveLayoutId: string | null = null;
    let callerSuppliedSyntax = syntax !== undefined;
    if (effectiveSyntax === undefined && layoutId !== undefined) {
      const stored = await layoutStore.get(layoutId);
      if (!stored) throw layoutNotFound(layoutId);
      effectiveSyntax = stored.syntax;
      effectiveLayoutId = stored.id;
    } else if (effectiveSyntax === undefined) {
      const { defaultId } = await layoutStore.list('analysis');
      if (defaultId) {
        const stored = await layoutStore.get(defaultId);
        if (stored) {
          effectiveSyntax = stored.syntax;
          effectiveLayoutId = stored.id;
        }
      }
    }

    const options: { syntax?: string; windowDays?: number; layoutId?: string | null } = {};
    if (effectiveSyntax !== undefined) options.syntax = effectiveSyntax;
    if (windowDays !== undefined) options.windowDays = windowDays;
    options.layoutId = effectiveLayoutId;

    const rendered = renderAnalysisLayout(layoutExecutorDeps(), options);
    // A caller-supplied draft that did not fully parse is a client error
    // worth reporting; a stored layout parsed clean when it was saved, and
    // the built-in default never produces diagnostics.
    if (callerSuppliedSyntax && rendered.diagnostics.length > 0) {
      const first = rendered.diagnostics[0]!;
      throw layoutInvalid(`Line ${first.line}: ${first.message}`);
    }
    const response: ResolvedLayout = rendered.layout;
    return c.json(response);
  });

  // ── Named, durable layouts (`requirements.md` §8, `format.md` §8) ────────
  //
  // The DSL text is canonical and authored; the parsed spec is a disposable
  // projection. Parsing, validation, and canonicalisation all run here —
  // the frontend edits text and renders a resolved structure, nothing more
  // (`requirements.md` §7.1).

  const readLayoutBody = async (c2: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> => {
    let body: unknown;
    try {
      body = await c2.req.json();
    } catch {
      throw invalidRequest('The request body is not valid JSON.');
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw invalidRequest('Expected a JSON object.');
    }
    return body as Record<string, unknown>;
  };

  const isLayoutSurface = (value: unknown): value is LayoutSurface => value === 'analysis' || value === 'home';

  /** Parse `syntax` on a `surface`, throwing `layout_invalid` with the first
   * diagnostic if it does not fully parse. */
  const requireParsed = (syntax: string, surface: LayoutSurface) => {
    const { diagnostics } = parseLayout(syntax, surface);
    if (diagnostics.length > 0) {
      const first = diagnostics[0]!;
      throw layoutInvalid(`Line ${first.line}: ${first.message}`);
    }
  };

  app.get('/layouts', async (c) => {
    const surface = c.req.query('surface');
    if (!isLayoutSurface(surface)) throw invalidRequest("A '?surface=analysis' query is required.");
    const { layouts: list, defaultId } = await layoutStore.list(surface);
    const response: LayoutsResponse = { layouts: list, defaultId };
    return c.json(response);
  });

  app.get('/layouts/:id', async (c) => {
    const layout = await layoutStore.get(c.req.param('id'));
    if (!layout) throw layoutNotFound(c.req.param('id'));
    return c.json<Layout>(layout);
  });

  app.post('/layouts', async (c) => {
    const body = await readLayoutBody(c);
    if (!isLayoutSurface(body['surface'])) throw invalidRequest("'surface' must be 'analysis' or 'home'.");
    const name = typeof body['name'] === 'string' ? body['name'].trim() : '';
    if (name === '') throw invalidRequest("'name' is required.");
    if ('prose' in body && body['prose'] !== undefined && body['prose'] !== null) {
      throw invalidRequest('Compiling prose into a layout is not available yet — supply `syntax`.');
    }
    if (typeof body['syntax'] !== 'string') throw invalidRequest("'syntax' is required.");

    // The create form carries the name separately, so a body that is just
    // sections is fine — synthesise the header the store would rewrite anyway
    // before validating, so a real error still surfaces.
    const withHeader = /^\s*layout\s/.test(body['syntax'])
      ? body['syntax']
      : `layout "${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\n\n${body['syntax'].replace(/^\n+/, '')}`;
    requireParsed(withHeader, body['surface']);
    const layout = await layoutStore.create({ surface: body['surface'], name, syntax: withHeader });
    return c.json<Layout>(layout, 201);
  });

  app.put('/layouts/:id', async (c) => {
    const id = c.req.param('id');
    const existing = await layoutStore.get(id);
    if (!existing) throw layoutNotFound(id);

    const body = await readLayoutBody(c);
    if (typeof body['expectedUpdatedAt'] !== 'string') throw invalidRequest("'expectedUpdatedAt' is required.");
    const patch: { syntax?: string; prose?: string | null } = {};
    if ('syntax' in body) {
      if (typeof body['syntax'] !== 'string') throw invalidRequest("'syntax' must be a string.");
      requireParsed(body['syntax'], existing.surface);
      patch.syntax = body['syntax'];
    }
    if ('prose' in body) {
      if (body['prose'] !== null && typeof body['prose'] !== 'string') {
        throw invalidRequest("'prose' must be a string or null.");
      }
      patch.prose = body['prose'] as string | null;
    }

    const updated = await layoutStore.update(id, patch, body['expectedUpdatedAt']);
    if (!updated) throw editConflict('layout');
    return c.json<Layout>(updated);
  });

  app.post('/layouts/:id/default', async (c) => {
    const id = c.req.param('id');
    const layout = await layoutStore.get(id);
    if (!layout) throw layoutNotFound(id);
    const defaultId = await layoutStore.setDefault(layout.surface, id);
    return c.json<SetDefaultLayoutResponse>({ defaultId });
  });

  app.delete('/layouts/:id', async (c) => {
    await layoutStore.remove(c.req.param('id'));
    return c.body(null, 204);
  });

  // Prose → DSL + spec, no save (`requirements.md` §6.1). The model fills a
  // closed, catalog-derived schema (`layout/schema.ts`); an unconfigured or
  // unreachable gateway is `layout_compile_failed` and never blocks the
  // hand-edit path.
  app.post('/layouts/compile', async (c) => {
    const body = await readLayoutBody(c);
    if (!isLayoutSurface(body['surface'])) throw invalidRequest("'surface' must be 'analysis' or 'home'.");
    if (typeof body['prose'] !== 'string' || body['prose'].trim() === '') throw invalidRequest("'prose' is required.");
    const name = typeof body['name'] === 'string' && body['name'].trim() !== '' ? body['name'].trim() : 'Untitled';
    const currentSyntax = typeof body['currentSyntax'] === 'string' ? body['currentSyntax'] : undefined;

    const catalog = buildAnalysisCatalog(categories, metricFields);
    const { syntax, spec, unresolved } = await layoutCompiler.compile(body['prose'], catalog, name, currentSyntax);
    const response: CompileLayoutResponse = { syntax, spec, unresolved };
    return c.json(response);
  });

  app.post('/layouts/parse', async (c) => {
    const body = await readLayoutBody(c);
    if (!isLayoutSurface(body['surface'])) throw invalidRequest("'surface' must be 'analysis' or 'home'.");
    if (typeof body['syntax'] !== 'string') throw invalidRequest("'syntax' is required.");
    const { spec, canonicalSyntax, diagnostics } = parseAndCanonicalise(body['syntax'], body['surface']);
    const response: ParseLayoutResponse = { spec, canonicalSyntax, diagnostics };
    return c.json(response);
  });

  // One-shot: the pre-M20 client-only `journal:analysis-prefs` customization,
  // translated server-side (`layout/legacy-prefs.ts`) into a durable
  // "My layout" set as the analysis default. The client calls this once on
  // first load and then drops the key. Silent (`design.md` §4).
  app.post('/layouts/import-legacy-prefs', async (c) => {
    const body = await readLayoutBody(c);
    const prefs = body['prefs'];
    if (typeof prefs !== 'object' || prefs === null) throw invalidRequest("'prefs' must be an object.");
    const name = typeof body['name'] === 'string' && body['name'].trim() !== '' ? body['name'].trim() : 'My layout';

    const syntax = legacyPrefsToSyntax(prefs as LegacyAnalysisPrefs, name);
    const layout = await layoutStore.create({ surface: 'analysis', name, syntax });
    await layoutStore.setDefault('analysis', layout.id);
    const fresh = await layoutStore.get(layout.id);
    return c.json<Layout>(fresh ?? layout, 201);
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
