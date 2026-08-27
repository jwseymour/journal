/** `26 July 2026` — the only date shape this app ever shows; there is no
 * clock-time or "time ago" anywhere, since nothing here is about when it
 * was written, only what it says (`requirements.md` §10). */
export function formatDate(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(iso),
  );
}
