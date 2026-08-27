import { serve } from '@hono/node-server';
import { ConfigError, loadConfig } from './config.js';
import { createApp } from './http/app.js';
import { PublishedIndexReader } from './index-reader.js';
import { PublicSearchReader } from './public-search-reader.js';
import { createStorageReader } from './storage-reader.js';

/**
 * Boot (`plan.md` M14).
 *
 * Unlike `apps/api`'s boot, there is nothing to build or migrate here: the
 * index and the document files are both owned entirely by the private API.
 * This process only ever opens what already exists, read-only, and fails
 * loudly at boot if either is missing rather than guessing or creating
 * anything (`requirements.md` §10 — this stays a strictly read-only
 * surface, in code as much as in intent).
 */
async function main(): Promise<void> {
  const config = await loadConfig();
  const reader = new PublishedIndexReader(config.indexDbPath);
  const searchReader = new PublicSearchReader(config.indexDbPath);
  const storage = createStorageReader(config);
  const app = createApp(reader, searchReader, storage, config);

  serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
    console.log(`[journal-public] listening on http://${config.host}:${info.port}`);
    console.log(`[journal-public] storage backend: ${config.storageBackend} (read-only)`);
    console.log(`[journal-public] index (read-only): ${config.indexDbPath}`);
    console.log(`[journal-public] accepting browser origins: ${config.allowedOrigins.join(', ')}`);
  });
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(`[journal-public] cannot start: ${error.message}`);
  } else {
    console.error('[journal-public] cannot start', error);
  }
  process.exitCode = 1;
});
