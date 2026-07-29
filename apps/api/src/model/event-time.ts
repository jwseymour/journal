import { parseTimestamp } from '../record/time.js';

export interface ResolvedEventTime {
  eventTime: string;
  eventEpochMs: number;
  eventTimeExplicit: boolean;
}

/**
 * Shared by every extraction pipeline — temporal metrics (`plan.md` M7),
 * reviews, and lists of atomic items (M8) all ask the model to resolve when
 * something actually happened, distinct from when the entry was written
 * (`requirements.md` §6.3), and all three need the identical safety net:
 * the model is asked to always return a valid, offset-carrying RFC 3339
 * string, but nothing from outside this process is trusted blindly. A
 * malformed `eventTime` falls back to the entry's own written time rather
 * than corrupting the record or failing the whole extraction — and the
 * model's own claim of "explicit" is not trusted once its time could not be
 * parsed, since silently falling back while still calling it explicit would
 * misrepresent where the timestamp actually came from.
 */
export function resolveEventTime(
  rawEventTime: string,
  rawExplicit: boolean,
  entryCreated: string,
): ResolvedEventTime {
  const parsed = parseTimestamp(rawEventTime);
  if (parsed) {
    return { eventTime: parsed.canonical, eventEpochMs: parsed.epochMs, eventTimeExplicit: rawExplicit };
  }
  const fallback = parseTimestamp(entryCreated);
  return {
    eventTime: entryCreated,
    eventEpochMs: fallback?.epochMs ?? Date.now(),
    eventTimeExplicit: false,
  };
}
