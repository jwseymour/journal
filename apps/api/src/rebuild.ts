import { ConfigError, loadConfig } from './config.js';
import { DocumentsIndex } from './index/documents-index.js';
import { SearchIndex } from './index/search-index.js';
import { SqliteIndex } from './index/sqlite-index.js';
import { SearchIndexer } from './search/indexer.js';
import { LocalEmbedder } from './search/local-embedder.js';
import { createDocumentStore } from './store/create-document-store.js';
import { createEntryStore } from './store/create-entry-store.js';

/**
 * `rebuild --from-scratch` (`plan.md` M5/M6, `requirements.md` §6.4) — a
 * first-class operation, not a maintenance utility, and not something boot
 * does silently. Run it yourself: `npm run rebuild -w @journal/api`.
 *
 * Deletes nothing but derived data. The journal itself is never touched —
 * this reads the same files every other entry point reads and writes none of
 * them. Rebuilds both derived layers: the listing/lookup index (M5) and, now
 * that it exists, the search index (M6) — every chunk re-embedded from the
 * files, nothing carried over from before.
 */
async function main(): Promise<void> {
  const config = await loadConfig();
  console.log(`[journal] rebuilding the index at ${config.indexDbPath}`);
  console.log(`[journal] from ${config.journalDir}`);

  const index = new SqliteIndex(config.indexDbPath);
  const store = createEntryStore(config, index);

  const before = Date.now();
  const { entryCount, unreadableCount } = await store.rebuild();
  const elapsedMs = Date.now() - before;
  console.log(`[journal] rebuilt in ${elapsedMs}ms: ${entryCount} entries, ${unreadableCount} unreadable`);

  const searchIndex = new SearchIndex(config.indexDbPath, config.embeddingDimensions);
  const embedder = new LocalEmbedder(config.embeddingModel, config.embeddingCacheDir, config.embeddingDimensions);
  const indexer = new SearchIndexer(searchIndex, embedder);

  // Clears the whole search index (entries and documents alike) and
  // rebuilds the entry half — must run before the document half below,
  // which deliberately does not clear again (`plan.md` M17).
  const searchBefore = Date.now();
  const { chunkCount: entryChunkCount } = await indexer.rebuildAll(store);
  const searchElapsedMs = Date.now() - searchBefore;
  console.log(`[journal] search index rebuilt in ${searchElapsedMs}ms: ${entryChunkCount} entry chunks`);

  // The listing/lookup rebuild — the document-store twin of the entry
  // rebuild above, free and local exactly the same way.
  const documentsIndex = new DocumentsIndex(config.indexDbPath);
  const documentStore = createDocumentStore(config, documentsIndex);
  const documentsBefore = Date.now();
  const { documentCount, unreadableCount: unreadableDocumentCount } = await documentStore.rebuild();
  const documentsElapsedMs = Date.now() - documentsBefore;
  console.log(
    `[journal] documents rebuilt in ${documentsElapsedMs}ms: ${documentCount} documents, ${unreadableDocumentCount} unreadable`,
  );

  // Documents are now indexed for search too (`plan.md` M17) — run after
  // the entry search rebuild above, never before, since this does not
  // clear the index itself.
  const docSearchBefore = Date.now();
  const { chunkCount: totalChunkCount } = await indexer.rebuildAllDocuments(documentStore);
  const docSearchElapsedMs = Date.now() - docSearchBefore;
  console.log(
    `[journal] document search chunks rebuilt in ${docSearchElapsedMs}ms: ${totalChunkCount} chunks total`,
  );

  searchIndex.close();
  index.close();
  documentsIndex.close();
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(`[journal] cannot rebuild: ${error.message}`);
  } else {
    console.error('[journal] rebuild failed', error);
  }
  process.exitCode = 1;
});
