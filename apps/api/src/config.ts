import { config as loadDotenv } from 'dotenv';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Configuration, resolved and validated once at boot.
 *
 * The rule that matters: **the journal directory is never invented.** If
 * `JOURNAL_DIR` is missing, wrong, or unwritable the process refuses to start
 * and says why. A backend that helpfully creates an empty journal somewhere
 * unexpected is a backend that can silently write a year of entries into the
 * wrong place (`plan.md` M1).
 *
 * `.env`, at the repository root, is the one place a secret like
 * `AI_GATEWAY_API_KEY` (`plan.md` M7) belongs — never in a script argument,
 * where it would sit in shell history. Resolved from this file's own
 * location rather than `process.cwd()`, so it loads correctly whether this
 * runs via `npm run dev:api` from the repo root (cwd becomes `apps/api`) or
 * directly from within `apps/api`. `.env*` is already `.gitignore`d by the
 * Next.js default in this repo, so this was never one edit away from being
 * committed. A module-level side effect, not something `loadConfig` does
 * itself, so it runs exactly once regardless of how many times config is
 * loaded — and it only ever *sets* `process.env`, never overriding a value
 * already present, so an explicitly-exported env var still wins.
 */
loadDotenv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.env'), quiet: true });

export interface Config {
  /** The journal repository root — the directory holding `journal/`. */
  readonly journalDir: string;
  readonly host: string;
  readonly port: number;
  /** Browser origins permitted to call this API. Never a wildcard. */
  readonly allowedOrigins: readonly string[];
  /** This API's own externally-reachable origin, e.g. `https://api.example.com`
   * — `undefined` in local dev, where there is no reverse proxy in front of
   * it to make this ambiguous. Reconstructing this from the request itself
   * (`Host` header, `X-Forwarded-Proto`) would mean trusting whatever a
   * proxy chose to forward — fragile, and wrong for one specific reason
   * here: Caddy terminates TLS and speaks plain HTTP to this process, so
   * the request's own scheme is always `http` regardless of what the
   * browser used. Set explicitly instead, the same way `WEB_ORIGIN`
   * already is, and used for exactly two things that must be unambiguous:
   * the OAuth `redirect_uri` Google is told to trust, and one more entry
   * in `allowedHosts` below. */
  readonly publicUrl: string | undefined;
  /** The Hugging Face model id the local `Transcriber` loads. One config line,
   * per `plan.md` M4 — swapping it is the entire cost of trying a bigger model. */
  readonly whisperModel: string;
  /** Where the (one-time) downloaded model weights are cached. Derived,
   * regenerable, and outside the journal repository — a cache, not a record
   * (`requirements.md` §6.4). */
  readonly whisperCacheDir: string;
  /** The SQLite index (`plan.md` M5). Outside the journal repository, and
   * deletable at any time — `rebuild --from-scratch` is what proves that in
   * practice rather than only in principle (`requirements.md` §6.4). */
  readonly indexDbPath: string;
  /** The Hugging Face model id the local `Embedder` loads (`plan.md` M6). Local
   * specifically so a full re-embed of the corpus costs time, not money. */
  readonly embeddingModel: string;
  /** The vector length `embeddingModel` produces. Not something boot can
   * discover without loading the model — and boot must never wait on that
   * (`plan.md` M4's reasoning for the transcriber, applied here too) — so a
   * model swap means updating this alongside it. */
  readonly embeddingDimensions: number;
  /** Where the (one-time) downloaded embedding model weights are cached.
   * Kept separate from `whisperCacheDir` — different model, different
   * files — even though both are derived and regenerable the same way. */
  readonly embeddingCacheDir: string;
  /** Vercel AI Gateway credential (`plan.md` M7, `requirements.md` §7.6).
   * `undefined`, not a fatal boot error, when absent — extraction is a
   * whole optional subsystem layered on a journal that must keep writing
   * and reading without it; only the extraction routes themselves need to
   * refuse clearly when this is missing. */
  readonly aiGatewayApiKey: string | undefined;
  /** The `creator/model-name` string the gateway resolves (`requirements.md`
   * §7.6) — the *only* place any provider is named. Changing model is
   * changing this one line, never the extraction logic or schemas around it. */
  readonly extractionModel: string;
  /** The `creator/model-name` string for the chat feature's model — kept
   * separate from `extractionModel` even though it defaults to the same
   * value, because chat needs tool-calling ability and the two may need to
   * diverge without one change accidentally affecting the other. */
  readonly chatModel: string;

