import { describe, expect, it } from 'vitest';
import { isUlid, ULID_LENGTH, ulid } from '../../src/record/id.js';

describe('ulid', () => {
  it('is 26 Crockford base32 characters', () => {
    const id = ulid(Date.now());
    expect(id).toHaveLength(ULID_LENGTH);
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(isUlid(id)).toBe(true);
  });

  it('sorts lexically in time order, which is why it is not a UUID', () => {
    const early = ulid(Date.UTC(2020, 0, 1));
    const late = ulid(Date.UTC(2026, 0, 1));
    expect(early < late).toBe(true);
  });

  it('encodes the timestamp it was given, not the clock', () => {
    const at = Date.UTC(2026, 6, 26, 21, 55, 13);
    expect(ulid(at).slice(0, 10)).toBe(ulid(at).slice(0, 10));
    expect(ulid(at).slice(0, 10)).not.toBe(ulid(at + 1).slice(0, 10));
  });

  it('does not repeat itself', () => {
    const at = Date.now();
    const seen = new Set(Array.from({ length: 20_000 }, () => ulid(at)));
    expect(seen.size).toBe(20_000);
  });

  it('refuses a timestamp outside the format', () => {
    expect(() => ulid(-1)).toThrow(RangeError);
    expect(() => ulid(2 ** 48)).toThrow(RangeError);
    expect(() => ulid(1.5)).toThrow(RangeError);
  });
});

describe('isUlid', () => {
  it('accepts a known-good value', () => {
    expect(isUlid('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(true);
  });

  it('rejects the characters Crockford leaves out', () => {
    expect(isUlid('01ARZ3NDEKTSV4RRFFQ69G5FAI')).toBe(false); // I
    expect(isUlid('01ARZ3NDEKTSV4RRFFQ69G5FAL')).toBe(false); // L
    expect(isUlid('01ARZ3NDEKTSV4RRFFQ69G5FAO')).toBe(false); // O
    expect(isUlid('01ARZ3NDEKTSV4RRFFQ69G5FAU')).toBe(false); // U
  });

  it('rejects the wrong length, lowercase, and overflow', () => {
    expect(isUlid('')).toBe(false);
    expect(isUlid('01ARZ3NDEKTSV4RRFFQ69G5FA')).toBe(false);
    expect(isUlid('01ARZ3NDEKTSV4RRFFQ69G5FAVV')).toBe(false);
    expect(isUlid('01arz3ndektsv4rrffq69g5fav')).toBe(false);
    // 10 base32 characters hold 50 bits; the timestamp is 48, so the leading
    // character can never exceed '7'.
    expect(isUlid('81ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(false);
    expect(isUlid('Z1ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(false);
  });
});
