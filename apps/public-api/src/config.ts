import { config as loadDotenv } from 'dotenv';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Configuration for the public-facing surface (`requirements.md` §10,
 * `plan.md` M14) — deliberately its own small config, not a reuse of
 * `apps/api/src/config.ts`. This service reads the same `.env` and the same
 * `INDEX_DB_PATH`/`JOURNAL_DIR`/S3 settings the private API already
 * validates, but never the private API's auth or model settings — it has
 * no business knowing them, and importing that config module would make it
 * easy to accidentally reach for something this service must never touch.
 *
 * Same `.env` location as `apps/api` — resolved from this file's own
 * location so it loads correctly regardless of the working directory this
 * runs from.
 */
loadDotenv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.env'), quiet: true });

export interface PublicApiConfig {
  readonly host: string;
  readonly port: number;
  /** Browser origins permitted to call this API — the blog frontend's own
   * origin(s), never the private `apps/web`'s. Never a wildcard. */
  readonly allowedOrigins: readonly string[];

  /** `fs` (default) or `s3` — must agree with whatever `apps/api` is
   * actually storing documents in, since this service reads the same
   * files. There is no independent choice to make here. */
  readonly storageBackend: 'fs' | 's3';
  /** Required only when `storageBackend` is `fs`. */
  readonly journalDir: string | undefined;
  /** Required only when `storageBackend` is `s3`. */
  readonly s3Bucket: string | undefined;
  readonly awsRegion: string | undefined;
  readonly awsAccessKeyId: string | undefined;
  readonly awsSecretAccessKey: string | undefined;

  /**
   * The shared SQLite index the private API's `DocumentsIndex` already
   * builds and migrates. This service only ever opens it read-only and
   * never creates, migrates, or writes to it — see `index-reader.ts`.
   */
  readonly indexDbPath: string;
}

/** Distinct from the private API's default (`4319`) — the two are meant to
 * run side by side on the same host. */
export const DEFAULT_PORT = 4320;

/** Loopback only, exactly like the private API — reaching the outside world
 * is a reverse proxy's job, not this process's. */
const DEFAULT_HOST = '127.0.0.1';

/** Distinct from `apps/web`'s default (`3000`) — the blog is a separate
 * frontend, on its own port in dev and its own domain in production. */
const DEFAULT_ORIGINS = ['http://localhost:3500', 'http://127.0.0.1:3500'];

export class ConfigError extends Error {}

function expandHome(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return resolve(homedir(), value.slice(2));
  return value;
}

function readPort(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`PUBLIC_API_PORT must be a whole number between 1 and 65535 — got '${raw}'.`);
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
    throw new ConfigError('BLOG_ORIGIN may not be "*". The allowlist is explicit by design.');
  }
  return origins;
}

function readStorageBackend(raw: string | undefined): 'fs' | 's3' {
  const value = raw?.trim() || 'fs';
  if (value !== 'fs' && value !== 's3') {
    throw new ConfigError(`STORAGE_BACKEND must be 'fs' or 's3' — got '${value}'.`);
  }
  return value;
}

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<PublicApiConfig> {
  const storageBackend = readStorageBackend(env['STORAGE_BACKEND']);
  const s3Bucket = env['S3_BUCKET']?.trim() || undefined;
  const awsRegion = env['AWS_REGION']?.trim() || undefined;
  if (storageBackend === 's3' && (!s3Bucket || !awsRegion)) {
    throw new ConfigError(
      'STORAGE_BACKEND is `s3` but S3_BUCKET and/or AWS_REGION is not set. Both are required to read documents from S3.',
    );
  }

  let journalDir: string | undefined;
  if (storageBackend === 'fs') {
    const raw = env['JOURNAL_DIR'];
    if (raw === undefined || raw.trim() === '') {
      throw new ConfigError('JOURNAL_DIR is not set. Point it at the same journal repository apps/api uses.');
    }
    const expanded = expandHome(raw.trim());
    journalDir = isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);

    let info;
    try {
      info = await stat(journalDir);
    } catch {
      throw new ConfigError(`JOURNAL_DIR points at ${journalDir}, which does not exist.`);
    }
    if (!info.isDirectory()) {
      throw new ConfigError(`JOURNAL_DIR points at ${journalDir}, which is not a directory.`);
    }
    try {
      await access(journalDir, constants.R_OK);
    } catch {
      throw new ConfigError(`JOURNAL_DIR at ${journalDir} is not readable.`);
    }
  }

  const rawIndexPath = env['INDEX_DB_PATH'];
  if (rawIndexPath === undefined || rawIndexPath.trim() === '') {
    throw new ConfigError(
      'INDEX_DB_PATH is not set. Point it at the same index database apps/api uses — this service never builds its own.',
    );
  }
  const indexDbPath = expandHome(rawIndexPath.trim());
  try {
    await access(indexDbPath, constants.R_OK);
  } catch {
    throw new ConfigError(
      `INDEX_DB_PATH at ${indexDbPath} does not exist or is not readable. This service never creates it — start apps/api against this journal first.`,
    );
  }

  return {
    host: env['PUBLIC_API_HOST']?.trim() || DEFAULT_HOST,
    port: readPort(env['PUBLIC_API_PORT']),
    allowedOrigins: readOrigins(env['BLOG_ORIGIN']),
    storageBackend,
    journalDir,
    s3Bucket,
    awsRegion,
    awsAccessKeyId: env['AWS_ACCESS_KEY_ID']?.trim() || undefined,
    awsSecretAccessKey: env['AWS_SECRET_ACCESS_KEY']?.trim() || undefined,
    indexDbPath,
  };
}
