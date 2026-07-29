import { beforeEach, describe, expect, it } from 'vitest';
import { ListsIndex, type ListItemRecord } from '../../src/index/lists-index.js';

let index: ListsIndex;

beforeEach(() => {
  index = new ListsIndex(':memory:');
});

const record = (overrides: Partial<Omit<ListItemRecord, 'entryId'>> = {}): Omit<ListItemRecord, 'entryId'> => ({
  id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  listType: 'quote',
  text: '"The unexamined life is not worth living."',
  context: 'Socrates, quoted in a book I was reading',
  eventTime: '2026-07-20T20:00:00+01:00',
  eventEpochMs: Date.parse('2026-07-20T19:00:00Z'),
  eventTimeExplicit: true,
  extractedAt: '2026-07-20T21:00:00+01:00',
  ...overrides,
});

describe('replaceEntry / list', () => {
  it('stores a record and lists it back verbatim', () => {
    index.replaceEntry('e1', [record()]);
    expect(index.list({ limit: 10 })).toEqual([{ entryId: 'e1', ...record() }]);
  });

  it('is empty, not an error, when nothing has been extracted', () => {
    expect(index.list({ limit: 10 })).toEqual([]);
  });

  it('filters by listType', () => {
    index.replaceEntry('e1', [record({ id: 'm1', listType: 'quote' })]);
    index.replaceEntry('e2', [record({ id: 'm2', listType: 'todo' })]);
    expect(index.list({ listType: 'todo', limit: 10 }).map((r) => r.id)).toEqual(['m2']);
  });

  it('replaces the previous records for an entry entirely on a second call', () => {
    index.replaceEntry('e1', [record({ id: 'm1', text: 'first' })]);
    index.replaceEntry('e1', [record({ id: 'm2', text: 'second' })]);
    const rows = index.list({ limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).toBe('second');
  });

  it('preserves an empty context string rather than coercing it', () => {
    index.replaceEntry('e1', [record({ context: '' })]);
    expect(index.list({ limit: 10 })[0]!.context).toBe('');
  });
});

describe('removeEntry / remove', () => {
  it('removeEntry removes every record for that entry only', () => {
    index.replaceEntry('e1', [record({ id: 'm1' })]);
    index.replaceEntry('e2', [record({ id: 'm2' })]);
    index.removeEntry('e1');
    expect(index.list({ limit: 10 }).map((r) => r.id)).toEqual(['m2']);
  });

  it('remove discards a single record for correction', () => {
    index.replaceEntry('e1', [record({ id: 'm1' }), record({ id: 'm2' })]);
    index.remove('m1');
    expect(index.list({ limit: 10 }).map((r) => r.id)).toEqual(['m2']);
  });
});

describe('stats / clear', () => {
  it('counts and wipes', () => {
    index.replaceEntry('e1', [record({ id: 'm1' }), record({ id: 'm2' })]);
    expect(index.stats()).toEqual({ itemCount: 2 });
    index.clear();
    expect(index.stats()).toEqual({ itemCount: 0 });
  });
});

describe('summarize', () => {
  it('gives a zero row for a type with no items at all', () => {
    expect(index.summarize(['quote'])).toEqual([{ listType: 'quote', count: 0 }]);
  });

  it('returns one summary per approved type, in the order given', () => {
    index.replaceEntry('e1', [record({ id: 'm1', listType: 'quote' })]);
    const summaries = index.summarize(['todo', 'quote']);
    expect(summaries).toEqual([
      { listType: 'todo', count: 0 },
      { listType: 'quote', count: 1 },
    ]);
  });
});
