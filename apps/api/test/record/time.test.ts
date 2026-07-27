import { describe, expect, it } from 'vitest';
import { nowTimestamp, parseTimestamp } from '../../src/record/time.js';

describe('parseTimestamp', () => {
  it('keeps the wall clock as written, not converted to anything', () => {
    const t = parseTimestamp('2026-07-26T22:55:13+01:00');
    expect(t).not.toBeNull();
    expect([t!.year, t!.month, t!.day, t!.hour, t!.minute, t!.second]).toEqual([
      2026, 7, 26, 22, 55, 13,
    ]);
    expect(t!.offsetMinutes).toBe(60);
    // The instant is an hour earlier than the digits suggest.
    expect(t!.epochMs).toBe(Date.UTC(2026, 6, 26, 21, 55, 13));
  });

  it('distinguishes the same instant written in two offsets', () => {
    const london = parseTimestamp('2026-07-26T22:55:13+01:00')!;
    const utc = parseTimestamp('2026-07-26T21:55:13Z')!;
    const tokyo = parseTimestamp('2026-07-27T06:55:13+09:00')!;

    // Same moment...
    expect(london.epochMs).toBe(utc.epochMs);
    expect(tokyo.epochMs).toBe(utc.epochMs);
    // ...but three different local days and hours, which is what filenames use.
    expect(london.hour).toBe(22);
    expect(utc.hour).toBe(21);
    expect(tokyo.day).toBe(27);
  });

  it('handles negative offsets, including ones with minutes', () => {
    expect(parseTimestamp('2026-01-05T09:30:00-05:00')!.offsetMinutes).toBe(-300);
    expect(parseTimestamp('2026-01-05T09:30:00-03:30')!.offsetMinutes).toBe(-210);
    expect(parseTimestamp('2026-01-05T09:30:00+05:45')!.offsetMinutes).toBe(345);
  });

  it('preserves Z rather than rewriting it as +00:00', () => {
    const t = parseTimestamp('2026-07-26T21:55:13Z')!;
    expect(t.utcDesignator).toBe(true);
    expect(t.canonical).toBe('2026-07-26T21:55:13Z');
  });

  it('drops fractional seconds, which a session start does not need', () => {
    expect(parseTimestamp('2026-07-26T22:55:13.482913+01:00')!.canonical).toBe(
      '2026-07-26T22:55:13+01:00',
    );
  });

  it('folds a leap second rather than rejecting a valid timestamp', () => {
    expect(parseTimestamp('2016-12-31T23:59:60Z')!.second).toBe(59);
  });

  it('accepts a lowercase separator', () => {
    expect(parseTimestamp('2026-07-26t22:55:13+01:00')!.canonical).toBe('2026-07-26T22:55:13+01:00');
  });

  it('validates the calendar', () => {
    expect(parseTimestamp('2026-02-29T00:00:00Z')).toBeNull();
    expect(parseTimestamp('2024-02-29T00:00:00Z')).not.toBeNull();
    expect(parseTimestamp('2026-04-31T00:00:00Z')).toBeNull();
    expect(parseTimestamp('2026-13-01T00:00:00Z')).toBeNull();
    expect(parseTimestamp('2026-00-01T00:00:00Z')).toBeNull();
    expect(parseTimestamp('2026-01-00T00:00:00Z')).toBeNull();
    expect(parseTimestamp('2026-01-01T24:00:00Z')).toBeNull();
  });

  it('refuses a timestamp with no offset, which would be permanently ambiguous', () => {
    expect(parseTimestamp('2026-07-26T22:55:13')).toBeNull();
    expect(parseTimestamp('2026-07-26 22:55:13')).toBeNull();
    expect(parseTimestamp('2026-07-26')).toBeNull();
    expect(parseTimestamp('')).toBeNull();
    expect(parseTimestamp('yesterday')).toBeNull();
  });

  it('handles a year before 0100 without the two-digit-year trap', () => {
    const t = parseTimestamp('0026-07-26T22:55:13Z')!;
    expect(t.year).toBe(26);
    expect(t.canonical).toBe('0026-07-26T22:55:13Z');
    expect(new Date(t.epochMs).getUTCFullYear()).toBe(26);
  });

  it('round-trips its own canonical form', () => {
    for (const value of [
      '2026-07-26T22:55:13+01:00',
      '2026-07-26T21:55:13Z',
      '1999-12-31T23:59:59-08:00',
      '2026-01-05T09:30:00+05:45',
    ]) {
      expect(parseTimestamp(parseTimestamp(value)!.canonical)!.canonical).toBe(value);
    }
  });
});

describe('nowTimestamp', () => {
  it('produces a timestamp that parses back to the same instant', () => {
    const now = new Date();
    const t = nowTimestamp(now);
    expect(parseTimestamp(t.canonical)!.epochMs).toBe(t.epochMs);
    // Second precision, so compare after discarding milliseconds.
    expect(t.epochMs).toBe(Math.floor(now.getTime() / 1000) * 1000);
  });

  it('always carries an offset', () => {
    expect(nowTimestamp().canonical).toMatch(/(Z|[+-]\d{2}:\d{2})$/);
  });
});
