import type { ProcessEntryResponse } from '@journal/contract';
import type { Extractor } from './extractor.js';
import type { ListsExtractor } from './lists-extractor.js';
import type { OpinionsExtractor } from './opinions-extractor.js';
import type { OpinionSummarizer } from './opinion-summarizer.js';
import type { QuestionsExtractor } from './questions-extractor.js';
import type { ReviewsExtractor } from './reviews-extractor.js';
import type { TodosExtractor } from './todos-extractor.js';

export interface EntryProcessing {
  processEntry(entry: { id: string; created: string; body: string }): Promise<ProcessEntryResponse>;
}

/**
 * The live, one-entry counterpart to `npm run reprocess` (`plan.md` M15):
 * every structure type, one call each, for one entry — triggered by an
 * explicit user action (finishing a new entry, or finishing an edit to an
 * existing one), never by autosave. Each extractor's own `extractEntry`
 * already does the expensive part correctly on its own — touched-record
 * protection, propose-instead-of-overwrite (`requirements.md` §6.4) — so
 * this class is pure orchestration: run all six, then resummarize only the
 * opinion subjects this entry actually touched, instead of `summarizeAll`'s
 * whole-corpus pass (`OpinionSummarizer.summarizeSubject`).
 *
 * Deliberately **not** what `reprocessAll` is: this never claims to be a
 * from-scratch pass, and for `QuestionsExtractor`/`TodosExtractor` it is
 * only reliably correct for the entry that is currently the newest one —
 * see their own comments on `extractEntry`.
 *
 * Sequential, not parallel — the same "predictable cost, no burst" posture
 * `Extractor.reprocessAll` takes, applied to six calls instead of one.
 */
export class EntryProcessor implements EntryProcessing {
  readonly #extractor: Extractor;
  readonly #reviewsExtractor: ReviewsExtractor;
  readonly #listsExtractor: ListsExtractor;
  readonly #opinionsExtractor: OpinionsExtractor;
  readonly #opinionSummarizer: OpinionSummarizer;
  readonly #questionsExtractor: QuestionsExtractor;
  readonly #todosExtractor: TodosExtractor;

  constructor(
    extractor: Extractor,
    reviewsExtractor: ReviewsExtractor,
    listsExtractor: ListsExtractor,
    opinionsExtractor: OpinionsExtractor,
    opinionSummarizer: OpinionSummarizer,
    questionsExtractor: QuestionsExtractor,
    todosExtractor: TodosExtractor,
  ) {
    this.#extractor = extractor;
    this.#reviewsExtractor = reviewsExtractor;
    this.#listsExtractor = listsExtractor;
    this.#opinionsExtractor = opinionsExtractor;
    this.#opinionSummarizer = opinionSummarizer;
    this.#questionsExtractor = questionsExtractor;
    this.#todosExtractor = todosExtractor;
  }

  async processEntry(entry: { id: string; created: string; body: string }): Promise<ProcessEntryResponse> {
    const { metricCount } = await this.#extractor.extractEntry(entry);
    const { reviewCount } = await this.#reviewsExtractor.extractEntry(entry);
    const { itemCount } = await this.#listsExtractor.extractEntry(entry);
    const { statementCount, subjects } = await this.#opinionsExtractor.extractEntry(entry);
    for (const subject of subjects) {
      await this.#opinionSummarizer.summarizeSubject(subject);
    }
    const { questionCount } = await this.#questionsExtractor.extractEntry(entry);
    const { todoCount } = await this.#todosExtractor.extractEntry(entry);

    return { metricCount, reviewCount, itemCount, statementCount, questionCount, todoCount };
  }
}
