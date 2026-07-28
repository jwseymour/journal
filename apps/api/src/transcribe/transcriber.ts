/**
 * The seam for speech-to-text (`plan.md` M4).
 *
 * One file, swappable, mirroring the pattern every other external capability
 * uses in this codebase (`store/entry-store.ts` for storage,
 * `record/hash.ts` for the write precondition). Nothing outside this
 * interface may know which model, which runtime, or which provider is doing
 * the work.
 *
 * The input is raw PCM, not a file or a URL. Browsers hand back compressed
 * audio (webm/opus, or AAC on Safari) from `MediaRecorder`, and decoding an
 * arbitrary container format server-side would mean either a native decoder
 * dependency or a subprocess — exactly what this interface exists to avoid.
 * The frontend instead captures uncompressed samples directly via the Web
 * Audio API (see `lib/recorder.ts`), so nothing arrives here that needs
 * unpacking, only resampling to whatever rate the model wants — which is this
 * module's job, not the caller's.
 */
export interface Transcriber {
  /**
   * `samples` are mono PCM in the range [-1, 1], captured at `sampleRate` Hz.
   * Resolves to the plain-text transcript. Never modifies anything —
   * transcription reads audio and returns text, nothing else.
   */
  transcribe(samples: Float32Array, sampleRate: number): Promise<string>;
}
