/**
 * Rendering timestamps, and reading this device's clock.
 *
 * Both are presentation and device state, which is why they are allowed here.
 * Neither is business logic: nothing in this file decides anything about
 * entries, and nothing behind the API depends on it (`design.md` §6.3).
 *
 * ## An entry is shown in its own local time, not the reader's
 *
 * `created` carries the offset of the place it was written. Handing that string
 * to `toLocaleString()` would render it in whatever timezone the *reader*
 * happens to be in — so an entry written at 22:55 in London would read as 17:55
 * to the same person sitting in New York a year later. That is wrong: local
 * time is how the writing is remembered (`requirements.md` §4.2).
 *
 * So the offset is applied by hand and the result formatted as if it were UTC.
 * Fixing both the locale and the timezone also means server and client render
 * identical strings, so there is no hydration mismatch to paper over.
 */

const OFFSET = /([+-])(\d{2}):(\d{2})$/;

const DATE = new Intl.DateTimeFormat('en-GB', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

const SHORT_DATE = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

const TIME = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'UTC',
});

/** Minutes east of UTC, read from the timestamp's own suffix. */
function offsetMinutes(created: string): number {
  if (created.endsWith('Z') || created.endsWith('z')) return 0;
  const match = OFFSET.exec(created);
  if (!match) return 0;
  return (Number(match[2]) * 60 + Number(match[3])) * (match[1] === '-' ? -1 : 1);
}

/**
 * The instant shifted so that formatting it as UTC reproduces the wall clock
 * that was written. Not a real instant — only ever passed to a UTC formatter.
 */
function wallClock(created: string): Date | null {
  const instant = new Date(created);
  if (Number.isNaN(instant.getTime())) return null;
  return new Date(instant.getTime() + offsetMinutes(created) * 60_000);
}

/** `Sunday, 26 July 2026 at 22:55` */
export function formatTimestamp(created: string): string {
  const at = wallClock(created);
  if (!at) return created;
  return `${DATE.format(at)} at ${TIME.format(at)}`;
}

/** `26 July 2026` — for a list, where the weekday is noise. */
export function formatDate(created: string): string {
  const at = wallClock(created);
  return at ? SHORT_DATE.format(at) : created;
}

/** `22:55` */
export function formatTime(created: string): string {
  const at = wallClock(created);
  return at ? TIME.format(at) : '';
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** `3` → `March`. A plain lookup — no `Intl` instantiation needed for a
 * month number the API already returns as a plain integer. */
export function monthName(month: number): string {
  return MONTH_NAMES[month - 1] ?? String(month);
}

/**
 * `★★★★☆` — a 1–5 rating as plain glyphs in the running type, not a
 * graphical widget. The print information-design treatment
 * (`design.md` §5.3) wants data integrated into the typography rather than
 * boxed off from it; a row of star characters in the same serif face is
 * exactly that, where a star-icon component would not be.
 */
export function formatRating(rating: number): string {
  const rounded = Math.round(rating);
  return '★'.repeat(rounded) + '☆'.repeat(Math.max(0, 5 - rounded));
}

/**
 * This device's clock as RFC 3339, carrying its offset.
 *
 * The client supplies `created` because only the client knows where the user
 * is; the backend must never assume it shares a timezone with the writer. The
 * value marks when the session *began* — the first keystroke — not when it was
 * saved (`format.md` §3, `requirements.md` §4.3).
 */
export function nowRfc3339(now: Date = new Date()): string {
  const minutes = -now.getTimezoneOffset();
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const pad = (value: number) => String(value).padStart(2, '0');

  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}
