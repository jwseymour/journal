import { readdir, readFile, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import type { EntryMetadata, EntrySummary } from '@journal/contract';
import {
  attachmentConflict,
  editConflict,
  entryNotFound,
  invalidRequest,
  journalUnavailable,
  AppError,
} from '../errors.js';
import type { IndexRow, SqliteIndex } from '../index/sqlite-index.js';
import { excerpt } from '../record/excerpt.js';
import { normaliseBody, parseEntryFile, serialiseEntryFile } from '../record/frontmatter.js';
import { ENTRIES_DIR, ENTRY_EXTENSION, entryRelativePath } from '../record/filename.js';
import { contentHash } from '../record/hash.js';
import { ulid } from '../record/id.js';
import { nowTimestamp, parseTimestamp } from '../record/time.js';
import { writeFileAtomic } from './atomic-write.js';
import { decodeCursor, encodeCursor } from './cursor.js';
import type {
  AddAttachmentInput,
  AddAttachmentResult,
  CreateEntryInput,
  EntryStore,
  ListOptions,
  ListPeriodsResult,
  ListResult,
  StoreStats,
  StoredEntry,
  UpdateEntryInput,
} from './entry-store.js';

/**
 * The filesystem implementation of `EntryStore` — the markdown files, which
 * are canonical (`requirements.md` §7.3). The lookup and listing bookkeeping
 * lives in a persistent `SqliteIndex` (`plan.md` M5) rather than an in-memory
 * map, so a restart never has to re-read and re-parse the whole journal
 * before it can answer its first request.
 *
 * ## The index is a cache, never a source of truth for content
 *
 * `get`, `update` and `discardIfBlank` all read the entry file fresh from
 * disk before doing anything else — completely unchanged from M1/M2. The
 * index only ever answers "where is entry X" and "what belongs on a list
 * page." Deleting `index.db` and calling `rebuild()` reproduces it exactly,
 * because it holds nothing that cannot be re-derived from the files
 * (`requirements.md` §6.4).
 *
 * ## Reading is deliberately forgiving
 *
 * The journal directory is expected to be touched by hand: that is a stated
 * benefit of plain files, not an edge case. So a file that cannot be read as
 * an entry is **skipped and counted**, never allowed to fail the listing. One
 * damaged file must not put the other twenty years out of reach. The count
 * surfaces on `/health` so the damage is visible rather than silent.
 *
 * ## Incremental scanning
 *
 * A path already in the index is trusted without being re-read — the same
 * choice M1 made, now backed by SQLite instead of a `Map`. Content hashing
 * (`plan.md` M5: "never mtime" — mtime does not survive `cp -r` or
 * `git checkout`, this project's own backup and restore story) is what makes
 * `rebuild()` correct: a fresh scan from an empty index reads and hashes
 * every file, and produces byte-for-byte the same rows a live incremental
 * index converges to, which is the property the M5 done-when drill exists to
 * prove.
 */

/** Guards against a pathological run of id collisions rather than looping forever. */
const MAX_ID_ATTEMPTS = 8;

const toPosix = (path: string): string => (sep === '/' ? path : path.split(sep).join('/'));

function summarise(row: IndexRow): EntrySummary {
  return {
    id: row.id,
    created: row.created,
    ...(row.location ? { location: row.location } : {}),
    excerpt: row.excerpt,
  };
}

export class FsEntryStore implements EntryStore {
  readonly #journalRoot: string;
  readonly #entriesRoot: string;
  readonly #index: SqliteIndex;
  #inFlight: Promise<void> | null = null;

  constructor(journalRoot: string, index: SqliteIndex) {
    this.#journalRoot = journalRoot;
    this.#entriesRoot = join(journalRoot, ENTRIES_DIR);
    this.#index = index;
  }

  async create(input: CreateEntryInput): Promise<StoredEntry> {
    const created =
      input.created === undefined ? nowTimestamp() : parseTimestamp(input.created);
    if (!created) {
      throw invalidRequest(
        `'created' must be an RFC 3339 timestamp carrying a UTC offset, such as 2026-07-26T22:55:13+01:00.`,
      );
    }

    const body = normaliseBody(input.body);
    // Declining to commit an entry that was never written (`format.md` §5).
    // Not a deletion and not a validation of content — a body of nothing but
    // whitespace is the absence of writing, and there is nothing to keep.
    if (body.trim().length === 0) {
      throw invalidRequest('An entry with no writing in it is not created.');
    }

    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
      const id = ulid(created.epochMs);
      const relPath = entryRelativePath(id, created);
      const absPath = join(this.#journalRoot, relPath);

      // 80 bits of randomness makes this all but impossible, but "never reused"
      // is a promise about identity and is cheap to keep literally.
      if (await exists(absPath)) continue;

      const metadata: EntryMetadata = {
        id,
        created: created.canonical,
        ...(input.location ? { location: input.location } : {}),
      };

      const fileText = serialiseEntryFile(metadata, body);
      try {
        await writeFileAtomic(absPath, fileText, this.#journalRoot);
      } catch (cause) {
        throw journalUnavailable(`Could not write the entry to ${relPath}.`, cause);
      }

      const hash = contentHash(fileText);
      this.#index.upsert({
        id,
        absPath,
        relPath,
        epochMs: created.epochMs,
        created: metadata.created,
        ...(metadata.location ? { location: metadata.location } : {}),
        excerpt: excerpt(body),
        contentHash: hash,
      });

      return { ...metadata, body, path: relPath, contentHash: hash };
    }

    /* c8 ignore next */
    throw journalUnavailable('Could not find an unused entry id. This should be impossible.');
  }

  async get(id: string): Promise<StoredEntry | null> {
    await this.#refresh();
    const cached = this.#index.getById(id);
    if (!cached) return null;

    // Read through rather than serving the cached copy, so an entry edited in a
    // text editor is never shown stale. This is the read that matters most.
    let text: string;
    try {
      text = await readFile(cached.absPath, 'utf8');
    } catch (cause) {
      if (isNotFound(cause)) {
        this.#index.remove(cached.absPath);
        return null;
      }
      throw journalUnavailable(`Could not read ${cached.relPath}.`, cause);
    }

    const parsed = parseEntryFile(text, cached.relPath);
    if (parsed.metadata.id !== id) {
      // The file at that path is now a different entry. The row is stale.
      this.#index.remove(cached.absPath);
      return null;
    }

    // Opportunistic self-healing: if a hand-edit changed the file without a
    // scan having noticed yet, the read this method already had to do is
    // enough to bring the index back in line — no extra I/O beyond what
    // serving this request required anyway.
    const hash = contentHash(text);
    if (hash !== cached.contentHash) {
      this.#index.upsert({ ...cached, excerpt: excerpt(parsed.body), contentHash: hash });
    }

    return { ...parsed.metadata, body: parsed.body, path: cached.relPath, contentHash: hash };
  }

  async update(id: string, input: UpdateEntryInput): Promise<StoredEntry> {
    await this.#refresh();
    const cached = this.#index.getById(id);
    if (!cached) throw entryNotFound(id);

    // Read fresh — never trust the cache for the one check that exists
    // precisely because the cache can be stale (`plan.md` M2).
    let text: string;
    try {
      text = await readFile(cached.absPath, 'utf8');
    } catch (cause) {
      if (isNotFound(cause)) {
        this.#index.remove(cached.absPath);
        throw entryNotFound(id);
      }
      throw journalUnavailable(`Could not read ${cached.relPath}.`, cause);
    }

    const parsed = parseEntryFile(text, cached.relPath);
    if (parsed.metadata.id !== id) {
      this.#index.remove(cached.absPath);
      throw entryNotFound(id);
    }

    if (contentHash(text) !== input.contentHash) throw editConflict();

    // id, created and location never move. Editing changes what was written,
    // never when or where it was written (`requirements.md` §4.3).
    const fileText = serialiseEntryFile(parsed.metadata, input.body);
    try {
      await writeFileAtomic(cached.absPath, fileText, this.#journalRoot);
    } catch (cause) {
      throw journalUnavailable(`Could not write ${cached.relPath}.`, cause);
    }

    const newBody = normaliseBody(input.body);
    const newHash = contentHash(fileText);
    this.#index.upsert({ ...cached, excerpt: excerpt(newBody), contentHash: newHash });

    return {
      ...parsed.metadata,
      body: newBody,
      path: cached.relPath,
      contentHash: newHash,
    };
  }

  async discardIfBlank(id: string): Promise<void> {
    await this.#refresh();
    const cached = this.#index.getById(id);
    if (!cached) return; // Already gone. Nothing to discard, and that is not an error.

    let text: string;
    try {
      text = await readFile(cached.absPath, 'utf8');
    } catch (cause) {
      if (isNotFound(cause)) {
        this.#index.remove(cached.absPath);
        return;
      }
      throw journalUnavailable(`Could not read ${cached.relPath}.`, cause);
    }

    const parsed = parseEntryFile(text, cached.relPath);
    if (parsed.metadata.id !== id) {
      this.#index.remove(cached.absPath);
      return;
    }

    // The store enforces this itself, not just the caller: a file with any
    // content in it is never deleted by the application, full stop
    // (`format.md` §5).
    if (parsed.body.trim().length > 0) {
      throw invalidRequest(
        'This entry has writing in it and will not be discarded. Only a whitespace-only entry may be removed.',
      );
    }

    try {
      await unlink(cached.absPath);
    } catch (cause) {
      if (!isNotFound(cause)) throw journalUnavailable(`Could not remove ${cached.relPath}.`, cause);
    }

    this.#index.remove(cached.absPath);
  }

  async addAttachment(id: string, input: AddAttachmentInput): Promise<AddAttachmentResult> {
    await this.#refresh();
    const cached = this.#index.getById(id);
    if (!cached) throw entryNotFound(id);

    if (!isValidAttachmentFilename(input.filename)) {
      throw invalidRequest(`'${input.filename}' is not a usable attachment filename.`);
    }

    // Same stem as the entry file, sitting beside it (`format.md` §4) — the
    // one place identity depends on the filename rather than the id, because
    // a relative link has to resolve in a plain markdown viewer with no
    // application involved at all.
    const stem = basename(cached.absPath, ENTRY_EXTENSION);
    const attachmentDir = join(dirname(cached.absPath), stem);
    const targetPath = join(attachmentDir, input.filename);

    if (await exists(targetPath)) {
      throw attachmentConflict(input.filename);
    }

    try {
      await writeFileAtomic(targetPath, input.data, this.#journalRoot);
    } catch (cause) {
      throw journalUnavailable(
        `Could not write the attachment to ${relative(this.#journalRoot, targetPath)}.`,
        cause,
      );
    }

    return { relativeLink: `${stem}/${input.filename}` };
  }

  async list(options: ListOptions): Promise<ListResult> {
    await this.#refresh();
    const cursor = options.cursor === undefined ? null : decodeCursor(options.cursor);
    const period =
      options.year !== undefined && options.month !== undefined
        ? { year: options.year, month: options.month }
        : undefined;
    const { rows, hasMore } = this.#index.list(cursor, options.limit, period);
    const last = rows.at(-1);

    return {
      entries: rows.map(summarise),
      nextCursor: hasMore && last ? encodeCursor({ epochMs: last.epochMs, id: last.id }) : null,
    };
  }

  async listPeriods(): Promise<ListPeriodsResult> {
    await this.#refresh();
    return { periods: this.#index.listPeriods() };
  }

  async stats(): Promise<StoreStats> {
    await this.#refresh();
    return this.#index.stats();
  }

  /**
   * `rebuild --from-scratch` (`plan.md` M5, `requirements.md` §6.4): wipe the
   * index and reconstruct it entirely from a fresh directory walk. Not a
   * maintenance utility — this is the drill that proves the index is
   * genuinely disposable, and it is exactly what a first boot against an
   * empty index also does, one file at a time, via `#scan`.
   */
  async rebuild(): Promise<{ entryCount: number; unreadableCount: number }> {
    this.#index.clear();
    await this.#scan();
    return this.#index.stats();
  }

  /** Concurrent requests share one walk rather than each starting their own. */
  #refresh(): Promise<void> {
    this.#inFlight ??= this.#scan().finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  async #scan(): Promise<void> {
    const found = await this.#walk(this.#entriesRoot);
    const known = this.#index.knownPaths();

    // Drop anything that has vanished. A file disappearing is normal here, not
    // an error — the directory is a git working tree someone may check out.
    for (const absPath of known) {
      if (!found.has(absPath)) this.#index.remove(absPath);
    }

    for (const absPath of found) {
      // Trusted without a re-read, same as M1 — an already-known path's
      // content is only re-verified when something else already has to read
      // it anyway (`get`'s self-healing, above).
      if (known.has(absPath)) continue;

      const relPath = toPosix(relative(this.#journalRoot, absPath));
      let text: string;
      try {
        text = await readFile(absPath, 'utf8');
      } catch (cause) {
        if (isNotFound(cause)) continue;
        throw journalUnavailable(`Could not read ${relPath}.`, cause);
      }

      let parsed;
      try {
        parsed = parseEntryFile(text, relPath);
      } catch (cause) {
        if (cause instanceof AppError && cause.code === 'malformed_entry') {
          this.#index.markUnreadable(absPath);
          console.warn(`[journal] skipping unreadable entry — ${cause.message}`);
          continue;
        }
        throw cause;
      }

      // Two files claiming the same id is possible — someone copies an entry
      // rather than writing one. Resolved by keeping the lexically first
      // path, so the choice is stable across restarts regardless of
      // filesystem traversal order, and counting the other as unreadable so
      // it shows up on `/health`.
      const existing = this.#index.getById(parsed.metadata.id);
      if (existing && existing.absPath !== absPath) {
        const [winner, loser] =
          relPath < existing.relPath ? [absPath, existing.absPath] : [existing.absPath, absPath];
        if (winner === absPath) {
          this.#index.markUnreadable(loser);
          console.warn(
            `[journal] ${existing.relPath} repeats the id also claimed by ${relPath}; ignoring it (kept the lexically-first path).`,
          );
        } else {
          this.#index.markUnreadable(absPath);
          console.warn(
            `[journal] ${relPath} repeats the id already held by ${existing.relPath}; ignoring it.`,
          );
          continue;
        }
      }

      this.#index.upsert({
        id: parsed.metadata.id,
        absPath,
        relPath,
        epochMs: parsed.created.epochMs,
        created: parsed.metadata.created,
        ...(parsed.metadata.location ? { location: parsed.metadata.location } : {}),
        excerpt: excerpt(parsed.body),
        contentHash: contentHash(text),
      });
    }
  }

  /**
   * Collect every `*.md` file beneath `dir`.
   *
   * Recursive and shape-agnostic rather than assuming `YYYY/MM`. Writing always
   * uses the canonical layout, but reading should never hide someone's writing
   * because they reorganised their own directory by hand.
   *
   * Dot-directories are skipped, which keeps `.git` out of the walk without the
   * application knowing or caring that it is there (`requirements.md` §4.4).
   */
  async #walk(dir: string, found = new Set<string>()): Promise<Set<string>> {
    let items;
    try {
      items = await readdir(dir, { withFileTypes: true });
    } catch (cause) {
      // `journal/` not existing yet simply means no entries. It is created on
      // the first write; the application never creates the journal root itself.
      if (isNotFound(cause)) return found;
      throw journalUnavailable(`Could not read ${dir}.`, cause);
    }

    for (const item of items) {
      if (item.name.startsWith('.')) continue;
      const path = join(dir, item.name);
      if (item.isDirectory()) {
        await this.#walk(path, found);
      } else if (item.isFile() && item.name.endsWith(ENTRY_EXTENSION)) {
        found.add(path);
      }
    }
    return found;
  }
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

/**
 * A bare filename and nothing else — no path separators, no `..`, no leading
 * dot. Rejects path traversal outright rather than trying to sanitise it,
 * because a filename a caller cannot use is a smaller problem than one that
 * was silently rewritten into something else.
 */
function isValidAttachmentFilename(filename: string): boolean {
  if (filename.length === 0 || filename.length > 255) return false;
  if (filename === '.' || filename === '..') return false;
  if (filename.includes('/') || filename.includes('\\')) return false;
  if (filename.startsWith('.')) return false;
  return true;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}