  /** `fs` (default) or `s3` (`plan.md` M11). Which `EntryStore` boot
   * constructs. Defaults to `fs` so nothing about local dev changes for
   * anyone who has not opted in. */
  readonly storageBackend: 'fs' | 's3';
  /** Required only when `storageBackend` is `s3` — same "fail loudly at
   * boot, never guess" treatment `journalDir` gets. */
  readonly s3Bucket: string | undefined;
  readonly awsRegion: string | undefined;
  readonly awsAccessKeyId: string | undefined;
  readonly awsSecretAccessKey: string | undefined;

  /** The one identity auth ever accepts (`plan.md` M11) — this is a
   * single-user system, so there is no users table, only an allowlist of
   * one address. */
  readonly authorizedEmail: string;
  /** Google OAuth client credentials. `undefined`, not a fatal boot error,
   * when absent — the same "whole subsystem is optional, fails clearly at
   * the point of use" treatment `aiGatewayApiKey` gets. */
  readonly googleClientId: string | undefined;
  readonly googleClientSecret: string | undefined;
  /** An argon2id hash, generated once via `npm run set-password`. `undefined`
   * disables the password login path, not the server. */
  readonly authPasswordHash: string | undefined;
  /** Seals the session cookie and signs bearer tokens. Auth is enforced only
   * when this is set — its absence means "auth is not configured yet," the
   * same local-dev-unaffected-by-default posture `storageBackend` takes, not
   * a silent security hole in a deployed instance where it is expected to be
   * set. */
  readonly sessionSecret: string | undefined;
}

export const DEFAULT_PORT = 4319;

/** Loopback only. Going online is a deployment change, not a default. */
const DEFAULT_HOST = '127.0.0.1';

const DEFAULT_ORIGINS = ['http://localhost:3000', 'http://127.0.0.1:3000'];

/** The smallest English Whisper model — a deliberate default. Accuracy for a
 * larger model is one env var away; nobody should have to know that on day one. */
const DEFAULT_WHISPER_MODEL = 'Xenova/whisper-tiny.en';

/** A small, well-established sentence-embedding model — fast enough to embed
 * on every write without a visible pause. */
const DEFAULT_EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';
const DEFAULT_EMBEDDING_DIMENSIONS = 384;

/** Confirmed by hand against the real gateway (`plan.md` M7) — not the
 * cheapest available model, but a deliberate default rather than an
 * arbitrary one. One env var away from anything else the gateway serves. */
const DEFAULT_EXTRACTION_MODEL = 'anthropic/claude-sonnet-5';

/** Same default as extraction — it is already tool-calling-capable, so
 * there is no reason for day one to name a different model. */
const DEFAULT_CHAT_MODEL = 'anthropic/claude-sonnet-5';

/** The one person this system is for (`plan.md` M11). Overridable, but
 * defaulting it means a fresh deploy is gated to the right person even
 * before `.env` is fully filled in. */
const DEFAULT_AUTHORIZED_EMAIL = 'seymour.w.jack@gmail.com';

function readEmbeddingDimensions(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_EMBEDDING_DIMENSIONS;
  const dimensions = Number(raw);
  if (!Number.isInteger(dimensions) || dimensions < 1) {
    throw new ConfigError(`EMBEDDING_DIMENSIONS must be a positive whole number — got '${raw}'.`);
  }
  return dimensions;
}

export class ConfigError extends Error {}

/**
 * `~` is expanded because it is what anyone would write, and a path taken
 * literally as `./~/Journal` fails in a confusing way rather than a clear one.
 */
function expandHome(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return resolve(homedir(), value.slice(2));
  return value;
}

function readPort(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`PORT must be a whole number between 1 and 65535 — got '${raw}'.`);
  }
  return port;
}

function readOrigins(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw.trim() === '') return DEFAULT_ORIGINS;
  const origins = raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (origins.includes('*')) {
    throw new ConfigError(
      'WEB_ORIGIN may not be "*". The allowlist is explicit by design (`plan.md` M1).',
    );
  }
  return origins;
}

