import { beforeEach, describe, expect, it } from 'vitest';
import { QuestionsIndex, type QuestionRecord } from '../../src/index/questions-index.js';

let index: QuestionsIndex;

beforeEach(() => {
  index = new QuestionsIndex(':memory:');
});

const record = (overrides: Partial<Omit<QuestionRecord, 'entryId'>> = {}): Omit<QuestionRecord, 'entryId'> => ({
  id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  question: 'Should I stay in this job?',
  eventTime: '2026-07-20T20:00:00+01:00',
  eventEpochMs: Date.parse('2026-07-20T19:00:00Z'),
  eventTimeExplicit: true,
  extractedAt: '2026-07-20T21:00:00+01:00',
  status: 'open',
  resolvedEntryId: null,
  resolution: null,
  resolvedAt: null,
  ...overrides,
});

describe('replaceRaised / list', () => {
  it('stores a record and lists it back', () => {
    index.replaceRaised('e1', [record()]);
    expect(index.list({ limit: 10 })).toEqual([{ entryId: 'e1', ...record() }]);
  });

  it('is empty, not an error, when nothing has been extracted', () => {
    expect(index.list({ limit: 10 })).toEqual([]);
  });

  it('filters by status', () => {
    index.replaceRaised('e1', [record({ id: 'm1', status: 'open' })]);
    index.replaceRaised('e2', [
      record({ id: 'm2', status: 'resolved', resolvedEntryId: 'e3', resolution: 'Decided to leave.' }),
    ]);
    expect(index.list({ status: 'resolved', limit: 10 }).map((r) => r.id)).toEqual(['m2']);
  });

  it('replaces only the questions raised by this entry, leaving other entries alone', () => {
    index.replaceRaised('e1', [record({ id: 'm1', question: 'First' })]);
    index.replaceRaised('e2', [record({ id: 'm2', question: 'Second' })]);
    index.replaceRaised('e1', [record({ id: 'm3', question: 'First, revised' })]);
    const rows = index.list({ limit: 10 });
    expect(rows.map((r) => r.id).sort()).toEqual(['m2', 'm3']);
  });

  it('does not disturb a resolution recorded by another entry when the raising entry is reprocessed', () => {
    index.replaceRaised('e1', [record({ id: 'm1' })]);
    index.resolve('m1', { resolvedEntryId: 'e2', resolution: 'Left the job.', resolvedAt: '2026-08-01T00:00:00Z' });

    // Reprocessing e1 again (e.g. a second `reprocessAll` run) mints a fresh
    // id for whatever it raises this time, exactly as the real extractor
    // does — it must not delete-and-recreate the already-resolved row.
    index.replaceRaised('e1', [record({ id: 'm2', question: 'Something else entirely' })]);

    const rows = index.list({ limit: 10 });
    expect(rows.find((r) => r.id === 'm1')).toMatchObject({
      status: 'resolved',
      resolvedEntryId: 'e2',
      resolution: 'Left the job.',
    });
    expect(rows.find((r) => r.id === 'm2')).toMatchObject({ entryId: 'e1', status: 'open' });
  });
});

describe('resolve', () => {
  it('marks an open question resolved, recording which entry and what it said', () => {
    index.replaceRaised('e1', [record({ id: 'm1' })]);
    index.resolve('m1', { resolvedEntryId: 'e2', resolution: 'Decided to leave.', resolvedAt: '2026-08-01T00:00:00Z' });

    const [row] = index.list({ limit: 10 });
    expect(row).toMatchObject({
      status: 'resolved',
      resolvedEntryId: 'e2',
      resolution: 'Decided to leave.',
      resolvedAt: '2026-08-01T00:00:00Z',
    });
  });

  it('is a no-op against a question that is already resolved', () => {
    index.replaceRaised('e1', [record({ id: 'm1' })]);
    index.resolve('m1', { resolvedEntryId: 'e2', resolution: 'First answer.', resolvedAt: '2026-08-01T00:00:00Z' });
    index.resolve('m1', { resolvedEntryId: 'e3', resolution: 'Second answer.', resolvedAt: '2026-09-01T00:00:00Z' });

    const [row] = index.list({ limit: 10 });
    expect(row).toMatchObject({ resolvedEntryId: 'e2', resolution: 'First answer.' });
  });

  it('is a no-op for an id that does not exist', () => {
    expect(() =>
      index.resolve('never-existed', { resolvedEntryId: 'e2', resolution: 'x', resolvedAt: '2026-08-01T00:00:00Z' }),
    ).not.toThrow();
  });
});

