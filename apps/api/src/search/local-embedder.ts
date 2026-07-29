import { searchUnavailable } from '../errors.js';
import type { Embedder } from './embedder.js';

/**
 * Local text embedding via a sentence-transformer model, running in-process —
 * the same shape and the same reasoning as `transcribe/local-transcriber.ts`:
 * ONNX Runtime's native Node bindings, not a subprocess, not a network call.
 * See that file for why this counts as "local" even though the mechanism is
 * a native addon rather than literal WASM bytecode, and for the
 * `@huggingface/transformers@3.4.0` / `onnxruntime-node@1.20.1` pin this
 * shares with it.
 *
 * Loads once, lazily, on first use, and is kept for the process's life —
 * exactly like the transcriber, and for the same reason: construction reads
 * real model weights, and nothing about one embedding request needs a fresh
 * pipeline.
 */
export class LocalEmbedder implements Embedder {
  readonly #modelId: string;
  readonly #cacheDir: string;
  readonly dimensions: number;
  #pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;

  constructor(modelId: string, cacheDir: string, dimensions: number) {
    this.#modelId = modelId;
    this.#cacheDir = cacheDir;
    this.dimensions = dimensions;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const pipeline = await this.#getPipeline();

    let output: FeatureExtractionOutput;
    try {
      output = await pipeline(texts, { pooling: 'mean', normalize: true });
    } catch (cause) {
      throw searchUnavailable('The local embedding model failed on this text.', cause);
    }

    return splitRows(output, texts.length, this.dimensions);
  }

  /**
   * A failed load must not poison every request after it. Without the
   * `.catch` below, a single transient failure (the model's first download
   * racing the network coming up, say) would cache a *rejected* promise in
   * `#pipelinePromise` forever — `??=` only assigns when the field is still
   * null, and a rejected promise is not null, so every later call would
   * keep returning that same dead promise even once the network, or the
   * cache, is fine. Resetting the field on failure is what lets the next
   * request try again instead of repeating history verbatim.
   */
  #getPipeline(): Promise<FeatureExtractionPipeline> {
    this.#pipelinePromise ??= loadPipeline(this.#modelId, this.#cacheDir).catch((error: unknown) => {
      this.#pipelinePromise = null;
      throw error;
    });
    return this.#pipelinePromise;
  }
}

// `@huggingface/transformers`'s own types are broader than what this file
// needs; narrowed here to exactly the call shape used above.
interface FeatureExtractionOutput {
  data: Float32Array;
  dims: number[];
}
type FeatureExtractionPipeline = (
  texts: string[],
  options: { pooling: 'mean'; normalize: boolean },
) => Promise<FeatureExtractionOutput>;

async function loadPipeline(modelId: string, cacheDir: string): Promise<FeatureExtractionPipeline> {
  const { pipeline } = await import('@huggingface/transformers');

  let extractor: unknown;
  try {
    // `cache_dir` per call, not the shared `env.cacheDir` global — this
    // model and `transcribe/local-transcriber.ts`'s both load through the
    // same library, and two lazy loaders racing to set one shared global
    // would be a real bug.
    extractor = await pipeline('feature-extraction', modelId, { cache_dir: cacheDir });
  } catch (cause) {
    throw searchUnavailable(
      `Could not load the local embedding model '${modelId}'. The first run needs a working ` +
        'network connection to download it once; after that it runs from the local cache.',
      cause,
    );
  }
  return extractor as FeatureExtractionPipeline;
}

/** The pipeline returns one flat buffer for the whole batch — row-major,
 * `rowCount` rows of `dimensions` floats each — so this slices it back into
 * one vector per input text. */
function splitRows(output: FeatureExtractionOutput, rowCount: number, dimensions: number): Float32Array[] {
  const [actualRows, actualDims] = output.dims;
  if (actualRows !== rowCount || actualDims !== dimensions) {
    throw searchUnavailable(
      `The local embedding model returned a ${actualRows}x${actualDims} result for ${rowCount} ` +
        `texts, expected ${rowCount}x${dimensions}.`,
    );
  }
  return Array.from({ length: rowCount }, (_, i) =>
    output.data.slice(i * dimensions, (i + 1) * dimensions),
  );
}
