import { serve } from '@hono/node-server';
import { ConfigError, loadConfig } from './config.js';
import { createApp } from './http/app.js';
import { CategoriesIndex } from './index/categories-index.js';
import { DocumentsIndex } from './index/documents-index.js';
import { EntryProcessingStatusIndex } from './index/entry-processing-status-index.js';
import { ListsIndex } from './index/lists-index.js';
import { MetricFieldsIndex } from './index/metric-fields-index.js';
import { MetricsIndex } from './index/metrics-index.js';
import { OpinionStatementsIndex } from './index/opinion-statements-index.js';
import { OpinionSummariesIndex } from './index/opinion-summaries-index.js';
import { PendingItemsIndex } from './index/pending-items-index.js';
import { PublicSearchIndex } from './index/public-search-index.js';
import { PublishedIndex } from './index/published-index.js';
import { QuestionsIndex } from './index/questions-index.js';
import { ReviewsIndex } from './index/reviews-index.js';
import { SearchIndex } from './index/search-index.js';
import { SqliteIndex } from './index/sqlite-index.js';
import { TodosIndex } from './index/todos-index.js';
import { VisibilityDefaultsIndex } from './index/visibility-defaults-index.js';
import { ChatOrchestrator } from './model/chat-orchestrator.js';
import { Extractor } from './model/extractor.js';
import { GatewayChatClient, UnconfiguredChatClient } from './model/gateway-chat-client.js';
import { GatewayModelClient, UnconfiguredModelClient } from './model/gateway-model-client.js';
import { ListsExtractor } from './model/lists-extractor.js';
import { LIST_TYPE_SEED_NAMES } from './model/lists.js';
import { OpinionSummarizer } from './model/opinion-summarizer.js';
import { OpinionsExtractor } from './model/opinions-extractor.js';
import { OPINION_SUBJECT_SEED_NAMES } from './model/opinions.js';
import { PendingItemApplier } from './model/pending-item-applier.js';
import { LivePendingProcessor } from './model/pending-processor.js';
import { QuestionsExtractor } from './model/questions-extractor.js';
import { ReviewsExtractor } from './model/reviews-extractor.js';
import { REVIEW_MEDIUM_SEED_NAMES } from './model/reviews.js';
import { METRIC_FIELD_SEEDS, METRIC_SEED_NAMES } from './model/temporal-metrics.js';
import { TodosExtractor } from './model/todos-extractor.js';
import { ulid } from './record/id.js';
import { nowTimestamp } from './record/time.js';
import { createTouchedMirror } from './durable/create-touched-mirror.js';
import { createPublisher } from './publish/create-publisher.js';
import { LocalEmbedder } from './search/local-embedder.js';
import { SearchIndexer } from './search/indexer.js';
import { HybridSearcher } from './search/searcher.js';
import { createDocumentStore } from './store/create-document-store.js';
import { createEntryStore } from './store/create-entry-store.js';
import { SearchingDocumentStore } from './store/searching-document-store.js';
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
  const store = new SearchingEntryStore(createEntryStore(config, index), indexer);
  const documentsIndex = new DocumentsIndex(config.indexDbPath);
  const searcher = new HybridSearcher(searchIndex, embedder, index, documentsIndex);
  // Wrapped in `SearchingDocumentStore` the same way entries are
  // (`plan.md` M17) — documents are now indexed for search alongside
  // entries, distinguished by `source_type` in the same `chunks` table.
  const documentStore = new SearchingDocumentStore(createDocumentStore(config, documentsIndex), indexer);
  const transcriber = new LocalTranscriber(config.whisperModel, config.whisperCacheDir);
  const metricsIndex = new MetricsIndex(config.indexDbPath);
  const metricFieldsIndex = new MetricFieldsIndex(config.indexDbPath);
  const reviewsIndex = new ReviewsIndex(config.indexDbPath);
  const listsIndex = new ListsIndex(config.indexDbPath);
  const opinionStatementsIndex = new OpinionStatementsIndex(config.indexDbPath);
  const opinionSummariesIndex = new OpinionSummariesIndex(config.indexDbPath);
  const questionsIndex = new QuestionsIndex(config.indexDbPath);
  const todosIndex = new TodosIndex(config.indexDbPath);
  // The one durable record of what's public (`requirements.md` §9.3, §11,
  // `plan.md` M15) — see `PublishedIndex`'s own doc comment for why this,
  // unlike every other index here, is not a disposable cache.
  const publishedIndex = new PublishedIndex(config.indexDbPath);
  // "These are public by default" per category (`plan.md` M16) — a
  // disposable settings cache, unlike `publishedIndex` itself: losing it
  // only means re-ticking a default, never losing a publish decision.
  const visibilityDefaultsIndex = new VisibilityDefaultsIndex(config.indexDbPath);
  // The public search index (`plan.md` M17) — a disposable cache exactly
  // like `searchIndex`, just scoped to whatever `Publisher` has mirrored to
  // `public/`. Lives in the same `index.db` file as everything else so the
  // whole derived layer stays one deletable artefact.
  const publicSearchIndex = new PublicSearchIndex(config.indexDbPath);
  const publisher = createPublisher(
    config,
    publishedIndex,
    store,
    documentStore,
    metricsIndex,
    reviewsIndex,
    listsIndex,
    opinionStatementsIndex,
    questionsIndex,
    publicSearchIndex,
  );
  // Durable backing for touched derived records (`durable/touched-mirror.ts`)
  // — closes the gap where `touched` content lived only inside the
  // disposable `index.db`. Boot never restores from it itself, the same
  // "never rebuild silently" posture the index's own boot comment already
  // takes above; restoring is `npm run rebuild -w @journal/api`'s job
  // (`src/rebuild.ts`).
  const touchedMirror = createTouchedMirror(
    config,
    metricsIndex,
    reviewsIndex,
    listsIndex,
    opinionStatementsIndex,
    questionsIndex,
    todosIndex,
  );
  // Seeded on every boot too, not only in `reprocess.ts` — the approved-name
  // list has to exist before `GET /categories` can answer anything, and
  // boot is the one place guaranteed to run before that request can arrive.
  // `seed` is idempotent, so running it in both places is exactly as safe as
  // running it in one.
  const categoriesIndex = new CategoriesIndex(config.indexDbPath);
  const seededAt = nowTimestamp().canonical;
  categoriesIndex.seed('metric', METRIC_SEED_NAMES, seededAt);
  categoriesIndex.seed('review_medium', REVIEW_MEDIUM_SEED_NAMES, seededAt);
  categoriesIndex.seed('list_type', LIST_TYPE_SEED_NAMES, seededAt);
  categoriesIndex.seed('opinion_subject', OPINION_SUBJECT_SEED_NAMES, seededAt);
  // Same idempotence as the category seeding just above — a `(metric,
  // field_key)` pair that already exists, whether from a previous boot or
  // from the user editing it since, is left untouched (`temporal-metrics.ts`
  // `METRIC_FIELD_SEEDS`'s own comment).
  for (const seed of METRIC_FIELD_SEEDS) {
    metricFieldsIndex.define({ ...seed, id: ulid(Date.now()), now: seededAt });
  }
  // Chat and single-entry extraction are the two subsystems that call a
  // model live from the running server — both fail clearly at the point of
  // use, via their own `Unconfigured*` client, rather than refusing to boot
  // over an optional subsystem (`plan.md` M1's `JOURNAL_DIR` reasoning,
  // applied here). `npm run reprocess` (`src/reprocess.ts`) still refuses
  // outright instead, since a corpus-wide, real-money run with no key
  // configured is never something to silently no-op through.
  const chatClient = config.aiGatewayApiKey
    ? new GatewayChatClient(config.aiGatewayApiKey, config.chatModel)
    : new UnconfiguredChatClient();
  const chatOrchestrator = new ChatOrchestrator(
    chatClient,
    metricsIndex,
    metricFieldsIndex,
    reviewsIndex,
    listsIndex,
    categoriesIndex,
  );
  const modelClient = config.aiGatewayApiKey
    ? new GatewayModelClient(config.aiGatewayApiKey, config.extractionModel)
    : new UnconfiguredModelClient();
  // The live, one-entry pending-item pipeline (`plan.md` M18) — replaces
  // the pre-M18 `EntryProcessor`, which committed directly. Nothing here
  // commits on its own; see `LivePendingProcessor`'s own doc comment.
  const pendingItemsIndex = new PendingItemsIndex(config.indexDbPath);
  const entryProcessingStatusIndex = new EntryProcessingStatusIndex(config.indexDbPath);
  const pendingProcessor = new LivePendingProcessor(
    pendingItemsIndex,
    metricsIndex,
    new Extractor(metricsIndex, metricFieldsIndex, categoriesIndex, modelClient),
    reviewsIndex,
    new ReviewsExtractor(reviewsIndex, categoriesIndex, modelClient),
    listsIndex,
    new ListsExtractor(listsIndex, categoriesIndex, modelClient),
    opinionStatementsIndex,
    new OpinionsExtractor(opinionStatementsIndex, categoriesIndex, modelClient),
    questionsIndex,
    new QuestionsExtractor(questionsIndex, modelClient),
    todosIndex,
    new TodosExtractor(todosIndex, modelClient),
  );
  const pendingItemApplier = new PendingItemApplier(
    metricsIndex,
    reviewsIndex,
    listsIndex,
    opinionStatementsIndex,
    new OpinionSummarizer(opinionSummariesIndex, opinionStatementsIndex, modelClient),
    questionsIndex,
    todosIndex,
    touchedMirror,
  );
  const app = createApp(
    store,
    documentStore,
    config,
    transcriber,
    searcher,
    metricsIndex,
    metricFieldsIndex,
    reviewsIndex,
    listsIndex,
    categoriesIndex,
    opinionStatementsIndex,
    opinionSummariesIndex,
    questionsIndex,
    todosIndex,
    pendingProcessor,
    pendingItemsIndex,
    pendingItemApplier,
    entryProcessingStatusIndex,
    chatOrchestrator,
    publisher,
    visibilityDefaultsIndex,
    touchedMirror,
  );

  serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
    console.log(`[journal] api listening on http://${config.host}:${info.port}`);
    console.log(`[journal] journal directory: ${config.journalDir}`);
    console.log(`[journal] accepting browser origins: ${config.allowedOrigins.join(', ')}`);
    console.log(`[journal] speech-to-text model: ${config.whisperModel} (cached at ${config.whisperCacheDir})`);
    console.log(`[journal] index: ${config.indexDbPath}`);
    console.log(`[journal] embedding model: ${config.embeddingModel} (${config.embeddingDimensions} dimensions)`);
    console.log(
      config.aiGatewayApiKey
        ? `[journal] extraction model: ${config.extractionModel}`
        : '[journal] extraction: AI_GATEWAY_API_KEY not set — GET /metrics (and friends) will stay empty, and POST /entries/:id/process will return extraction_failed, until it is configured',
    );
    console.log(
      config.aiGatewayApiKey
        ? `[journal] chat model: ${config.chatModel}`
        : '[journal] chat: AI_GATEWAY_API_KEY not set — POST /chat will return chat_failed until configured',
    );
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
