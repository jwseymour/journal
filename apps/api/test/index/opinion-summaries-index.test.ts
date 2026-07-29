import { beforeEach, describe, expect, it } from 'vitest';
import { OpinionSummariesIndex, type OpinionSummaryPartRecord } from '../../src/index/opinion-summaries-index.js';

let index: OpinionSummariesIndex;

beforeEach(() => {
  index = new OpinionSummariesIndex(':memory:');
});

const part = (overrides: Partial<Omit<OpinionSummaryPartRecord, 'subject'>> = {}): Omit<
  OpinionSummaryPartRecord,
  'subject'
> => ({
  id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  partIndex: 0,
  text: 'Believes in living deliberately.',
  sourceStatementIds: ['s1'],
  sourceEntryIds: ['e1'],
  generatedAt: '2026-07-20T21:00:00+01:00',
  ...overrides,
});

describe('replaceSubject / list', () => {
  it('stores parts and lists them back, source ids included', () => {
    index.replaceSubject('philosophy', [part()]);
    expect(index.list('philosophy')).toEqual([{ subject: 'philosophy', ...part() }]);
  });

  it('is empty, not an error, when nothing has been generated', () => {
    expect(index.list()).toEqual([]);
  });

  it('round-trips multiple source ids per part', () => {
    index.replaceSubject('philosophy', [
      part({ sourceStatementIds: ['s1', 's2'], sourceEntryIds: ['e1', 'e2'] }),
    ]);
    const [row] = index.list('philosophy');
    expect(row!.sourceStatementIds).toEqual(['s1', 's2']);
    expect(row!.sourceEntryIds).toEqual(['e1', 'e2']);
  });

  it('lists every subject, ordered by subject then part index, when no subject is given', () => {
    index.replaceSubject('philosophy', [part({ id: 'p1', partIndex: 0 })]);
    index.replaceSubject('future', [part({ id: 'p2', partIndex: 0 })]);
    expect(index.list().map((p) => p.subject)).toEqual(['future', 'philosophy']);
  });

  it('replaces every part for a subject entirely on a second call', () => {
    index.replaceSubject('philosophy', [part({ id: 'p1', text: 'First' })]);
    index.replaceSubject('philosophy', [part({ id: 'p2', text: 'Second' })]);
    const rows = index.list('philosophy');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).toBe('Second');
  });

  it('preserves part order within a subject', () => {
    index.replaceSubject('philosophy', [
      part({ id: 'p2', partIndex: 1, text: 'Second' }),
      part({ id: 'p1', partIndex: 0, text: 'First' }),
    ]);
    expect(index.list('philosophy').map((p) => p.text)).toEqual(['First', 'Second']);
  });
});

describe('removeSubject', () => {
  it('removes every part for that subject only', () => {
    index.replaceSubject('philosophy', [part({ id: 'p1' })]);
    index.replaceSubject('future', [part({ id: 'p2' })]);
    index.removeSubject('philosophy');
    expect(index.subjects()).toEqual(['future']);
  });
});

describe('subjects', () => {
  it('lists every subject with at least one part', () => {
    index.replaceSubject('philosophy', [part({ id: 'p1' })]);
    index.replaceSubject('future', [part({ id: 'p2' })]);
    expect(index.subjects()).toEqual(['future', 'philosophy']);
  });
});

describe('stats / clear', () => {
  it('counts subjects and parts, and wipes', () => {
    index.replaceSubject('philosophy', [part({ id: 'p1' }), part({ id: 'p2', partIndex: 1 })]);
    index.replaceSubject('future', [part({ id: 'p3' })]);
    expect(index.stats()).toEqual({ subjectCount: 2, partCount: 3 });
    index.clear();
    expect(index.stats()).toEqual({ subjectCount: 0, partCount: 0 });
  });
});
