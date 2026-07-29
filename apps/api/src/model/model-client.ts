import type { z } from 'zod';

/**
 * The seam (`plan.md` M7, `requirements.md` §7.6).
 *
 * The single file in which any provider is named. Everything above this
 * interface — prompts, schemas, extraction pipeline code — knows nothing
 * about the Vercel AI Gateway, the AI SDK, or which provider is actually
 * serving a request. A model or provider swap is changing what implements
 * this interface (or `GatewayModelClient`'s own config), never the calling
 * code.
 */
export interface ExtractionRequest<T> {
  /** What shape a valid answer takes. Validated (and retried on malformed
   * output) by the AI SDK underneath — that is the whole reason
   * `generateObject` was the right primitive for this seam
   * (`requirements.md` §7.6). */
  schema: z.ZodType<T>;
  /** Instructions that hold regardless of the entry being read — never
   * per-entry content. */
  system: string;
  /** The entry-specific content: the prose to extract from. */
  prompt: string;
}

export interface ModelClient {
  extract<T>(request: ExtractionRequest<T>): Promise<T>;
}
