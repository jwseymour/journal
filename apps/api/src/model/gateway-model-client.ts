import { createGateway, generateObject } from 'ai';
import { extractionFailed } from '../errors.js';
import type { ExtractionRequest, ModelClient } from './model-client.js';

/**
 * The one implementation of `ModelClient` that actually calls a model
 * (`plan.md` M7). Vercel AI Gateway plus the AI SDK, exactly as
 * `requirements.md` §7.6 names as the intended approach: the gateway
 * resolves a `creator/model-name` string in front of every supported
 * provider, and `generateObject` takes a Zod schema and validates
 * (retrying on malformed output) against each provider's own
 * structured-output mechanism underneath.
 *
 * Confirmed by hand against the real gateway on this machine, including the
 * `ai@7` / `@ai-sdk/gateway` packages' `engines` field wanting Node ≥22 —
 * verified working anyway on the Node 20.11.1 this project is pinned to
 * (see `README.md`'s toolchain notes), the same "confirmed rather than
 * assumed" standard `better-sqlite3` and `@huggingface/transformers` were
 * held to.
 */
export class GatewayModelClient implements ModelClient {
  readonly #gateway: ReturnType<typeof createGateway>;
  readonly #modelId: string;

  constructor(apiKey: string, modelId: string) {
    this.#gateway = createGateway({ apiKey });
    this.#modelId = modelId;
  }

  async extract<T>(request: ExtractionRequest<T>): Promise<T> {
    let result: { object: T };
    try {
      result = await generateObject({
        model: this.#gateway(this.#modelId),
        schema: request.schema,
        system: request.system,
        prompt: request.prompt,
      });
    } catch (cause) {
      throw extractionFailed(`The model '${this.#modelId}' could not complete this extraction.`, cause);
    }
    return result.object;
  }
}

/**
 * Stands in when `AI_GATEWAY_API_KEY` is not configured. Boot must not
 * refuse to start over an optional subsystem (`plan.md` M1's reasoning for
 * `JOURNAL_DIR`, applied in the other direction: extraction is layered on
 * top of a journal that must keep writing and reading without it) — this is
 * what lets every extraction-dependent route fail clearly, at the moment it
 * is actually used, instead of boot crashing or silently no-op-ing.
 */
export class UnconfiguredModelClient implements ModelClient {
  async extract<T>(_request: ExtractionRequest<T>): Promise<T> {
    throw extractionFailed(
      'AI_GATEWAY_API_KEY is not set. Extraction needs a Vercel AI Gateway key — see README.md.',
    );
  }
}
