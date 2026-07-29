/**
 * The optional LLM rerank stage over fused search results (`plan.md` M6: "for
 * natural-language queries" — explicitly optional, and its `Done when`
 * clause does not depend on it).
 *
 * There is no implementation of this behind a real model yet: a real one
 * needs `ModelClient`, the single seam a provider is ever named behind
 * (`requirements.md` §7.6), and that seam is M7's job, not this one's.
 * Building a provider call ahead of it would mean inventing the boundary
 * twice. `NoopReranker` is the correct default until then — RRF's fused
 * order is already a real ranking, not a placeholder.
 */
export interface Reranker<T> {
  rerank(query: string, results: T[]): Promise<T[]>;
}

export class NoopReranker<T> implements Reranker<T> {
  async rerank(_query: string, results: T[]): Promise<T[]> {
    return results;
  }
}
