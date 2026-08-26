import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { ConfigError, loadConfig } from './config.js';
import { SqliteIndex } from './index/sqlite-index.js';
import { contentHash } from './record/hash.js';
import { ENTRIES_DIR } from './record/filename.js';
import { FsEntryStore } from './store/fs-entry-store.js';
import { S3EntryStore } from './store/s3-entry-store.js';

/**
 * The one-time cutover (`plan.md` M11): copy every entry and attachment
 * from `JOURNAL_DIR` into the configured S3 bucket, then verify the copy
 * before anyone starts relying on it. Run it yourself: `npm run
 * migrate-to-s3 -w @journal/api`, with `STORAGE_BACKEND=s3` (and
 * `S3_BUCKET`/`AWS_REGION`/credentials) set in `.env`.
 *
 * Implemented with the SDK directly rather than shelling out to the `aws`
 * CLI's `s3 sync` — this repository has no other dependency on that CLI
 * being installed, and a plain directory walk plus `PutObject` needs
 * nothing beyond the dependency `S3EntryStore` already carries. The
 * *ongoing* export/import story (`requirements.md` §7.3) is still `aws s3
 * sync` by hand, once — this script only replaces that for the one-time
 * cutover, where a built-in count-and-hash verification matters more than
 * reusing the CLI's own (already well-tested) copy logic.
 *
 * `JOURNAL_DIR` is left completely untouched — kept as a frozen snapshot at
 * the moment of cutover, per the plan, not deleted or modified.
 */

/** How many entries to spot-check by content hash after the copy. Enough to
 * catch a systematic problem (wrong encoding, truncated body) without
 * hashing the whole corpus twice for a corpus that could be years long. */
const SAMPLE_SIZE = 25;

async function collectFiles(dir: string, root: string, found: string[] = []): Promise<string[]> {
  let items;
  try {
    items = await readdir(dir, { withFileTypes: true });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return found;
    throw cause;
  }
  for (const item of items) {
    if (item.name.startsWith('.')) continue; // .git, dotfiles — never part of the record.
    const path = join(dir, item.name);
    if (item.isDirectory()) {
      await collectFiles(path, root, found);
    } else if (item.isFile()) {
      found.push(path);
    }
  }
  return found;
}

function toPosix(path: string): string {
  return path.split('\\').join('/');
}

async function main(): Promise<void> {
  const config = await loadConfig();
  if (config.storageBackend !== 's3' || !config.s3Bucket || !config.awsRegion) {
    console.error(
      '[journal] cannot migrate: set STORAGE_BACKEND=s3, S3_BUCKET and AWS_REGION in .env before running this.',
    );
    process.exitCode = 1;
    return;
  }

  const entriesRoot = join(config.journalDir, ENTRIES_DIR);
  console.log(`[journal] migrating ${entriesRoot} -> s3://${config.s3Bucket}/${ENTRIES_DIR}/`);

  const s3 = new S3Client({
    region: config.awsRegion,
    ...(config.awsAccessKeyId && config.awsSecretAccessKey
      ? { credentials: { accessKeyId: config.awsAccessKeyId, secretAccessKey: config.awsSecretAccessKey } }
      : {}),
  });

  const files = await collectFiles(entriesRoot, config.journalDir);
  console.log(`[journal] found ${files.length} files (entries + attachments) to copy`);

  let copied = 0;
  for (const absPath of files) {
    const key = toPosix(relative(config.journalDir, absPath));
    const body = await readFile(absPath);
    await s3.send(
      new PutObjectCommand({
        Bucket: config.s3Bucket,
        Key: key,
        Body: body,
        ...(key.endsWith('.md') ? { ContentType: 'text/markdown; charset=utf-8' } : {}),
      }),
    );
    copied += 1;
    if (copied % 200 === 0) console.log(`[journal]   ...${copied}/${files.length}`);
  }
  console.log(`[journal] copied ${copied} files`);

  // Verify: entry count matches, via a fresh in-memory rebuild of each side —
  // never trust the copy loop above's own bookkeeping for this.
  console.log('[journal] verifying...');
  const localIndex = new SqliteIndex(':memory:');
  const localStore = new FsEntryStore(config.journalDir, localIndex);
  const localStats = await localStore.rebuild();

  const s3Index = new SqliteIndex(':memory:');
  const s3Store = new S3EntryStore(s3, config.s3Bucket, s3Index);
  const s3Stats = await s3Store.rebuild();

  if (localStats.entryCount !== s3Stats.entryCount) {
    throw new Error(
      `Entry count mismatch after migration: local has ${localStats.entryCount}, S3 has ${s3Stats.entryCount}. Not verified — investigate before relying on the bucket.`,
    );
  }
  console.log(`[journal] entry count matches: ${localStats.entryCount}`);

  // Content-hash a random sample, straight from each side's own read path —
  // exercises exactly the bytes each `EntryStore.get()` would actually return.
  const { entries } = await localStore.list({ limit: SAMPLE_SIZE * 20 });
  const sample = shuffle(entries.map((e) => e.id)).slice(0, SAMPLE_SIZE);
  let mismatches = 0;
  for (const id of sample) {
    const local = await localStore.get(id);
    const remote = await s3Store.get(id);
    if (!local || !remote || contentHash(local.body) !== contentHash(remote.body)) {
      mismatches += 1;
      console.error(`[journal]   MISMATCH on entry ${id}`);
    }
  }
  if (mismatches > 0) {
    throw new Error(`${mismatches}/${sample.length} sampled entries did not match after migration.`);
  }
  console.log(`[journal] content hash matches on ${sample.length} sampled entries`);
  console.log(
    `[journal] migration verified. ${config.journalDir} is left untouched as a frozen snapshot — nothing was deleted.`,
  );

  localIndex.close();
  s3Index.close();
}

function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(`[journal] cannot migrate: ${error.message}`);
  } else {
    console.error('[journal] migration failed', error);
  }
  process.exitCode = 1;
});
