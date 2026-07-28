// Runs on the audio rendering thread, not the main thread — this is why it is
// a plain script rather than TypeScript, and why it cannot import anything
// from the rest of the app. Its only job is to hand each render quantum of
// microphone samples back to the main thread untouched: no resampling, no
// encoding, no decisions. See `lib/recorder.ts` for what happens with them.
class PCMRecorderProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel) {
      // `channel` is a view onto a buffer the audio thread reuses on the next
      // render quantum — copied here so the message we post is this moment's
      // samples, not whatever overwrites them a few milliseconds later.
      this.port.postMessage(channel.slice());
    }
    return true; // keep the processor alive for the next render quantum
  }
}

registerProcessor('pcm-recorder', PCMRecorderProcessor);
