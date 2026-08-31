import { ConfigError, loadConfig } from './config.js';
import { createTouchedMirror } from './durable/create-touched-mirror.js';
import { DocumentsIndex } from './index/documents-index.js';
import { ListsIndex } from './index/lists-index.js';
import { MediaIndex } from './index/media-index.js';
import { MetricsIndex } from './index/metrics-index.js';
import { OpinionStatementsIndex } from './index/opinion-statements-index.js';
import { QuestionsIndex } from './index/questions-index.js';
import { ReviewsIndex } from './index/reviews-index.js';
import { SearchIndex } from './index/search-index.js';
import { SqliteIndex } from './index/sqlite-index.js';
import { TodosIndex } from './index/todos-index.js';
import { SearchIndexer } from './search/indexer.js';
import { LocalEmbedder } from './search/local-embedder.js';
import { createDocumentStore } from './store/create-document-store.js';
import { createEntryStore } from './store/create-entry-store.js';
import { createMediaStore } from './store/create-media-store.js';

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
 *
 * One exception, and a deliberate one: touched derived records (metrics,
 * reviews, list items, opinion statements, questions, to-dos) are restored
 * from the durable off-index mirror (`durable/touched-mirror.ts`) after the
 * rebuild above completes. Everything else this command rebuilds is a pure,
 * disposable function of the journal files; a touched record is not — it is
 * the user's own correction, which nothing can regenerate from the entry
 * text alone (`requirements.md` §6.4) — so it needs its own durable source
 * to rebuild *from*, separate from `index.db` itself. This is what makes
 * `rm index.db && npm run rebuild` actually safe for touched data, not only
 * for entries and documents.
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

  // The media-store rebuild — same free, local rebuild `documentStore`
  // above gets, just re-deriving each item's metadata from its own bytes
  // (`extractMediaMetadata`) instead of re-parsing markdown frontmatter.
  const mediaIndex = new MediaIndex(config.indexDbPath);
  const mediaStore = createMediaStore(config, mediaIndex);
  const mediaBefore = Date.now();
  const { mediaCount } = await mediaStore.rebuild();
  const mediaElapsedMs = Date.now() - mediaBefore;
  console.log(`[journal] media rebuilt in ${mediaElapsedMs}ms: ${mediaCount} items`);

  // The touched-record recovery path (`durable/touched-mirror.ts`) — reads
  // every durably-mirrored touched record back and reinserts it, so a
  // deleted-and-rebuilt `index.db` never silently loses a correction the
  // user made (`requirements.md` §6.4). Constructed against the same
  // `config.indexDbPath` the tables above were just rebuilt into, and safe
  // to run every time: `restoreTouched` is `INSERT OR REPLACE`, so restoring
  // a record that's already there (e.g. a `rebuild` that did not actually
  // lose `index.db`) is a harmless no-op, not a duplicate.
  const metricsIndex = new MetricsIndex(config.indexDbPath);
  const reviewsIndex = new ReviewsIndex(config.indexDbPath);
  const listsIndex = new ListsIndex(config.indexDbPath);
  const opinionStatementsIndex = new OpinionStatementsIndex(config.indexDbPath);
  const questionsIndex = new QuestionsIndex(config.indexDbPath);
  const todosIndex = new TodosIndex(config.indexDbPath);
  const touchedMirror = createTouchedMirror(
    config,
    metricsIndex,
    reviewsIndex,
    listsIndex,
    opinionStatementsIndex,
    questionsIndex,
    todosIndex,
  );
  const restoredBefore = Date.now();
  const restored = await touchedMirror.restoreAll();
  const restoredElapsedMs = Date.now() - restoredBefore;
  console.log(
    `[journal] touched records restored in ${restoredElapsedMs}ms: ` +
      `${restored.metric} metrics, ${restored.review} reviews, ${restored.list_item} list items, ` +
      `${restored.opinion_statement} opinion statements, ${restored.question} questions, ${restored.todo} todos`,
  );

  searchIndex.close();
  index.close();
  documentsIndex.close();
  mediaIndex.close();
  metricsIndex.close();
  reviewsIndex.close();
  listsIndex.close();
  opinionStatementsIndex.close();
  questionsIndex.close();
  todosIndex.close();
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(`[journal] cannot rebuild: ${error.message}`);
  } else {
    console.error('[journal] rebuild failed', error);
  }
  process.exitCode = 1;
});
