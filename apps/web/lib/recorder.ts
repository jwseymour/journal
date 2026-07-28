/**
 * Microphone capture as raw PCM (`design.md` §5.2 — `⌘⌥R`).
 *
 * `MediaRecorder` — the obvious API for this — hands back *compressed* audio
 * (webm/opus in Chrome, typically AAC in Safari), and decoding an arbitrary
 * container format server-side would mean either a native decoder dependency
 * or a subprocess, exactly what `transcribe/transcriber.ts` exists to avoid.
 * The Web Audio API can capture uncompressed samples directly instead, so
 * nothing ever needs decoding: this is the entire reason a worklet is used
 * here rather than the simpler-looking `MediaRecorder`.
 *
 * `AudioWorkletNode` rather than the older `ScriptProcessorNode`: the latter
 * has been deprecated since 2014, and a system meant to still work in ten
 * years should not be built on the thing already marked for removal.
 *
 * The microphone's native sample rate is kept as-is rather than requesting a
 * specific one — not every browser/device combination honours an
 * `AudioContext`'s requested `sampleRate`, and fighting that negotiation is
 * pointless when resampling to whatever Whisper needs is already the
 * server's job (`transcribe/resample.ts`). The rate actually used is
 * returned alongside the samples so the caller never has to guess it.
 */

export interface Recording {
  samples: Float32Array;
  sampleRate: number;
}

export class VoiceRecorder {
  #audioContext: AudioContext | null = null;
  #stream: MediaStream | null = null;
  #workletNode: AudioWorkletNode | null = null;
  #silentSink: GainNode | null = null;
  #chunks: Float32Array[] = [];

  async start(): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const audioContext = new AudioContext();
    await audioContext.audioWorklet.addModule('/pcm-recorder-worklet.js');

    const source = audioContext.createMediaStreamSource(stream);
    const workletNode = new AudioWorkletNode(audioContext, 'pcm-recorder');
    workletNode.port.onmessage = (event: MessageEvent<Float32Array>) => {
      this.#chunks.push(event.data);
    };

    // Some browsers stop calling `process()` on a node with no path to the
    // destination. A zero-gain node keeps the graph "live" without making any
    // sound — silent on purpose, not a bug if you can't hear yourself.
    const silentSink = audioContext.createGain();
    silentSink.gain.value = 0;
    source.connect(workletNode).connect(silentSink).connect(audioContext.destination);

    this.#audioContext = audioContext;
    this.#stream = stream;
    this.#workletNode = workletNode;
    this.#silentSink = silentSink;
    this.#chunks = [];
  }

  async stop(): Promise<Recording> {
    const audioContext = this.#audioContext;
    if (!audioContext) throw new Error('VoiceRecorder.stop() called without a matching start().');

    this.#workletNode?.disconnect();
    this.#silentSink?.disconnect();
    for (const track of this.#stream?.getTracks() ?? []) track.stop();

    const sampleRate = audioContext.sampleRate;
    await audioContext.close();

    const totalLength = this.#chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const samples = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of this.#chunks) {
      samples.set(chunk, offset);
      offset += chunk.length;
    }

    this.#audioContext = null;
    this.#stream = null;
    this.#workletNode = null;
    this.#silentSink = null;
    this.#chunks = [];

    return { samples, sampleRate };
  }
}
