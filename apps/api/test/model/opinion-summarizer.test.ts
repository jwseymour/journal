import { beforeEach, describe, expect, it } from 'vitest';
import { OpinionStatementsIndex } from '../../src/index/opinion-statements-index.js';
import { OpinionSummariesIndex } from '../../src/index/opinion-summaries-index.js';
import type { ExtractionRequest, ModelClient } from '../../src/model/model-client.js';
import { OpinionSummarizer } from '../../src/model/opinion-summarizer.js';
import type { OpinionSummaryResult } from '../../src/model/opinion-summaries.js';

class FakeModelClient implements ModelClient {
  calls: ExtractionRequest<unknown>[] = [];
  result: OpinionSummaryResult = { parts: [] };
  /** When set, takes priority over `result` — lets a test vary the answer by
   * which subject's statements were actually sent, the same way a real
   * model's answer would vary. */
  resultFor?: (prompt: string) => OpinionSummaryResult;

  async extract<T>(request: ExtractionRequest<T>): Promise<T> {
    this.calls.push(request as ExtractionRequest<unknown>);
    const result = this.resultFor ? this.resultFor(request.prompt) : this.result;
    return result as unknown as T;
  }
}

let statementsIndex: OpinionStatementsIndex;
let summariesIndex: OpinionSummariesIndex;
let modelClient: FakeModelClient;
let summarizer: OpinionSummarizer;

beforeEach(() => {
  statementsIndex = new OpinionStatementsIndex(':memory:');
  summariesIndex = new OpinionSummariesIndex(':memory:');
  modelClient = new FakeModelClient();
  summarizer = new OpinionSummarizer(summariesIndex, statementsIndex, modelClient);
});

describe('summarizeSubject', () => {
  it('stores one part per part the model returns, citations resolved to entry ids', async () => {
    statementsIndex.replaceEntry('e1', [
      {
        id: 's1',
        subject: 'philosophy',
        statement: 'Believes in living deliberately.',
        eventTime: '2026-07-20T20:00:00+01:00',
        eventEpochMs: 1000,
        eventTimeExplicit: true,
        extractedAt: '2026-07-20T21:00:00+01:00',
        touched: false,
      },
    ]);
    modelClient.result = { parts: [{ text: 'Values living deliberately.', sourceStatementIds: ['s1'] }] };

    await summarizer.summarizeSubject('philosophy');

    const [part] = summariesIndex.list('philosophy');
    expect(part).toMatchObject({
      subject: 'philosophy',
      partIndex: 0,
      text: 'Values living deliberately.',
      sourceStatementIds: ['s1'],
      sourceEntryIds: ['e1'],
    });
  });

  it('removes any existing summary and stores nothing when there are no statements', async () => {
    summariesIndex.replaceSubject('philosophy', [
      {
        id: 'stale',
        partIndex: 0,
        text: 'stale',
        sourceStatementIds: ['gone'],
        sourceEntryIds: ['gone'],
        generatedAt: '2026-01-01T00:00:00Z',
      },
    ]);

    await summarizer.summarizeSubject('philosophy');

    expect(summariesIndex.list('philosophy')).toEqual([]);
  });

  it('drops a hallucinated citation but keeps the part when at least one citation is real', async () => {
    statementsIndex.replaceEntry('e1', [
      {
        id: 's1',
        subject: 'philosophy',
        statement: 'Real statement.',
        eventTime: '2026-07-20T20:00:00+01:00',
        eventEpochMs: 1000,
        eventTimeExplicit: true,
        extractedAt: '2026-07-20T21:00:00+01:00',
        touched: false,
      },
    ]);
    modelClient.result = {
      parts: [{ text: 'A part.', sourceStatementIds: ['s1', 'invented-id-that-does-not-exist'] }],
    };

    await summarizer.summarizeSubject('philosophy');

    const [part] = summariesIndex.list('philosophy');
    expect(part!.sourceStatementIds).toEqual(['s1']);
    expect(part!.sourceEntryIds).toEqual(['e1']);
  });

  it('drops a part entirely when every citation it names is hallucinated', async () => {
    statementsIndex.replaceEntry('e1', [
      {
        id: 's1',
        subject: 'philosophy',
        statement: 'Real statement.',
        eventTime: '2026-07-20T20:00:00+01:00',
        eventEpochMs: 1000,
        eventTimeExplicit: true,
        extractedAt: '2026-07-20T21:00:00+01:00',
        touched: false,
      },
    ]);
    modelClient.result = {
      parts: [
        { text: 'A fabricated part.', sourceStatementIds: ['invented-id'] },
        { text: 'A real part.', sourceStatementIds: ['s1'] },
      ],
    };

    await summarizer.summarizeSubject('philosophy');

    const parts = summariesIndex.list('philosophy');
    expect(parts).toHaveLength(1);
    expect(parts[0]!.text).toBe('A real part.');
  });

  it('de-duplicates source entry ids when multiple cited statements share an entry', async () => {
    statementsIndex.replaceEntry('e1', [
      {
        id: 's1',
        subject: 'philosophy',
        statement: 'First view, same entry.',
        eventTime: '2026-07-20T20:00:00+01:00',
        eventEpochMs: 1000,
        eventTimeExplicit: true,
        extractedAt: '2026-07-20T21:00:00+01:00',
        touched: false,
      },
      {
        id: 's2',
        subject: 'philosophy',
        statement: 'Second view, same entry.',
        eventTime: '2026-07-20T20:05:00+01:00',
        eventEpochMs: 1300,
        eventTimeExplicit: true,
        extractedAt: '2026-07-20T21:00:00+01:00',
        touched: false,
      },
    ]);
    modelClient.result = { parts: [{ text: 'Combined.', sourceStatementIds: ['s1', 's2'] }] };

    await summarizer.summarizeSubject('philosophy');

    const [part] = summariesIndex.list('philosophy');
    expect(part!.sourceEntryIds).toEqual(['e1']);
  });

  it('replaces a previous summary for the subject entirely, not appending to it', async () => {
    statementsIndex.replaceEntry('e1', [
      {
        id: 's1',
        subject: 'philosophy',
        statement: 'x',
        eventTime: '2026-07-20T20:00:00+01:00',
        eventEpochMs: 1000,
        eventTimeExplicit: true,
        extractedAt: '2026-07-20T21:00:00+01:00',
        touched: false,
      },
    ]);
    modelClient.result = { parts: [{ text: 'First run.', sourceStatementIds: ['s1'] }] };
    await summarizer.summarizeSubject('philosophy');

    modelClient.result = { parts: [{ text: 'Second run.', sourceStatementIds: ['s1'] }] };
    await summarizer.summarizeSubject('philosophy');

    const parts = summariesIndex.list('philosophy');
    expect(parts).toHaveLength(1);
    expect(parts[0]!.text).toBe('Second run.');
  });

  it('passes statements to the model oldest first', async () => {
    statementsIndex.replaceEntry('e1', [
      {
        id: 's-new',
        subject: 'philosophy',
        statement: 'newer',
        eventTime: '2026-07-20T20:00:00+01:00',
        eventEpochMs: 2000,
        eventTimeExplicit: true,
        extractedAt: '2026-07-20T21:00:00+01:00',
        touched: false,
      },
    ]);
    statementsIndex.replaceEntry('e2', [
      {
        id: 's-old',
        subject: 'philosophy',
        statement: 'older',
        eventTime: '2026-07-19T20:00:00+01:00',
        eventEpochMs: 1000,
        eventTimeExplicit: true,
        extractedAt: '2026-07-19T21:00:00+01:00',
        touched: false,
      },
    ]);

    await summarizer.summarizeSubject('philosophy');

    const prompt = modelClient.calls[0]!.prompt;
    expect(prompt.indexOf('s-old')).toBeLessThan(prompt.indexOf('s-new'));
  });
});

