import { describe, expect, it } from 'vitest';
import { resolveEventTime } from '../../src/model/event-time.js';

describe('resolveEventTime', () => {
  it('keeps a valid, explicit eventTime as given', () => {
    const result = resolveEventTime('2026-07-20T07:00:00+01:00', true, '2026-07-20T21:00:00+01:00');
    expect(result).toEqual({
      eventTime: '2026-07-20T07:00:00+01:00',
      eventEpochMs: Date.parse('2026-07-20T06:00:00Z'),
      eventTimeExplicit: true,
    });
  });

  it('keeps a valid, non-explicit eventTime as given', () => {
    const result = resolveEventTime('2026-07-20T21:00:00+01:00', false, '2026-07-20T21:00:00+01:00');
    expect(result.eventTimeExplicit).toBe(false);
  });

  it('falls back to the entry’s own written time for a malformed eventTime', () => {
    const result = resolveEventTime('not a timestamp', true, '2026-07-20T21:00:00+01:00');
    expect(result.eventTime).toBe('2026-07-20T21:00:00+01:00');
  });

  it('never trusts the model’s "explicit" claim once the time could not be parsed', () => {
    const result = resolveEventTime('not a timestamp', true, '2026-07-20T21:00:00+01:00');
    expect(result.eventTimeExplicit).toBe(false);
  });

  it('normalises to the canonical form even when the input parses', () => {
    // A lowercase 't' and 'z' are valid RFC 3339 but not the canonical shape.
    const result = resolveEventTime('2026-07-20t07:00:00z', true, '2026-07-20T21:00:00+01:00');
    expect(result.eventTime).toBe('2026-07-20T07:00:00Z');
  });
});