function readPublicUrl(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.origin;
  } catch {
    throw new ConfigError(`PUBLIC_URL must be a full URL, e.g. 'https://api.example.com' — got '${value}'.`);
  }
}

function readStorageBackend(raw: string | undefined): 'fs' | 's3' {
  const value = raw?.trim() || 'fs';
  if (value !== 'fs' && value !== 's3') {
    throw new ConfigError(`STORAGE_BACKEND must be 'fs' or 's3' — got '${value}'.`);
  }
  return value;
}

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<Config> {
  const storageBackend = readStorageBackend(env['STORAGE_BACKEND']);
  const s3Bucket = env['S3_BUCKET']?.trim() || undefined;
  const awsRegion = env['AWS_REGION']?.trim() || undefined;
  if (storageBackend === 's3' && (!s3Bucket || !awsRegion)) {
    throw new ConfigError(
      'STORAGE_BACKEND is `s3` but S3_BUCKET and/or AWS_REGION is not set. Both are required to store entries in S3.',
    );
  }

  const raw = env['JOURNAL_DIR'];
  if (raw === undefined || raw.trim() === '') {
    throw new ConfigError(
      'JOURNAL_DIR is not set. Point it at your journal repository — the directory that contains `journal/`. It must already exist; this application will not create it.',
    );
  }

  const expanded = expandHome(raw.trim());
  const journalDir = isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);

  let info;
  try {
    info = await stat(journalDir);
  } catch {
    throw new ConfigError(
      `JOURNAL_DIR points at ${journalDir}, which does not exist. Create it yourself — the application never creates the journal directory (\`requirements.md\` §7.4).`,
    );
  }
  if (!info.isDirectory()) {
    throw new ConfigError(`JOURNAL_DIR points at ${journalDir}, which is not a directory.`);
  }

  try {
    await access(journalDir, constants.R_OK | constants.W_OK);
  } catch {
    throw new ConfigError(`JOURNAL_DIR at ${journalDir} is not readable and writable.`);
  }

  return {
    journalDir,
    host: env['HOST']?.trim() || DEFAULT_HOST,
    port: readPort(env['PORT']),
    allowedOrigins: readOrigins(env['WEB_ORIGIN']),
    publicUrl: readPublicUrl(env['PUBLIC_URL']),
    whisperModel: env['WHISPER_MODEL']?.trim() || DEFAULT_WHISPER_MODEL,
    whisperCacheDir: expandHome(
      env['WHISPER_CACHE_DIR']?.trim() || resolve(homedir(), '.cache', 'journal', 'whisper-models'),
    ),
    indexDbPath: expandHome(
      env['INDEX_DB_PATH']?.trim() || resolve(homedir(), '.cache', 'journal', 'index.db'),
    ),
    embeddingModel: env['EMBEDDING_MODEL']?.trim() || DEFAULT_EMBEDDING_MODEL,
    embeddingDimensions: readEmbeddingDimensions(env['EMBEDDING_DIMENSIONS']),
    embeddingCacheDir: expandHome(
      env['EMBEDDING_CACHE_DIR']?.trim() || resolve(homedir(), '.cache', 'journal', 'embedding-models'),
    ),
    aiGatewayApiKey: env['AI_GATEWAY_API_KEY']?.trim() || undefined,
    extractionModel: env['EXTRACTION_MODEL']?.trim() || DEFAULT_EXTRACTION_MODEL,
    chatModel: env['CHAT_MODEL']?.trim() || DEFAULT_CHAT_MODEL,
    storageBackend,
    s3Bucket,
    awsRegion,
    awsAccessKeyId: env['AWS_ACCESS_KEY_ID']?.trim() || undefined,
    awsSecretAccessKey: env['AWS_SECRET_ACCESS_KEY']?.trim() || undefined,
    authorizedEmail: env['AUTHORIZED_EMAIL']?.trim() || DEFAULT_AUTHORIZED_EMAIL,
    googleClientId: env['GOOGLE_CLIENT_ID']?.trim() || undefined,
    googleClientSecret: env['GOOGLE_CLIENT_SECRET']?.trim() || undefined,
    authPasswordHash: env['AUTH_PASSWORD_HASH']?.trim() || undefined,
    sessionSecret: env['SESSION_SECRET']?.trim() || undefined,
  };
}
