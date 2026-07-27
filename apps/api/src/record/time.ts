/**
 * RFC 3339 timestamps, kept as text and never as a `Date`.
 *
 * `created` always carries its UTC offset, because a local time without one is
 * permanently ambiguous and this journal expects travel (`requirements.md`
 * §4.3). A JavaScript `Date` is an instant and cannot hold an offset, so
 * round-tripping through one silently destroys the very thing the field exists
 * to preserve. Everything here works on the string.
 *
 * Two different times are extracted, and confusing them is the main hazard:
 *
 * - the **wall clock** — the digits as written, which is what the filename and
 *   the year/month directories use (`requirements.md` §4.2);
 * - the **instant** — `epochMs`, which is what ordering uses, so that entries
 *   written either side of a timezone change still sort correctly.
 */

/** `T`/`t` separator, seconds required, offset required — `Z` or `±HH:MM`. */
const RFC_3339 =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:([Zz])|([+-])(\d{2}):(\d{2}))$/;

export interface Timestamp {
  /** The digits as written — local at the place of writing, not here. */
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  /** Minutes east of UTC. `Z` is 0. */
  readonly offsetMinutes: number;
  /** Whether the offset was written as `Z`, so it can be re-emitted that way. */
  readonly utcDesignator: boolean;
  /** The absolute instant. The only thing ordering may use. */
  readonly epochMs: number;
  /** Canonical `YYYY-MM-DDTHH:MM:SS±HH:MM`, exactly as it goes to disk. */
  readonly canonical: string;
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2 && isLeapYear(year)) return 29;
  return DAYS_IN_MONTH[month - 1] as number;
}

const pad = (n: number, width: number): string => String(n).padStart(width, '0');

/**
 * Parse an RFC 3339 timestamp, or return `null` if it is not one.
 *
 * Fractional seconds are accepted and then dropped: the field records when a
 * writing session began, where sub-second precision is noise, and `format.md`
 * §3 shows one canonical shape. A value of `60` seconds is accepted as a leap
 * second and folded to `59`, since no instant is lost by doing so.
 */
export function parseTimestamp(value: string): Timestamp | null {
  const match = RFC_3339.exec(value);
  if (!match) return null;

  const [, y, mo, d, h, mi, s, , zulu, sign, offH, offM] = match;

  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const rawSecond = Number(s);

  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || rawSecond > 60) return null;

  const second = rawSecond === 60 ? 59 : rawSecond;

  let offsetMinutes = 0;
  const utcDesignator = zulu !== undefined;
  if (!utcDesignator) {
    const oh = Number(offH);
    const om = Number(offM);
    // ±23:59 is the widest offset RFC 3339 permits.
    if (oh > 23 || om > 59) return null;
    offsetMinutes = (oh * 60 + om) * (sign === '-' ? -1 : 1);
  }

  // Built field by field rather than through `Date.UTC`, which reinterprets
  // two-digit years as 19xx and would quietly mangle a year before 0100.
  const instant = new Date(0);
  instant.setUTCFullYear(year, month - 1, day);
  instant.setUTCHours(hour, minute, second, 0);
  const epochMs = instant.getTime() - offsetMinutes * 60_000;
  if (!Number.isFinite(epochMs)) return null;

  const offsetText = utcDesignator
    ? 'Z'
    : `${offsetMinutes < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offsetMinutes) / 60), 2)}:${pad(
        Math.abs(offsetMinutes) % 60,
        2,
      )}`;

  const canonical =
    `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}` +
    `T${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)}${offsetText}`;

  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    offsetMinutes,
    utcDesignator,
    epochMs,
    canonical,
  };
}

/**
 * The current time in this machine's own offset.
 *
 * Only a fallback. `created` normally comes from the client, because only the
 * client knows where the user actually is — the backend must never assume it
 * shares a clock or a timezone with the writer, since one day it will not
 * (`requirements.md` §7.2). This keeps `curl` usable and nothing more.
 */
export function nowTimestamp(now: Date = new Date()): Timestamp {
  // `getTimezoneOffset` counts minutes *west* of UTC; RFC 3339 counts east.
  const offsetMinutes = -now.getTimezoneOffset();
  const local = new Date(now.getTime() + offsetMinutes * 60_000);
  const offsetText =
    `${offsetMinutes < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offsetMinutes) / 60), 2)}` +
    `:${pad(Math.abs(offsetMinutes) % 60, 2)}`;
  const canonical =
    `${pad(local.getUTCFullYear(), 4)}-${pad(local.getUTCMonth() + 1, 2)}-${pad(local.getUTCDate(), 2)}` +
    `T${pad(local.getUTCHours(), 2)}:${pad(local.getUTCMinutes(), 2)}:${pad(local.getUTCSeconds(), 2)}` +
    offsetText;

  const parsed = parseTimestamp(canonical);
  /* c8 ignore next */
  if (!parsed) throw new Error(`Produced an unparseable timestamp: ${canonical}`);
  return parsed;
}