describe('summarizeAll', () => {
  it('regenerates every subject with at least one current statement, clearing anything stale first', async () => {
    statementsIndex.replaceEntry('e1', [
      {
        id: 's1',
        subject: 'philosophy',
        statement: 'x',
        eventTime: '2026-07-20T20:00:00+01:00',
        eventEpochMs: 1000,
        eventTimeExplicit: true,
        extractedAt: '2026-07-20T21:00:00+01:00',
        touched: false,
      },
    ]);
    statementsIndex.replaceEntry('e2', [
      {
        id: 's2',
        subject: 'future',
        statement: 'y',
        eventTime: '2026-07-20T20:00:00+01:00',
        eventEpochMs: 1000,
        eventTimeExplicit: true,
        extractedAt: '2026-07-20T21:00:00+01:00',
        touched: false,
      },
    ]);
    summariesIndex.replaceSubject('career', [
      {
        id: 'stale',
        partIndex: 0,
        text: 'stale subject with no current statements',
        sourceStatementIds: ['gone'],
        sourceEntryIds: ['gone'],
        generatedAt: '2026-01-01T00:00:00Z',
      },
    ]);
    modelClient.resultFor = (prompt) => ({
      parts: [{ text: 'A part.', sourceStatementIds: [prompt.includes('id: s1') ? 's1' : 's2'] }],
    });

    const result = await summarizer.summarizeAll();

    expect(summariesIndex.subjects().sort()).toEqual(['future', 'philosophy']);
    expect(result).toEqual({ subjectCount: 2, partCount: 2 });
  });

  it('is a no-op producing an empty store when there are no statements at all', async () => {
    const result = await summarizer.summarizeAll();
    expect(result).toEqual({ subjectCount: 0, partCount: 0 });
  });
});
