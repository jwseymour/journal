/**
 * Linear-interpolation resampling to a target rate.
 *
 * Speech-to-text input has no need for audiophile-grade resampling — this
 * exists only so the browser's native microphone rate (typically 44100 or
 * 48000 Hz, and not reliably the caller's choice — see `lib/recorder.ts`)
 * can be brought down to whatever the model actually requires, without a
 * native resampling library.
 */
export function resample(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return samples;

  const ratio = fromRate / toRate;
  const outLength = Math.round(samples.length / ratio);
  const out = new Float32Array(outLength);

  for (let i = 0; i < outLength; i++) {
    const sourceIndex = i * ratio;
    const lower = Math.floor(sourceIndex);
    const upper = Math.min(lower + 1, samples.length - 1);
    const fraction = sourceIndex - lower;
    out[i] = samples[lower]! + (samples[upper]! - samples[lower]!) * fraction;
  }

  return out;
}
