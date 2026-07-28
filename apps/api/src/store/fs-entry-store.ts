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
import { excerpt } from '../record/excerpt.js';
import { normaliseBody, parseEntryFile, serialiseEntryFile } from '../record/frontmatter.js';
import { ENTRIES_DIR, ENTRY_EXTENSION, entryRelativePath } from '../record/filename.js';
import { contentHash } from '../record/hash.js';
import { ulid } from '../record/id.js';
import { nowTimestamp, parseTimestamp } from '../record/time.js';
import { writeFileAtomic } from './atomic-write.js';
import { compareDescending, decodeCursor, encodeCursor, isAfterCursor } from './cursor.js';
import type {
  AddAttachmentInput,
  AddAttachmentResult,
  CreateEntryInput,
  EntryStore,
  ListOptions,
  ListResult,
  StoreStats,
  StoredEntry,
  UpdateEntryInput,
} from './entry-store.js';

/**
 * The filesystem implementation of `EntryStore` — the markdown files, which are
 * canonical (`requirements.md` §7.3).
 *
 * ## Reading is deliberately forgiving
 *
 * The journal directory is expected to be touched by hand: that is a stated
 * benefit of plain files, not an edge case. So a file that cannot be read as an
 * entry is **skipped and counted**, never allowed to fail the listing. One
 * damaged file must not put the other twenty years out of reach. The count
 * surfaces on `/health` so the damage is visible rather than silent.
 *
 * ## The id index
 *
 * `id` → path is an in-memory map built by scanning the directory, exactly as
 * `plan.md` M1 specifies. Correct at hundreds of entries and replaced by the
 * SQLite index in M5, with the API unchanged. Refreshing compares the *set of
 * file paths* and reads only what is new, so the common case is one recursive
 * `readdir` and no file reads at all.
 *
 * One consequence, accepted for M1: a file edited in place while the server is
 * running keeps its old excerpt in the list until a restart. `get` always reads
 * the file fresh, so opening an entry never shows stale prose — and M1 has no
 * edit endpoint, so the only way to reach that state is an external editor.
 * M5 replaces this with content hashing (`plan.md` M5).
 */

/** Guards against a pathological run of id collisions rather than looping forever. */
const MAX_ID_ATTEMPTS = 8;

interface CachedEntry {
  readonly absPath: string;
  /** Journal-root-relative, POSIX separators. */
  readonly relPath: string;
  readonly metadata: EntryMetadata;
  /** Lifted out of `metadata` so a cached entry is directly an ordering key. */
  readonly id: string;
  readonly epochMs: number;
  readonly excerpt: string;
}

const toPosix = (path: string): string => (sep === '/' ? path : path.split(sep).join('/'));

function summarise(entry: CachedEntry): EntrySummary {
  return { ...entry.metadata, excerpt: entry.excerpt };
}

export class FsEntryStore implements EntryStore {
  readonly #journalRoot: string;
  readonly #entriesRoot: string;

  #byPath = new Map<string, CachedEntry>();
  #byId = new Map<string, CachedEntry>();
  #ordered: CachedEntry[] = [];
  #unreadable = new Set<string>();
  #inFlight: Promise<void> | null = null;

  constructor(journalRoot: string) {
    this.#journalRoot = journalRoot;
    this.#entriesRoot = join(journalRoot, ENTRIES_DIR);
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

      const cached: CachedEntry = {
        absPath,
        relPath,
        metadata,
        id,
        epochMs: created.epochMs,
        excerpt: excerpt(body),
      };
      this.#insert(cached);

      return { ...metadata, body, path: relPath, contentHash: contentHash(fileText) };
    }

