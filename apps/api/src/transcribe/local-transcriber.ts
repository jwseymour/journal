import { transcriptionFailed } from '../errors.js';
import { resample } from './resample.js';
import type { Transcriber } from './transcriber.js';

/**
 * Local speech-to-text via a Whisper model, running in-process
 * (`requirements.md` §4.7, §7.2 — transcription runs on the local machine so
 * it introduces no dependency on an external service).
 *
 * "In-process" is the property that matters, not the literal execution
 * mechanism: this runs through ONNX Runtime's native Node bindings
 * (`onnxruntime-node`), loaded as an addon into this same process — not a
 * subprocess, not something needing its own binary on `PATH`, not a call over
 * the network. That is the same shape as `sharp` or `better-sqlite3`, and it
 * is what the rest of the codebase means by "swappable, local, no external
 * service," even though the mechanism is a native addon rather than pure
 * WASM bytecode.
 *
 * That native addon *is* the source of a real, worth-recording constraint:
 * `@huggingface/transformers` is pinned to `3.4.0` deliberately, not the
 * latest release. Newer versions pull an `onnxruntime-node` build that ships
 * no Intel-Mac binary at all — confirmed by hand against this exact machine,
 * where `4.2.0` fails to load before a single line of this module's own code
 * runs. `3.4.0`'s pinned `onnxruntime-node@1.20.1` is the last pairing known
 * to work here. Upgrading either package needs the same check repeated.
 *
 * The model loads once, lazily, on first use, and is kept for the life of
 * the process — construction takes real time (model weights have to be read
 * and a session built), and nothing about a transcription request needs a
 * fresh one.
 */
export class LocalTranscriber implements Transcriber {
  readonly #modelId: string;
  readonly #cacheDir: string;
  #pipelinePromise: Promise<AsrPipeline> | null = null;

  constructor(modelId: string, cacheDir: string) {
    this.#modelId = modelId;
    this.#cacheDir = cacheDir;
  }

  async transcribe(samples: Float32Array, sampleRate: number): Promise<string> {
    const pipeline = await this.#getPipeline();
    const resampled = resample(samples, sampleRate, WHISPER_SAMPLE_RATE);

    let result: unknown;
    try {
      result = await pipeline(resampled);
    } catch (cause) {
      throw transcriptionFailed('The local speech-to-text model failed on this recording.', cause);
    }

    return normaliseResult(result);
  }

  /**
   * A failed load must not poison every request after it — see
   * `search/local-embedder.ts`'s identical `#getPipeline`, which shares this
   * exact bug fix. Without the `.catch`, `??=` would permanently cache a
   * *rejected* promise the first time a load failed (a transient network
   * hiccup during the model's one-time download, say), and every later
   * recording would fail the same way forever, even once the network or the
   * cache is fine.
   */
  #getPipeline(): Promise<AsrPipeline> {
    this.#pipelinePromise ??= loadPipeline(this.#modelId, this.#cacheDir).catch((error: unknown) => {
      this.#pipelinePromise = null;
      throw error;
    });
    return this.#pipelinePromise;
  }
}

/** Every Whisper checkpoint on the Hub is trained on 16kHz mono audio. */
const WHISPER_SAMPLE_RATE = 16_000;

// `@huggingface/transformers`'s own types are broader than what this file
// needs; narrowed here to exactly the call shape used above.
type AsrPipeline = (samples: Float32Array) => Promise<unknown>;

async function loadPipeline(modelId: string, cacheDir: string): Promise<AsrPipeline> {
  const { pipeline } = await import('@huggingface/transformers');

  let asr: unknown;
  try {
    // `cache_dir` per call rather than the shared `env.cacheDir` global —
    // the local embedder (`plan.md` M6) loads a model through this same
    // library, and two lazy loaders racing to set one shared global would be
    // a real bug, not a hypothetical one.
    asr = await pipeline('automatic-speech-recognition', modelId, { cache_dir: cacheDir });
  } catch (cause) {
    throw transcriptionFailed(
      `Could not load the local speech-to-text model '${modelId}'. The first run needs a working ` +
        'network connection to download it once; after that it runs from the local cache.',
      cause,
    );
  }
  return asr as AsrPipeline;
}

function normaliseResult(result: unknown): string {
  const text =
    typeof result === 'object' && result !== null && 'text' in result
      ? (result as { text: unknown }).text
      : undefined;
  if (typeof text !== 'string') {
    throw transcriptionFailed('The local speech-to-text model returned an unexpected result.');
  }
  // Whisper's decoder conventionally emits a leading space before the first
  // word; trimmed here so the transcript matches what a typed sentence would
  // look like — the whole point is that it should be indistinguishable.
  return text.trim();
}
