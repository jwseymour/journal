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
 */
export async function writeFileAtomic(
  targetPath: string,
  contents: string,
  root: string,
): Promise<void> {
  const dir = dirname(targetPath);
  await ensureDirectory(dir, root);

  const tempPath = join(dir, `.${basename(targetPath)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    // 'wx' fails rather than clobbering, so two writers cannot share a temp file.
    const handle = await open(tempPath, 'wx', 0o644);
    try {
      await handle.writeFile(contents, 'utf8');
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
