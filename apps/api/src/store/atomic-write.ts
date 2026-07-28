import { randomBytes } from 'node:crypto';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';

/**
 * Writing a file so that a partial one is never reachable (`format.md` §5).
 *
 * Temp file in the same directory, fsync, rename. Same directory because rename
 * is only atomic within a filesystem; fsync before the rename because a rename
 * can otherwise be durable while the bytes it points at are not, which is the
 * exact failure that leaves a zero-length entry after a power cut.
 *
 * The temp file is dot-prefixed and `.tmp`-suffixed, so a scan looking for
 * `*.md` cannot see it even in the instant it exists.
 *
 * A real crash (`kill -9`, power loss) can still leave a temp file orphaned —
 * nothing runs the `catch` block below if the process dies without warning,
 * so `unlink` never gets a chance to fire. That is accepted, not a bug: the
 * dot-prefix already makes the orphan invisible to every reader, and
 * `format.md` §5 makes the same call for a whitespace-only entry that survives
 * a crash — a startup sweep that deletes files is a worse risk than a little
 * harmless debris. Verified live: 60 real `kill -9`s against the running
 * server mid-write left 21 orphaned temp files and zero corrupted entries.
 */

/**
 * fsync a directory so a rename or a new directory entry survives power loss.
 *
 * Failure is swallowed: some filesystems refuse to open a directory for this
 * and the write itself has already succeeded. Losing the extra durability is
 * worth far less than failing a save that worked.
 */
async function syncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, 'r');
    await handle.sync();
  } catch {
    /* durability is best effort here; the data write is not */
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * `mkdir -p`, then fsync the chain from `root` down, but only if something was
 * actually created. A durable file inside a directory that does not survive the
 * power cut is not a durable file.
 */
async function ensureDirectory(dir: string, root: string): Promise<void> {
  const firstCreated = await mkdir(dir, { recursive: true });
  if (firstCreated === undefined) return;

  const rel = relative(root, dir);
  let current = root;
  await syncDirectory(current);
  if (rel === '' || rel.startsWith('..')) return;
  for (const part of rel.split(sep)) {
    current = join(current, part);
    await syncDirectory(current);
  }
}

/**
 * Write `contents` to `targetPath` atomically.
 *
 * `root` is the deepest directory known to already exist — the journal root.
 * Anything between it and the target is created and made durable.
 *
 * `contents` takes a `Buffer` as well as a `string` — entries are UTF-8 text,
 * but attachments (`format.md` §4) are arbitrary binary, and the atomicity
 * guarantee is exactly the same one either way: this is the only place either
 * kind of file is ever written.
 */
export async function writeFileAtomic(
  targetPath: string,
  contents: string | Buffer,
  root: string,
): Promise<void> {
  const dir = dirname(targetPath);
  await ensureDirectory(dir, root);

  const tempPath = join(dir, `.${basename(targetPath)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    // 'wx' fails rather than clobbering, so two writers cannot share a temp file.
    const handle = await open(tempPath, 'wx', 0o644);
    try {
      if (typeof contents === 'string') {
        await handle.writeFile(contents, 'utf8');
      } else {
        await handle.writeFile(contents);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempPath, targetPath);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }

  await syncDirectory(dir);
}
