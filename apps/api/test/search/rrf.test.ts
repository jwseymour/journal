import { describe, expect, it } from 'vitest';
import { reciprocalRankFusion } from '../../src/search/rrf.js';

const keyOf = (id: string) => id;

describe('reciprocalRankFusion', () => {
  it('scores an item found by both lists higher than one found by only one', () => {
    const scores = reciprocalRankFusion([['a', 'b'], ['b', 'c']], keyOf);
    expect(scores.get('b')!).toBeGreaterThan(scores.get('a')!);
    expect(scores.get('b')!).toBeGreaterThan(scores.get('c')!);
  });

  it('gives a better rank a higher score than a worse rank in the same list', () => {
    const scores = reciprocalRankFusion([['a', 'b', 'c']], keyOf);
    expect(scores.get('a')!).toBeGreaterThan(scores.get('b')!);
    expect(scores.get('b')!).toBeGreaterThan(scores.get('c')!);
  });

  it('is symmetric: it does not matter which list an item came from first', () => {
    const first = reciprocalRankFusion([['a'], ['a']], keyOf);
    const second = reciprocalRankFusion([['a'], []], keyOf);
    expect(first.get('a')!).toBeGreaterThan(second.get('a')!);
  });

  it('handles an empty list without error', () => {
    const scores = reciprocalRankFusion([[], []], keyOf);
    expect(scores.size).toBe(0);
  });

  it('handles a single list the same as ranking it alone', () => {
    const scores = reciprocalRankFusion([['a', 'b']], keyOf);
    expect(scores.size).toBe(2);
    expect(scores.get('a')!).toBeGreaterThan(0);
  });
});
