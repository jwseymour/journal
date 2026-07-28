import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

/**
 * Configuration, resolved and validated once at boot.
 *
 * The rule that matters: **the journal directory is never invented.** If
 * `JOURNAL_DIR` is missing, wrong, or unwritable the process refuses to start
 * and says why. A backend that helpfully creates an empty journal somewhere
 * unexpected is a backend that can silently write a year of entries into the
 * wrong place (`plan.md` M1).
 */

export interface Config {
  /** The journal repository root — the directory holding `journal/`. */
  readonly journalDir: string;
  readonly host: string;
  readonly port: number;
  /** Browser origins permitted to call this API. Never a wildcard. */
  readonly allowedOrigins: readonly string[];
  /** The Hugging Face model id the local `Transcriber` loads. One config line,
   * per `plan.md` M4 — swapping it is the entire cost of trying a bigger model. */
  readonly whisperModel: string;
  /** Where the (one-time) downloaded model weights are cached. Derived,
   * regenerable, and outside the journal repository — a cache, not a record
   * (`requirements.md` §6.4). */
  readonly whisperCacheDir: string;
}

export const DEFAULT_PORT = 4319;

/** Loopback only. Going online is a deployment change, not a default. */
const DEFAULT_HOST = '127.0.0.1';

const DEFAULT_ORIGINS = ['http://localhost:3000', 'http://127.0.0.1:3000'];

/** The smallest English Whisper model — a deliberate default. Accuracy for a
 * larger model is one env var away; nobody should have to know that on day one. */
const DEFAULT_WHISPER_MODEL = 'Xenova/whisper-tiny.en';

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

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<Config> {
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
    whisperModel: env['WHISPER_MODEL']?.trim() || DEFAULT_WHISPER_MODEL,
    whisperCacheDir: expandHome(
      env['WHISPER_CACHE_DIR']?.trim() || resolve(homedir(), '.cache', 'journal', 'whisper-models'),
    ),
  };
}
