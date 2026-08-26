import { beforeEach, describe, expect, it } from 'vitest';
import { ReviewsIndex, type ReviewRecord } from '../../src/index/reviews-index.js';

let index: ReviewsIndex;

beforeEach(() => {
  index = new ReviewsIndex(':memory:');
});

const record = (overrides: Partial<Omit<ReviewRecord, 'entryId'>> = {}): Omit<ReviewRecord, 'entryId'> => ({
  id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  title: 'Some Film',
  medium: 'film',
  rating: 4,
  progress: 100,
  opinion: 'Really enjoyed it.',
  eventTime: '2026-07-20T20:00:00+01:00',
  eventEpochMs: Date.parse('2026-07-20T19:00:00Z'),
  eventTimeExplicit: true,
  extractedAt: '2026-07-20T21:00:00+01:00',
  touched: false,
  ...overrides,
});

describe('replaceEntry / list', () => {
  it('stores a record and lists it back, rating included', () => {
    index.replaceEntry('e1', [record()]);
    expect(index.list({ limit: 10 })).toEqual([{ entryId: 'e1', ...record() }]);
  });

  it('stores a null rating faithfully — never defaulted to a number', () => {
    index.replaceEntry('e1', [record({ rating: null })]);
    expect(index.list({ limit: 10 })[0]!.rating).toBeNull();
  });

  it('stores a null progress faithfully — never defaulted to a number', () => {
    index.replaceEntry('e1', [record({ progress: null })]);
    expect(index.list({ limit: 10 })[0]!.progress).toBeNull();
  });

  it('stores a partial progress value', () => {
    index.replaceEntry('e1', [record({ progress: 50 })]);
    expect(index.list({ limit: 10 })[0]!.progress).toBe(50);
  });

  it('is empty, not an error, when nothing has been extracted', () => {
    expect(index.list({ limit: 10 })).toEqual([]);
  });

  it('filters by medium', () => {
    index.replaceEntry('e1', [record({ id: 'm1', medium: 'film' })]);
    index.replaceEntry('e2', [record({ id: 'm2', medium: 'book' })]);
    expect(index.list({ medium: 'book', limit: 10 }).map((r) => r.id)).toEqual(['m2']);
  });

  it('keeps two encounters with the same title as two separate records', () => {
    index.replaceEntry('e1', [record({ id: 'm1', title: 'Same Film' })]);
    index.replaceEntry('e2', [record({ id: 'm2', title: 'Same Film' })]);
    expect(index.list({ limit: 10 })).toHaveLength(2);
  });

  it('replaces the previous records for an entry entirely on a second call', () => {
    index.replaceEntry('e1', [record({ id: 'm1', title: 'First' })]);
    index.replaceEntry('e1', [record({ id: 'm2', title: 'Second' })]);
    const rows = index.list({ limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe('Second');
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

  it('remove is a no-op for an id that does not exist', () => {
    expect(() => index.remove('never-existed')).not.toThrow();
  });
});

describe('stats / clear', () => {
  it('counts and wipes', () => {
    index.replaceEntry('e1', [record({ id: 'm1' }), record({ id: 'm2' })]);
    expect(index.stats()).toEqual({ reviewCount: 2 });
    index.clear();
    expect(index.stats()).toEqual({ reviewCount: 0 });
  });
});

describe('touching a record (`plan.md` M10)', () => {
  it('update() edits given fields and sets touched', () => {
    index.replaceEntry('e1', [record({ id: 'm1', opinion: 'first take' })]);
    const updated = index.update('m1', { opinion: 'revised take', rating: 5 }, 'now');
    expect(updated).toMatchObject({ opinion: 'revised take', rating: 5, touched: true });
  });

  it('update() returns null for an id that does not exist', () => {
    expect(index.update('never-existed', { opinion: 'x' }, 'now')).toBeNull();
  });

  it('validate() and untouch() flip the flag with no content change', () => {
    index.replaceEntry('e1', [record({ id: 'm1' })]);
    index.validate('m1', 'now');
    expect(index.list({ limit: 10 })[0]!.touched).toBe(true);
    index.untouch('m1', 'now');
    expect(index.list({ limit: 10 })[0]!.touched).toBe(false);
  });
});

describe('replaceUntouchedForEntry (`plan.md` M10)', () => {
  it('protects a touched row while replacing the untouched ones', () => {
    index.replaceEntry('e1', [record({ id: 'm1', title: 'keep' }), record({ id: 'm2', title: 'stale' })]);
    index.validate('m1', 'now');
    index.replaceUntouchedForEntry('e1', [record({ id: 'm3', title: 'fresh' })]);
    expect(index.list({ limit: 10 }).map((r) => r.id).sort()).toEqual(['m1', 'm3']);
  });
});

describe('update suggestions (`plan.md` M10)', () => {
  it('propose, then approve, applies the proposed fields and stays touched', () => {
    index.replaceEntry('e1', [record({ id: 'm1', opinion: 'original' })]);
    index.validate('m1', 'now');
    index.proposeUpdate({
      id: 's1',
      recordId: 'm1',
      entryId: 'e1',
      title: record().title,
      rating: record().rating,
      progress: record().progress,
      opinion: 'reprocessed opinion',
      eventTime: record().eventTime,
      eventEpochMs: record().eventEpochMs,
      eventTimeExplicit: true,
      reason: 'reason',
      now: 'now',
    });
    index.decideUpdate('s1', 'approved', 'now');
    expect(index.list({ limit: 10 })[0]).toMatchObject({ opinion: 'reprocessed opinion', touched: true });
  });
});

describe('clearUntouched (`plan.md` M10)', () => {
  it('wipes untouched rows but leaves a touched row in place', () => {
    index.replaceEntry('e1', [record({ id: 'm1' })]);
    index.replaceEntry('e2', [record({ id: 'm2' })]);
    index.validate('m1', 'now');
    index.clearUntouched();
    expect(index.list({ limit: 10 }).map((r) => r.id)).toEqual(['m1']);
  });
});

describe('summarize', () => {
  it('gives a zero row for a medium with no reviews at all', () => {
    expect(index.summarize(['film'])).toEqual([{ medium: 'film', count: 0, averageRating: null }]);
  });

  it('averages only the non-null ratings, never coercing a missing rating to zero', () => {
    index.replaceEntry('e1', [record({ id: 'm1', medium: 'film', rating: 4 })]);
    index.replaceEntry('e2', [record({ id: 'm2', medium: 'film', rating: null })]);
    const [summary] = index.summarize(['film']);
    expect(summary).toEqual({ medium: 'film', count: 2, averageRating: 4 });
  });

  it('is null, not zero, when every review in the medium has no rating', () => {
    index.replaceEntry('e1', [record({ id: 'm1', medium: 'book', rating: null })]);
    const [summary] = index.summarize(['book']);
    expect(summary!.averageRating).toBeNull();
  });

  it('returns one summary per approved medium, in the order given', () => {
    index.replaceEntry('e1', [record({ id: 'm1', medium: 'book', rating: 3 })]);
    const summaries = index.summarize(['film', 'book']);
    expect(summaries.map((s) => s.medium)).toEqual(['film', 'book']);
    expect(summaries[0]!.count).toBe(0);
    expect(summaries[1]!.count).toBe(1);
  });
});
