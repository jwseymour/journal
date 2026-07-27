import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/errors.js';
import {
  compareDescending,
  decodeCursor,
  encodeCursor,
  isAfterCursor,
} from '../../src/store/cursor.js';

describe('cursors', () => {
  it('round-trip', () => {
    const cursor = { epochMs: 1_785_100_513_000, id: '01K3F9X2VQ8N7M4TQXYZ8ABCDE' };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('are opaque, carrying nothing readable in the URL', () => {
    const encoded = encodeCursor({ epochMs: 1, id: '01K3F9X2VQ8N7M4TQXYZ8ABCDE' });
    expect(encoded).not.toContain('01K3F9');
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('reject anything this server did not issue', () => {
    for (const value of [
      '',
      'not-base64!!',
      Buffer.from('{}').toString('base64url'),
      Buffer.from('[1,2,3]').toString('base64url'),
      Buffer.from('["e0",1,"x"]').toString('base64url'),
      Buffer.from('["e1","notanumber","x"]').toString('base64url'),
      Buffer.from('["e1",1,""]').toString('base64url'),
    ]) {
      let thrown: unknown;
      try {
        decodeCursor(value);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, `should reject ${JSON.stringify(value)}`).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe('invalid_cursor');
    }
  });
});

describe('ordering', () => {
  it('is newest first, with the id breaking ties', () => {
    const a = { epochMs: 200, id: 'B' };
    const b = { epochMs: 100, id: 'Z' };
    const c = { epochMs: 200, id: 'A' };
    expect([b, c, a].sort(compareDescending)).toEqual([a, c, b]);
  });

  it('orders by instant, not by the text of the timestamp', () => {
    // 22:55+01:00 is *earlier* than 22:55Z. Text comparison would get this wrong.
    const london = { epochMs: Date.UTC(2026, 6, 26, 21, 55), id: 'A' };
    const utc = { epochMs: Date.UTC(2026, 6, 26, 22, 55), id: 'B' };
    expect([london, utc].sort(compareDescending)).toEqual([utc, london]);
  });

  it('decides page membership consistently with the sort', () => {
    const cursor = { epochMs: 200, id: 'M' };
    expect(isAfterCursor({ epochMs: 200, id: 'A' }, cursor)).toBe(true);
    expect(isAfterCursor({ epochMs: 200, id: 'Z' }, cursor)).toBe(false);
    expect(isAfterCursor({ epochMs: 200, id: 'M' }, cursor)).toBe(false);
    expect(isAfterCursor({ epochMs: 100, id: 'Z' }, cursor)).toBe(true);
    expect(isAfterCursor({ epochMs: 300, id: 'A' }, cursor)).toBe(false);
  });
});
