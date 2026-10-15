/**
 * `26 July 2026` from an RFC 3339 timestamp, in the timestamp's *own* local
 * time — a byte-for-byte port of `apps/web/lib/format.ts`'s `formatDate`, so
 * that the panels `LayoutExecutor` assembles read exactly as the pre-M20
 * analysis page did.
 *
 * The offset is applied by hand and the result formatted as UTC, so a review
 * "Seen" date stays the date it was written against regardless of where the
 * server or a later reader sits (`requirements.md` §4.2). Formatting only —
 * it decides nothing, the same reason `format.ts` is allowed on the frontend.
 */
const OFFSET = /([+-])(\d{2}):(\d{2})$/;

const SHORT_DATE = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

function offsetMinutes(created: string): number {
  if (created.endsWith('Z') || created.endsWith('z')) return 0;
  const match = OFFSET.exec(created);
  if (!match) return 0;
  return (Number(match[2]) * 60 + Number(match[3])) * (match[1] === '-' ? -1 : 1);
}

export function formatEventDate(timestamp: string): string {
  const instant = new Date(timestamp);
  if (Number.isNaN(instant.getTime())) return timestamp;
  const wall = new Date(instant.getTime() + offsetMinutes(timestamp) * 60_000);
  return SHORT_DATE.format(wall);
}
