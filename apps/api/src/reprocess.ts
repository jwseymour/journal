import { ConfigError, loadConfig } from './config.js';
import { MetricsIndex } from './index/metrics-index.js';
import { SqliteIndex } from './index/sqlite-index.js';
import { GatewayModelClient } from './model/gateway-model-client.js';
import { Extractor } from './model/extractor.js';
import { FsEntryStore } from './store/fs-entry-store.js';

/**
 * `reprocess --from-scratch` (`plan.md` M7, `requirements.md` §6.4) — every
 * entry, re-sent to the model, nothing carried over from before. Run it
 * yourself: `npm run reprocess -w @journal/api`.
 *
 * Deliberately separate from `rebuild-index` (`src/rebuild.ts`): that
 * command is fast, local, and free, and stays that way whether or not
 * extraction is configured. This one costs a real API call per entry, so it
 * is never something another command runs on your behalf, and it refuses
 * outright rather than silently doing nothing if `AI_GATEWAY_API_KEY` is
 * not set.
 *
 * Also the model-migration procedure (`requirements.md` §7.6): run this
 * once against one `EXTRACTION_MODEL`, dump `GET /metrics`, change the
 * model, run it again, dump again, and diff the two.
 */
async function main(): Promise<void> {
  const config = await loadConfig();
  if (!config.aiGatewayApiKey) {
    console.error(
      '[journal] cannot reprocess: AI_GATEWAY_API_KEY is not set. Add it to .env at the repository root.',
    );
    process.exitCode = 1;
    return;
  }

  console.log(`[journal] reprocessing metrics at ${config.indexDbPath}`);
  console.log(`[journal] from ${config.journalDir}`);
  console.log(`[journal] model: ${config.extractionModel}`);

  const index = new SqliteIndex(config.indexDbPath);
  const store = new FsEntryStore(config.journalDir, index);
  const metricsIndex = new MetricsIndex(config.indexDbPath);
  const modelClient = new GatewayModelClient(config.aiGatewayApiKey, config.extractionModel);
  const extractor = new Extractor(metricsIndex, modelClient);

  const before = Date.now();
  const { entryCount, metricCount } = await extractor.reprocessAll(store);
  const elapsedMs = Date.now() - before;

  console.log(`[journal] reprocessed in ${elapsedMs}ms: ${entryCount} entries, ${metricCount} metrics`);

  metricsIndex.close();
  index.close();
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(`[journal] cannot reprocess: ${error.message}`);
  } else {
    console.error('[journal] reprocess failed', error);
  }
  process.exitCode = 1;
});
