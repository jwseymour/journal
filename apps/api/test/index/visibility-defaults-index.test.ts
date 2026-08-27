import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VisibilityDefaultsIndex } from '../../src/index/visibility-defaults-index.js';

let index: VisibilityDefaultsIndex;

beforeEach(() => {
  index = new VisibilityDefaultsIndex(':memory:');
});

afterEach(() => {
  index.close();
});

describe('isDefaultPublic', () => {
  it('is false for a category that has never been set', () => {
    expect(index.isDefaultPublic('review_medium', 'film')).toBe(false);
  });

  it('reflects whatever was last set', () => {
    index.set('review_medium', 'film', true);
    expect(index.isDefaultPublic('review_medium', 'film')).toBe(true);

    index.set('review_medium', 'film', false);
    expect(index.isDefaultPublic('review_medium', 'film')).toBe(false);
  });

  it('keeps categories of different structure types independent even when the name repeats', () => {
    index.set('metric', 'reading', true);
    expect(index.isDefaultPublic('metric', 'reading')).toBe(true);
    expect(index.isDefaultPublic('list_type', 'reading')).toBe(false);
  });
});

describe('list', () => {
  it('is empty with nothing set', () => {
    expect(index.list()).toEqual([]);
  });

  it('returns every row ever set, most-recent value only', () => {
    index.set('review_medium', 'film', true);
    index.set('opinion_subject', 'philosophy', true);
    index.set('review_medium', 'film', false);

    expect(index.list()).toEqual([
      { structureType: 'opinion_subject', category: 'philosophy', defaultPublic: true },
      { structureType: 'review_medium', category: 'film', defaultPublic: false },
    ]);
  });
});
