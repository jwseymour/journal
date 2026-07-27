import { serve } from '@hono/node-server';
import { ConfigError, loadConfig } from './config.js';
import { createApp } from './http/app.js';
import { FsEntryStore } from './store/fs-entry-store.js';

/**
 * Boot.
 *
 * Configuration is validated before anything listens, and a bad configuration
 * is fatal rather than deferred to the first request. The journal directory is
 * the one thing this application cannot guess at.
 */
async function main(): Promise<void> {
  const config = await loadConfig();
  const store = new FsEntryStore(config.journalDir);
  const app = createApp(store, config);

  serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
    console.log(`[journal] api listening on http://${config.host}:${info.port}`);
    console.log(`[journal] journal directory: ${config.journalDir}`);
    console.log(`[journal] accepting browser origins: ${config.allowedOrigins.join(', ')}`);
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
