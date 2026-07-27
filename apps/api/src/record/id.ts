import { randomBytes } from 'node:crypto';

/**
 * ULIDs — the entry's identity (`format.md` §3).
 *
 * Implemented here rather than taken from a package. It is forty lines of a
 * frozen, fully specified format, and this is a project meant to still build in
 * ten years; a dependency that can rot is a poor trade for that.
 *
 * A ULID is 26 characters of Crockford base32: 10 encoding a 48-bit millisecond
 * timestamp, then 16 encoding 80 bits of randomness. Lexical order therefore
 * follows time order, which is why it is worth preferring to a UUID here.
 */

/** Crockford base32 — no I, L, O or U, so it cannot spell anything or be misread. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;
export const ULID_LENGTH = TIME_CHARS + RANDOM_CHARS;

/** 2^48 - 1 ms — the year 10889. The format's own ceiling, not ours. */
const MAX_TIMESTAMP = 281_474_976_710_655;

function encodeTime(epochMs: number): string {
  if (!Number.isInteger(epochMs) || epochMs < 0 || epochMs > MAX_TIMESTAMP) {
    throw new RangeError(`Timestamp ${epochMs} is out of ULID range.`);
  }
  let remaining = epochMs;
  let out = '';
  for (let i = 0; i < TIME_CHARS; i += 1) {
    out = ALPHABET[remaining % 32] + out;
    remaining = Math.floor(remaining / 32);
  }
  return out;
}

/**
 * 80 bits of CSPRNG output as exactly 16 base32 characters.
 *
 * 80 divides by 5 with nothing left over, so every character is fully random
 * and none is partly padding.
 */
function encodeRandom(): string {
  const bytes = randomBytes(10);
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(buffer >>> bits) & 31];
    }
    buffer &= (1 << bits) - 1;
  }
  return out;
}

/**
 * A ULID whose timestamp is `epochMs`.
 *
 * The caller passes the entry's `created` instant rather than letting this read
 * the clock, so that ULID order and `created` order agree. That agreement is
 * what lets the list cursor use the id as its tiebreak and still be meaningful.
 */
export function ulid(epochMs: number): string {
  return encodeTime(epochMs) + encodeRandom();
}

/**
 * Whether a string is a well-formed ULID.
 *
 * The leading character is capped at '7' because ten base32 characters hold 50
 * bits while the timestamp is only 48 — the top two bits must be zero. Checking
 * it costs nothing and rejects a class of corrupted values that would otherwise
 * look plausible.
 */
export function isUlid(value: string): boolean {
  if (value.length !== ULID_LENGTH) return false;
  if (value.charCodeAt(0) > 0x37 /* '7' */) return false;
  for (let i = 0; i < value.length; i += 1) {
    if (!ALPHABET.includes(value[i] as string)) return false;
  }
  return true;
}
