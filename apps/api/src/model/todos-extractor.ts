import type { TodoRecord, TodosIndex } from '../index/todos-index.js';
import { ulid } from '../record/id.js';
import { nowTimestamp } from '../record/time.js';
import type { EntryStore, StoredEntry } from '../store/entry-store.js';
import { resolveEventTime } from './event-time.js';
import type { ModelClient } from './model-client.js';
import { buildTodoExtractionPrompt, TODO_SYSTEM_PROMPT, TodoExtractionSchema } from './todos.js';

const PAGE_SIZE = 100;

/**
 * Turns one entry into to-do records via `ModelClient` — the same
 * two-in-one-call shape as `QuestionsExtractor`: raise whatever this entry
 * newly states, and check the entry against every to-do still open from
 * earlier entries (including ones created directly in the UI).
 *
 * Completion-matching can only ever look backward in time, so
 * `reprocessAll` below sorts entries chronologically before extracting,
 * same reasoning as `QuestionsExtractor.reprocessAll`. See that class's
 * comment on `extractEntry` for why the live, one-entry path
 * (`EntryProcessor`) is exactly correct for a just-written entry but only a
 * best-effort re-check for an edited older one.
 */
export class TodosExtractor {
  readonly #todosIndex: TodosIndex;
  readonly #modelClient: ModelClient;

  constructor(todosIndex: TodosIndex, modelClient: ModelClient) {
    this.#todosIndex = todosIndex;
    this.#modelClient = modelClient;
  }

  async extractEntry(entry: { id: string; created: string; body: string }): Promise<{ todoCount: number }> {
    const openTodos = this.#todosIndex.listOpen();
    const prompt = buildTodoExtractionPrompt(
      entry,
      openTodos.map((t) => ({ id: t.id, text: t.text })),
    );
    const result = await this.#modelClient.extract({
      schema: TodoExtractionSchema,
      system: TODO_SYSTEM_PROMPT,
      prompt,
    });

    const extractedAt = nowTimestamp().canonical;
    const raised: Omit<TodoRecord, 'entryId' | 'origin'>[] = result.newTodos.map((t) => {
      const resolved = resolveEventTime(t.eventTime, t.eventTimeExplicit, entry.created);
      return {
        id: ulid(Date.now()),
        text: t.text,
        ...resolved,
        extractedAt,
        status: 'open',
        doneEntryId: null,
        resolution: null,
        doneAt: null,
        touched: false,
      };
    });
    // See `QuestionsExtractor.extractEntry` for the full reasoning
    // (`plan.md` M10). Only the still-open to-dos this entry raised are in
    // scope for comparison — a done one is never revisited by
    // `replaceRaised` either, touched or not.
    const touched = this.#todosIndex.touchedOpenRaisedBy(entry.id);
    let untouchedRaised = raised;
    if (touched.length > 0 && touched.length === raised.length) {
      for (let i = 0; i < touched.length; i += 1) {
        const before = touched[i];
        const after = raised[i];
        if (!before || !after) continue;
        if (before.text !== after.text || before.eventTime !== after.eventTime) {
          this.#todosIndex.proposeUpdate({
            id: ulid(Date.now()),
            recordId: before.id,
            entryId: entry.id,
            text: after.text,
            eventTime: after.eventTime,
            eventEpochMs: after.eventEpochMs,
            eventTimeExplicit: after.eventTimeExplicit,
            reason: 'Reprocessing this entry now extracts different content.',
            now: extractedAt,
          });
        }
      }
      untouchedRaised = [];
    }
    this.#todosIndex.replaceUntouchedRaised(entry.id, untouchedRaised);

    // Never trust a citation blindly — same posture `QuestionsExtractor`
    // applies to its own resolutions.
    const openById = new Map(openTodos.map((t) => [t.id, t] as const));
    for (const completion of result.completions) {
      const record = openById.get(completion.todoId);
      if (!record) continue;

      if (record.touched) {
        // Never applied silently — this is the case `QuestionsIndex.resolve`
        // currently drops rather than surfacing (see its own doc comment);
        // to-dos deliberately do not inherit that gap
        // (`requirements.md` §11).
        this.#todosIndex.proposeCompletion({
          id: ulid(Date.now()),
          recordId: record.id,
          entryId: entry.id,
          resolution: completion.resolution,
          reason: 'Reprocessing found this entry marks it done.',
          now: extractedAt,
        });
      } else {
        this.#todosIndex.completeFromExtraction(record.id, {
          doneEntryId: entry.id,
          resolution: completion.resolution,
          doneAt: extractedAt,
        });
      }
    }

    return { todoCount: raised.length };
  }

  removeEntry(entryId: string): void {
    this.#todosIndex.removeEntry(entryId);
  }

  /** Reprocess-from-scratch, in chronological order — completion-matching
   * can only ever look backward. */
  async reprocessAll(
    store: EntryStore,
  ): Promise<{ entryCount: number; todoCount: number; openCount: number; doneCount: number }> {
    this.#todosIndex.clearUntouched();

    const entries: StoredEntry[] = [];
    let cursor: string | undefined;
    do {
      const page = await store.list({ limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) });
      for (const summary of page.entries) {
        const entry = await store.get(summary.id);
        if (entry) entries.push(entry);
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    entries.sort((a, b) => Date.parse(a.created) - Date.parse(b.created));

    for (const entry of entries) {
      await this.extractEntry(entry);
    }

    const stats = this.#todosIndex.stats();
    return { entryCount: entries.length, ...stats };
  }
}
