/**
 * Wrapping raw PCM as a playable file (`requirements.md` §4.7).
 *
 * Only needed for the optional "keep the audio" path — transcription itself
 * sends raw samples straight to the backend (`lib/api.ts`'s `transcribe`),
 * never a file. WAV specifically because it needs no encoder at all, just a
 * 44-byte header in front of the same samples already in hand: no compression
 * library, no dependency, and a format every audio player and every markdown
 * viewer's browser can play with zero help from this application
 * (`format.md` §4 — an attachment link has to resolve with the application
 * gone).
 */
export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const bytesPerSample = 2; // 16-bit PCM
  const blockAlign = bytesPerSample; // mono
  const dataSize = samples.length * bytesPerSample;

  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // format 1 = PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bytesPerSample * 8, true); // bits per sample
  writeAscii(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, Math.round(clamped * (clamped < 0 ? 0x8000 : 0x7fff)), true);
    offset += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}
