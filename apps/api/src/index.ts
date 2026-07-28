import { serve } from '@hono/node-server';
import { ConfigError, loadConfig } from './config.js';
import { createApp } from './http/app.js';
import { FsEntryStore } from './store/fs-entry-store.js';
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
 */
async function main(): Promise<void> {
  const config = await loadConfig();
  const store = new FsEntryStore(config.journalDir);
  const transcriber = new LocalTranscriber(config.whisperModel, config.whisperCacheDir);
  const app = createApp(store, config, transcriber);

  serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
    console.log(`[journal] api listening on http://${config.host}:${info.port}`);
    console.log(`[journal] journal directory: ${config.journalDir}`);
    console.log(`[journal] accepting browser origins: ${config.allowedOrigins.join(', ')}`);
    console.log(`[journal] speech-to-text model: ${config.whisperModel} (cached at ${config.whisperCacheDir})`);
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
