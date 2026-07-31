import { ConfigError, loadConfig } from './config.js';
import { CategoriesIndex } from './index/categories-index.js';
import { ListsIndex } from './index/lists-index.js';
import { MetricFieldsIndex } from './index/metric-fields-index.js';
import { MetricsIndex } from './index/metrics-index.js';
import { OpinionStatementsIndex } from './index/opinion-statements-index.js';
import { OpinionSummariesIndex } from './index/opinion-summaries-index.js';
import { QuestionsIndex } from './index/questions-index.js';
import { ReviewsIndex } from './index/reviews-index.js';
import { SqliteIndex } from './index/sqlite-index.js';
import { GatewayModelClient } from './model/gateway-model-client.js';
import { Extractor } from './model/extractor.js';
import { ListsExtractor } from './model/lists-extractor.js';
import { LIST_TYPE_SEED_NAMES } from './model/lists.js';
import { OpinionSummarizer } from './model/opinion-summarizer.js';
import { OpinionsExtractor } from './model/opinions-extractor.js';
import { OPINION_SUBJECT_SEED_NAMES } from './model/opinions.js';
import { QuestionsExtractor } from './model/questions-extractor.js';
import { ReviewsExtractor } from './model/reviews-extractor.js';
import { REVIEW_MEDIUM_SEED_NAMES } from './model/reviews.js';
import { METRIC_SEED_NAMES } from './model/temporal-metrics.js';
import { FsEntryStore } from './store/fs-entry-store.js';
import { nowTimestamp } from './record/time.js';

/**
 * `reprocess --from-scratch` (`plan.md` M7/M8, `requirements.md` §6.4) —
 * every entry, re-sent to the model for every structure type, nothing
 * carried over from before. Run it yourself: `npm run reprocess -w
 * @journal/api`.
 *
 * Deliberately separate from `rebuild-index` (`src/rebuild.ts`): that
 * command is fast, local, and free, and stays that way whether or not
 * extraction is configured. This one costs a real API call per entry per
 * structure type, so it is never something another command runs on your
 * behalf, and it refuses outright rather than silently doing nothing if
 * `AI_GATEWAY_API_KEY` is not set.
 *
 * Also the model-migration procedure (`requirements.md` §7.6): run this
 * once against one `EXTRACTION_MODEL`, dump `GET /metrics` (and
 * `/reviews`, `/lists`), change the model, run it again, dump again, and
 * diff.
 *
 * Approved categories (`plan.md` M8, `requirements.md` §5.3) are seeded
 * here, idempotently, every run — never cleared. An approval is a decision
 * a human made, not something a reprocess-from-scratch regenerates; only
 * the extracted records themselves are a disposable cache.
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

  console.log(`[journal] reprocessing at ${config.indexDbPath}`);
  console.log(`[journal] from ${config.journalDir}`);
  console.log(`[journal] model: ${config.extractionModel}`);

  const index = new SqliteIndex(config.indexDbPath);
  const store = new FsEntryStore(config.journalDir, index);
  const modelClient = new GatewayModelClient(config.aiGatewayApiKey, config.extractionModel);

  const categoriesIndex = new CategoriesIndex(config.indexDbPath);
  const now = nowTimestamp().canonical;
  categoriesIndex.seed('metric', METRIC_SEED_NAMES, now);
  categoriesIndex.seed('review_medium', REVIEW_MEDIUM_SEED_NAMES, now);
  categoriesIndex.seed('list_type', LIST_TYPE_SEED_NAMES, now);
  categoriesIndex.seed('opinion_subject', OPINION_SUBJECT_SEED_NAMES, now);

  const metricsIndex = new MetricsIndex(config.indexDbPath);
  const metricFieldsIndex = new MetricFieldsIndex(config.indexDbPath);
  const extractor = new Extractor(metricsIndex, metricFieldsIndex, categoriesIndex, modelClient);

  const reviewsIndex = new ReviewsIndex(config.indexDbPath);
  const reviewsExtractor = new ReviewsExtractor(reviewsIndex, categoriesIndex, modelClient);

  const listsIndex = new ListsIndex(config.indexDbPath);
  const listsExtractor = new ListsExtractor(listsIndex, categoriesIndex, modelClient);

  const opinionStatementsIndex = new OpinionStatementsIndex(config.indexDbPath);
  const opinionsExtractor = new OpinionsExtractor(opinionStatementsIndex, categoriesIndex, modelClient);
  const opinionSummariesIndex = new OpinionSummariesIndex(config.indexDbPath);
  const opinionSummarizer = new OpinionSummarizer(opinionSummariesIndex, opinionStatementsIndex, modelClient);

  const questionsIndex = new QuestionsIndex(config.indexDbPath);
  const questionsExtractor = new QuestionsExtractor(questionsIndex, modelClient);

  const before = Date.now();
  const { entryCount, metricCount } = await extractor.reprocessAll(store);
  const { reviewCount } = await reviewsExtractor.reprocessAll(store);
  const { itemCount } = await listsExtractor.reprocessAll(store);
  const { statementCount } = await opinionsExtractor.reprocessAll(store);
  // Summaries are regenerated only after every entry has produced its
  // statements — this pass is per-subject, not per-entry, and reads the
  // statements the pass above just wrote.
  const { subjectCount, partCount } = await opinionSummarizer.summarizeAll();
  // Questions are their own pass, not folded into the loop above: unlike
  // every other extractor, this one needs entries in chronological order
  // (see `QuestionsExtractor.reprocessAll`), so it walks the corpus on its
  // own terms rather than sharing an entry loop with siblings that don't
  // care about order.
  const { questionCount, openCount, resolvedCount } = await questionsExtractor.reprocessAll(store);
  const elapsedMs = Date.now() - before;

  console.log(
    `[journal] reprocessed in ${elapsedMs}ms: ${entryCount} entries — ` +
      `${metricCount} metrics, ${reviewCount} reviews, ${itemCount} list items, ` +
      `${statementCount} opinion statements (${subjectCount} subjects, ${partCount} summary parts), ` +
      `${questionCount} questions (${openCount} open, ${resolvedCount} resolved)`,
  );

  questionsIndex.close();
  opinionSummariesIndex.close();
  opinionStatementsIndex.close();
  listsIndex.close();
  reviewsIndex.close();
  metricFieldsIndex.close();
  metricsIndex.close();
  categoriesIndex.close();
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
