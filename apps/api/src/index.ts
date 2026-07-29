import { serve } from '@hono/node-server';
import { ConfigError, loadConfig } from './config.js';
import { createApp } from './http/app.js';
import { SearchIndex } from './index/search-index.js';
import { SqliteIndex } from './index/sqlite-index.js';
import { LocalEmbedder } from './search/local-embedder.js';
import { SearchIndexer } from './search/indexer.js';
import { HybridSearcher } from './search/searcher.js';
import { FsEntryStore } from './store/fs-entry-store.js';
import { SearchingEntryStore } from './store/searching-entry-store.js';
import { LocalTranscriber } from './transcribe/local-transcriber.js';

/**
 * Boot.
 *
 * Configuration is validated before anything listens, and a bad configuration
 * is fatal rather than deferred to the first request. The journal directory is
 * the one thing this application cannot guess at.
 *
 * The transcriber is constructed here but loads nothing yet — the model
 * downloads and initialises lazily, on the first recording, so starting the
 * server never waits on it (`plan.md` M4).
 *
 * The index is opened, not rebuilt, on every boot — a missing or empty
 * database file just means the first request populates it one file at a
 * time, the same incremental path a running server already uses. A full,
 * deliberate `rebuild()` is `npm run rebuild -w @journal/api`
 * (`src/rebuild.ts`), never something boot does silently on your behalf.
 */
async function main(): Promise<void> {
  const config = await loadConfig();
  const index = new SqliteIndex(config.indexDbPath);
  const searchIndex = new SearchIndex(config.indexDbPath, config.embeddingDimensions);
  const embedder = new LocalEmbedder(config.embeddingModel, config.embeddingCacheDir, config.embeddingDimensions);
  const indexer = new SearchIndexer(searchIndex, embedder);
  const store = new SearchingEntryStore(new FsEntryStore(config.journalDir, index), indexer);
  const searcher = new HybridSearcher(searchIndex, embedder, index);
  const transcriber = new LocalTranscriber(config.whisperModel, config.whisperCacheDir);
  const app = createApp(store, config, transcriber, searcher);

  serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
    console.log(`[journal] api listening on http://${config.host}:${info.port}`);
    console.log(`[journal] journal directory: ${config.journalDir}`);
    console.log(`[journal] accepting browser origins: ${config.allowedOrigins.join(', ')}`);
    console.log(`[journal] speech-to-text model: ${config.whisperModel} (cached at ${config.whisperCacheDir})`);
    console.log(`[journal] index: ${config.indexDbPath}`);
    console.log(`[journal] embedding model: ${config.embeddingModel} (${config.embeddingDimensions} dimensions)`);
  });
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(`[journal] cannot start: ${error.message}`);
  } else {
    console.error('[journal] cannot start', error);
  }
  process.exitCode = 1;
});
