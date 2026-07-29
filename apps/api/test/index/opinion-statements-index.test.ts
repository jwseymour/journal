import { beforeEach, describe, expect, it } from 'vitest';
import { OpinionStatementsIndex, type OpinionStatementRecord } from '../../src/index/opinion-statements-index.js';

let index: OpinionStatementsIndex;

beforeEach(() => {
  index = new OpinionStatementsIndex(':memory:');
});

const record = (overrides: Partial<Omit<OpinionStatementRecord, 'entryId'>> = {}): Omit<
  OpinionStatementRecord,
  'entryId'
> => ({
  id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  subject: 'philosophy',
  statement: 'Believes in living deliberately.',
  eventTime: '2026-07-20T20:00:00+01:00',
  eventEpochMs: Date.parse('2026-07-20T19:00:00Z'),
  eventTimeExplicit: true,
  extractedAt: '2026-07-20T21:00:00+01:00',
  ...overrides,
});

describe('replaceEntry / list', () => {
  it('stores a record and lists it back', () => {
    index.replaceEntry('e1', [record()]);
    expect(index.list({ limit: 10 })).toEqual([{ entryId: 'e1', ...record() }]);
  });

  it('is empty, not an error, when nothing has been extracted', () => {
    expect(index.list({ limit: 10 })).toEqual([]);
  });

  it('filters by subject', () => {
    index.replaceEntry('e1', [record({ id: 's1', subject: 'philosophy' })]);
    index.replaceEntry('e2', [record({ id: 's2', subject: 'future' })]);
    expect(index.list({ subject: 'future', limit: 10 }).map((r) => r.id)).toEqual(['s2']);
  });

  it('keeps two statements on the same subject as two separate records', () => {
    index.replaceEntry('e1', [record({ id: 's1' })]);
    index.replaceEntry('e2', [record({ id: 's2' })]);
    expect(index.list({ limit: 10 })).toHaveLength(2);
  });

  it('replaces the previous records for an entry entirely on a second call', () => {
    index.replaceEntry('e1', [record({ id: 's1', statement: 'First' })]);
    index.replaceEntry('e1', [record({ id: 's2', statement: 'Second' })]);
    const rows = index.list({ limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.statement).toBe('Second');
  });

  it('orders newest first', () => {
    index.replaceEntry('e1', [record({ id: 's1', eventEpochMs: 1000 })]);
    index.replaceEntry('e2', [record({ id: 's2', eventEpochMs: 2000 })]);
    expect(index.list({ limit: 10 }).map((r) => r.id)).toEqual(['s2', 's1']);
  });
});

describe('removeEntry / remove', () => {
  it('removeEntry removes every record for that entry only', () => {
    index.replaceEntry('e1', [record({ id: 's1' })]);
    index.replaceEntry('e2', [record({ id: 's2' })]);
    index.removeEntry('e1');
    expect(index.list({ limit: 10 }).map((r) => r.id)).toEqual(['s2']);
  });

  it('remove discards a single record for correction', () => {
    index.replaceEntry('e1', [record({ id: 's1' }), record({ id: 's2' })]);
    index.remove('s1');
    expect(index.list({ limit: 10 }).map((r) => r.id)).toEqual(['s2']);
  });

  it('remove is a no-op for an id that does not exist', () => {
    expect(() => index.remove('never-existed')).not.toThrow();
  });
});

describe('bySubject', () => {
  it('returns every current statement for a subject, oldest first, unbounded', () => {
    index.replaceEntry('e1', [record({ id: 's1', subject: 'philosophy', eventEpochMs: 2000 })]);
    index.replaceEntry('e2', [record({ id: 's2', subject: 'philosophy', eventEpochMs: 1000 })]);
    index.replaceEntry('e3', [record({ id: 's3', subject: 'future', eventEpochMs: 500 })]);
    expect(index.bySubject('philosophy').map((r) => r.id)).toEqual(['s2', 's1']);
  });

  it('is empty for a subject with no statements', () => {
    expect(index.bySubject('nothing-here')).toEqual([]);
  });
});

describe('subjectsWithStatements', () => {
  it('lists every distinct subject with at least one statement', () => {
    index.replaceEntry('e1', [record({ id: 's1', subject: 'philosophy' })]);
    index.replaceEntry('e2', [record({ id: 's2', subject: 'future' })]);
    expect(index.subjectsWithStatements()).toEqual(['future', 'philosophy']);
  });

  it('is empty when nothing has been extracted', () => {
    expect(index.subjectsWithStatements()).toEqual([]);
  });

  it('stops naming a subject once its last statement is discarded', () => {
    index.replaceEntry('e1', [record({ id: 's1', subject: 'philosophy' })]);
    index.remove('s1');
    expect(index.subjectsWithStatements()).toEqual([]);
  });
});

describe('stats / clear', () => {
  it('counts and wipes', () => {
    index.replaceEntry('e1', [record({ id: 's1' }), record({ id: 's2' })]);
    expect(index.stats()).toEqual({ statementCount: 2 });
    index.clear();
    expect(index.stats()).toEqual({ statementCount: 0 });
  });
});
