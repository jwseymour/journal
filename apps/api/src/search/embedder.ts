/**
 * The seam for text embedding (`plan.md` M6).
 *
 * Same shape as `transcribe/transcriber.ts` — one interface, swappable,
 * naming no provider. Nothing outside this file may know which model or
 * which runtime produced a vector.
 */
export interface Embedder {
  /**
   * `texts` in, one unit-length vector per text out, same order in as out.
   * Batched deliberately: embedding a whole entry's paragraphs in one call is
   * measurably cheaper than one call per paragraph.
   */
  embed(texts: string[]): Promise<Float32Array[]>;

  /** The fixed length of every vector this embedder produces. */
  readonly dimensions: number;
}