    /* c8 ignore next */
    throw journalUnavailable('Could not find an unused entry id. This should be impossible.');
  }

  async get(id: string): Promise<StoredEntry | null> {
    await this.#refresh();
    const cached = this.#byId.get(id);
    if (!cached) return null;

    // Read through rather than serving the cached copy, so an entry edited in a
    // text editor is never shown stale. This is the read that matters most.
    let text: string;
    try {
      text = await readFile(cached.absPath, 'utf8');
    } catch (cause) {
      if (isNotFound(cause)) {
        this.#invalidate();
        return null;
      }
      throw journalUnavailable(`Could not read ${cached.relPath}.`, cause);
    }

    const parsed = parseEntryFile(text, cached.relPath);
    if (parsed.metadata.id !== id) {
      // The file at that path is now a different entry. The map is stale.
      this.#invalidate();
      return null;
    }

    return { ...parsed.metadata, body: parsed.body, path: cached.relPath, contentHash: contentHash(text) };
  }

  async update(id: string, input: UpdateEntryInput): Promise<StoredEntry> {
    await this.#refresh();
    const cached = this.#byId.get(id);
    if (!cached) throw entryNotFound(id);

    // Read fresh — never trust the cache for the one check that exists
    // precisely because the cache can be stale (`plan.md` M2).
    let text: string;
    try {
      text = await readFile(cached.absPath, 'utf8');
    } catch (cause) {
      if (isNotFound(cause)) {
        this.#invalidate();
        throw entryNotFound(id);
      }
      throw journalUnavailable(`Could not read ${cached.relPath}.`, cause);
    }

    const parsed = parseEntryFile(text, cached.relPath);
    if (parsed.metadata.id !== id) {
      this.#invalidate();
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
    this.#insert({ ...cached, excerpt: excerpt(newBody) });

    return {
      ...parsed.metadata,
      body: newBody,
      path: cached.relPath,
      contentHash: contentHash(fileText),
    };
  }

  async discardIfBlank(id: string): Promise<void> {
    await this.#refresh();
    const cached = this.#byId.get(id);
    if (!cached) return; // Already gone. Nothing to discard, and that is not an error.

    let text: string;
    try {
      text = await readFile(cached.absPath, 'utf8');
    } catch (cause) {
      if (isNotFound(cause)) {
        this.#invalidate();
        return;
      }
      throw journalUnavailable(`Could not read ${cached.relPath}.`, cause);
    }

    const parsed = parseEntryFile(text, cached.relPath);
    if (parsed.metadata.id !== id) {
      this.#invalidate();
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

    this.#byPath.delete(cached.absPath);
    this.#byId.delete(id);
    this.#ordered = this.#ordered.filter((entry) => entry.id !== id);
  }

  async addAttachment(id: string, input: AddAttachmentInput): Promise<AddAttachmentResult> {
    await this.#refresh();
    const cached = this.#byId.get(id);
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

    const start = cursor
      ? this.#ordered.findIndex((entry) => isAfterCursor(entry, cursor))
      : 0;
    if (start === -1) return { entries: [], nextCursor: null };

    const page = this.#ordered.slice(start, start + options.limit);
    const last = page.at(-1);
    const hasMore = last !== undefined && start + page.length < this.#ordered.length;

    return {
      entries: page.map(summarise),
      nextCursor: hasMore && last ? encodeCursor({ epochMs: last.epochMs, id: last.id }) : null,
    };
  }

  async stats(): Promise<StoreStats> {
    await this.#refresh();
    return { entryCount: this.#ordered.length, unreadableCount: this.#unreadable.size };
  }

  #invalidate(): void {
    this.#byPath.clear();
    this.#byId.clear();
    this.#ordered = [];
    this.#unreadable.clear();
  }

  /**
   * Upsert into every index. Used both for a brand-new entry and for an
   * edited one — an edit never changes `epochMs` or `id`, so an existing
   * entry is replaced in place rather than re-sorted.
   */
  #insert(entry: CachedEntry): void {
    this.#byPath.set(entry.absPath, entry);
    this.#byId.set(entry.id, entry);
    const existingIndex = this.#ordered.findIndex((e) => e.id === entry.id);
    if (existingIndex === -1) {
      this.#ordered.push(entry);
      this.#ordered.sort(compareDescending);
    } else {
      this.#ordered[existingIndex] = entry;
    }
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

    // Drop anything that has vanished. A file disappearing is normal here, not
    // an error — the directory is a git working tree someone may check out.
    for (const absPath of [...this.#byPath.keys()]) {
      if (!found.has(absPath)) this.#byPath.delete(absPath);
    }
    for (const absPath of [...this.#unreadable]) {
      if (!found.has(absPath)) this.#unreadable.delete(absPath);
    }

    for (const absPath of found) {
      if (this.#byPath.has(absPath) || this.#unreadable.has(absPath)) continue;
      const relPath = toPosix(relative(this.#journalRoot, absPath));
      try {
        const parsed = parseEntryFile(await readFile(absPath, 'utf8'), relPath);
        this.#byPath.set(absPath, {
          absPath,
          relPath,
          metadata: parsed.metadata,
          id: parsed.metadata.id,
          epochMs: parsed.created.epochMs,
          excerpt: excerpt(parsed.body),
        });
      } catch (cause) {
        if (isNotFound(cause)) continue;
        if (cause instanceof AppError && cause.code === 'malformed_entry') {
          this.#unreadable.add(absPath);
          console.warn(`[journal] skipping unreadable entry — ${cause.message}`);
          continue;
        }
        throw journalUnavailable(`Could not read ${relPath}.`, cause);
      }
    }

    this.#reindex();
  }

  /**
   * Rebuild the id map and the ordering from the path map.
   *
   * Two files claiming the same id is possible — someone copies an entry rather
   * than writing one. Resolved by keeping the lexically first path, so the
   * choice is at least stable across restarts, and counting the other as
   * unreadable so it shows up on `/health`.
   */
  #reindex(): void {
    this.#byId.clear();
    const entries = [...this.#byPath.values()].sort((a, b) =>
      a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0,
    );

    const kept: CachedEntry[] = [];
    for (const entry of entries) {
      const existing = this.#byId.get(entry.id);
      if (existing) {
        this.#unreadable.add(entry.absPath);
        console.warn(
          `[journal] ${entry.relPath} repeats the id already held by ${existing.relPath}; ignoring it.`,
        );
        continue;
      }
      this.#byId.set(entry.id, entry);
      kept.push(entry);
    }

    this.#ordered = kept.sort(compareDescending);
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
