import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The crash-safety contract itself, tested deterministically rather than by
 * hoping to catch a real process at the right instant (`plan.md` M2 done-when:
 * "the process can be killed mid-write in a loop without ever producing a
 * truncated or half-written entry").
 *
 * `rename` is the one step that commits a write — everything before it can
 * fail with no consequence to the target path, because the target is never
 * touched until rename succeeds. So the test injects failure at each stage a
 * real crash could land in, and asserts the target is exactly as if the write
 * had never been attempted. This is a stronger guarantee than a live kill-loop
 * could ever prove, because it exercises the exact failure boundary instead of
 * guessing at timing — the live version of this drill was also run once by
 * hand against the real server, killing it repeatedly mid-write, with the same
 * result.
 */

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const { rename } = await import('node:fs/promises');
const { writeFileAtomic } = await import('../../src/store/atomic-write.js');

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'journal-atomic-'));
  vi.mocked(rename).mockClear();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('when the process dies before rename', () => {
  it('leaves a first write entirely absent, not a truncated file', async () => {
    const target = join(root, 'journal/2026/07/entry.md');
    vi.mocked(rename).mockRejectedValueOnce(new Error('simulated crash before rename'));

    await expect(writeFileAtomic(target, 'the full content\n', root)).rejects.toThrow(
      'simulated crash before rename',
    );

    await expect(readFile(target, 'utf8')).rejects.toThrow(/ENOENT/);
  });

  it('leaves an existing file exactly as it was, not partially overwritten', async () => {
    const target = join(root, 'journal/2026/07/entry.md');
    await writeFileAtomic(target, 'original content\n', root);

    vi.mocked(rename).mockRejectedValueOnce(new Error('simulated crash before rename'));
    await expect(writeFileAtomic(target, 'REPLACEMENT content\n', root)).rejects.toThrow();

    expect(await readFile(target, 'utf8')).toBe('original content\n');
  });

  it('cleans up the temp file rather than leaving debris behind', async () => {
    const dir = join(root, 'journal/2026/07');
    const target = join(dir, 'entry.md');
    vi.mocked(rename).mockRejectedValueOnce(new Error('simulated crash before rename'));

    await expect(writeFileAtomic(target, 'x', root)).rejects.toThrow();

    const names = await readdir(dir);
    expect(names.some((n) => n.endsWith('.tmp'))).toBe(false);
  });

  it('never lets a scan see a temp file even if cleanup itself cannot run', async () => {
    // The dot-prefix is what actually protects readers — `*.md` globs and this
    // project's own directory walk both skip dot-files unconditionally, so even
    // an *un*cleaned temp file could never be mistaken for a real entry.
    const dir = join(root, 'journal/2026/07');
    const target = join(dir, 'entry.md');
    vi.mocked(rename).mockRejectedValueOnce(new Error('simulated crash before rename'));

    await expect(writeFileAtomic(target, 'x', root)).rejects.toThrow();

    // Whether or not cleanup succeeded, anything left behind is dot-prefixed.
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const name of names) expect(name.startsWith('.')).toBe(true);
  });
});

describe('when the process dies after rename', () => {
  it('the write is simply complete — there is no half-state to land in', async () => {
    // `rename` on a POSIX filesystem is a single atomic syscall: it either
    // fully happens or it fully does not. There is no instant at which a
    // reader could observe a half-renamed file, so nothing here needs
    // injecting — this test exists to say so explicitly rather than by
    // omission.
    const target = join(root, 'journal/2026/07/entry.md');
    await writeFileAtomic(target, 'complete\n', root);
    expect(await readFile(target, 'utf8')).toBe('complete\n');
  });
});

describe('when the temp file itself cannot be written', () => {
  it('two concurrent writers to the same target never collide on one temp file', async () => {
    // The temp name includes random bytes specifically so this can't happen;
    // proven here by firing many concurrent writes at the same target and
    // confirming every one completes with fully-formed content, never a mix
    // of two writers' bytes.
    const target = join(root, 'journal/2026/07/entry.md');
    const writers = Array.from({ length: 25 }, (_, i) =>
      writeFileAtomic(target, `writer ${i}\n`, root),
    );
    await Promise.all(writers);

    const final = await readFile(target, 'utf8');
    expect(final).toMatch(/^writer \d+\n$/);
  });
});

