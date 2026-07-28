import type { Coordinates } from '@journal/contract';

/**
 * Silent location capture (`requirements.md` §4.3, `design.md` §5.1).
 *
 * Zero interface footprint of our own: no explanatory dialog, no button, no
 * mention anywhere in our UI. The browser's own native permission prompt is
 * outside our control and outside what "interface footprint" means here — we
 * simply never add anything of ours around it.
 *
 * Called once, as early as possible — on mount, well before the first
 * keystroke a human can physically manage — so that by the time an entry is
 * actually created, the result has very likely already settled one way or the
 * other. It never blocks a save: callers race this against a bounded timeout
 * and use whatever they have when the moment comes, absent or not.
 */
export function captureLocationOnce(timeoutMs = 4000): Promise<Coordinates | undefined> {
  return new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      resolve(undefined);
      return;
    }

    let settled = false;
    const settle = (value: Coordinates | undefined) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    navigator.geolocation.getCurrentPosition(
      (position) => settle({ lat: position.coords.latitude, lon: position.coords.longitude }),
      // Denied, unavailable, or any other failure — absent, never surfaced,
      // never retried mid-session (`requirements.md` §4.3: "If it cannot be
      // determined automatically it is simply absent").
      () => settle(undefined),
      { enableHighAccuracy: false, timeout: timeoutMs, maximumAge: 5 * 60_000 },
    );

    // Belt and braces beyond the geolocation API's own `timeout` option —
    // this promise must resolve regardless of what the browser does.
    setTimeout(() => settle(undefined), timeoutMs + 250);
  });
}
