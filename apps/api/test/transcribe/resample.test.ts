import { describe, expect, it } from 'vitest';
import { resample } from '../../src/transcribe/resample.js';

describe('resample', () => {
  it('is a no-op when the rates already match', () => {
    const samples = new Float32Array([0.1, 0.2, 0.3]);
    expect(resample(samples, 16_000, 16_000)).toBe(samples);
  });

  it('halves the sample count when downsampling by half', () => {
    const samples = new Float32Array([0, 1, 0, 1, 0, 1, 0, 1]);
    const out = resample(samples, 32_000, 16_000);
    expect(out.length).toBe(4);
  });

  it('doubles the sample count when upsampling by double', () => {
    const samples = new Float32Array([0, 1, 0, 1]);
    const out = resample(samples, 16_000, 32_000);
    expect(out.length).toBe(8);
  });

  it('preserves a constant signal exactly', () => {
    const samples = new Float32Array(100).fill(0.5);
    const out = resample(samples, 48_000, 16_000);
    for (const value of out) expect(value).toBeCloseTo(0.5, 5);
  });

  it('interpolates linearly between two known points', () => {
    // A single up-ramp from 0 to 1 across the whole buffer; downsampling
    // should still land roughly on the same ramp, monotonically increasing.
    const length = 1000;
    const samples = new Float32Array(length);
    for (let i = 0; i < length; i++) samples[i] = i / (length - 1);

    const out = resample(samples, 48_000, 16_000);
    for (let i = 1; i < out.length; i++) {
      expect(out[i]!).toBeGreaterThanOrEqual(out[i - 1]!);
    }
    expect(out[0]).toBeCloseTo(0, 2);
    expect(out.at(-1)!).toBeCloseTo(1, 1);
  });

  it('never produces NaN or Infinity', () => {
    const samples = new Float32Array(500).map((_, i) => Math.sin(i / 10));
    for (const [from, to] of [
      [44_100, 16_000],
      [48_000, 16_000],
      [16_000, 44_100],
      [8_000, 16_000],
    ] as const) {
      const out = resample(samples, from, to);
      expect(out.every((v) => Number.isFinite(v))).toBe(true);
    }
  });
});