describe('reopen', () => {
  it('reverts a resolution without discarding the question', () => {
    index.replaceRaised('e1', [record({ id: 'm1' })]);
    index.resolve('m1', { resolvedEntryId: 'e2', resolution: 'Decided to leave.', resolvedAt: '2026-08-01T00:00:00Z' });

    index.reopen('m1');

    const [row] = index.list({ limit: 10 });
    expect(row).toMatchObject({ status: 'open', resolvedEntryId: null, resolution: null, resolvedAt: null });
  });
});

describe('removeEntry', () => {
  it('removes only the questions this entry raised', () => {
    index.replaceRaised('e1', [record({ id: 'm1' })]);
    index.replaceRaised('e2', [record({ id: 'm2' })]);
    index.removeEntry('e1');
    expect(index.list({ limit: 10 }).map((r) => r.id)).toEqual(['m2']);
  });

  it('reopens a question this entry had resolved, rather than leaving a dangling reference', () => {
    index.replaceRaised('e1', [record({ id: 'm1' })]);
    index.resolve('m1', { resolvedEntryId: 'e2', resolution: 'Decided to leave.', resolvedAt: '2026-08-01T00:00:00Z' });

    index.removeEntry('e2');

    const [row] = index.list({ limit: 10 });
    expect(row).toMatchObject({ id: 'm1', status: 'open', resolvedEntryId: null, resolution: null });
  });
});

describe('remove', () => {
  it('discards a single record entirely', () => {
    index.replaceRaised('e1', [record({ id: 'm1' }), record({ id: 'm2' })]);
    index.remove('m1');
    expect(index.list({ limit: 10 }).map((r) => r.id)).toEqual(['m2']);
  });

  it('is a no-op for an id that does not exist', () => {
    expect(() => index.remove('never-existed')).not.toThrow();
  });
});

describe('listOpen', () => {
  it('returns only open questions, oldest first', () => {
    index.replaceRaised('e1', [record({ id: 'newer', eventEpochMs: Date.parse('2026-07-20T00:00:00Z') })]);
    index.replaceRaised('e2', [record({ id: 'older', eventEpochMs: Date.parse('2026-01-01T00:00:00Z') })]);
    index.replaceRaised('e3', [
      record({ id: 'resolved', status: 'resolved', resolvedEntryId: 'e4', resolution: 'x' }),
    ]);
    expect(index.listOpen().map((r) => r.id)).toEqual(['older', 'newer']);
  });

  it('is empty when nothing is open', () => {
    expect(index.listOpen()).toEqual([]);
  });
});

describe('summarize / stats / clear', () => {
  it('counts open and resolved separately', () => {
    index.replaceRaised('e1', [record({ id: 'm1', status: 'open' })]);
    index.replaceRaised('e2', [
      record({ id: 'm2', status: 'resolved', resolvedEntryId: 'e3', resolution: 'x' }),
    ]);
    expect(index.summarize()).toEqual({ openCount: 1, resolvedCount: 1 });
    expect(index.stats()).toEqual({ questionCount: 2, openCount: 1, resolvedCount: 1 });
  });

  it('is all zero when nothing has been extracted', () => {
    expect(index.summarize()).toEqual({ openCount: 0, resolvedCount: 0 });
    expect(index.stats()).toEqual({ questionCount: 0, openCount: 0, resolvedCount: 0 });
  });

  it('clear wipes everything', () => {
    index.replaceRaised('e1', [record({ id: 'm1' })]);
    index.clear();
    expect(index.stats()).toEqual({ questionCount: 0, openCount: 0, resolvedCount: 0 });
  });
});
