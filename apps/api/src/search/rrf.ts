/**
 * Reciprocal rank fusion (`plan.md` M6): combines two independently ranked
 * lists — BM25 text and vector kNN score on different, incomparable scales,
 * so fusing by each item's *rank* rather than its raw score is what lets one
 * ranking stand in for "found by meaning" and the other for "found by word,"
 * without one dominating the other by magnitude alone.
 *
 * `k = 60` is the constant from the original paper (Cormack et al., 2009) —
 * large enough that the difference between rank 1 and rank 2 does not
 * swamp everything below it.
 */
const K = 60;

/**
 * `lists` are each already ranked best-first. `keyOf` extracts the identity
 * to fuse on — two hits with the same key, from different lists, are the
 * same result found two ways, and their scores add.
 */
export function reciprocalRankFusion<T>(lists: T[][], keyOf: (item: T) => string): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((item, index) => {
      const key = keyOf(item);
      const rank = index + 1;
      scores.set(key, (scores.get(key) ?? 0) + 1 / (K + rank));
    });
  }
  return scores;
}
