'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useSyncExternalStore } from 'react';

/**
 * Day and night (`design.md` §2.2, §5.2).
 *
 * The token set already carries both palettes via `light-dark()` in
 * `tokens.css`, keyed off `color-scheme`. This is purely the mechanism for
 * overriding the OS preference: setting `data-theme` on `<html>` is what
 * `tokens.css`'s `:root[data-theme='day'|'night']` rules are waiting for.
 *
 * The choice is remembered in `localStorage` — not a server preference, not
 * account state, just this browser's own setting, in keeping with everything
 * else about this frontend being disposable and local
 * (`requirements.md` §7.2).
 *
 * Read through `useSyncExternalStore` rather than an effect-driven
 * `setState` on mount: `localStorage` is external state, which is exactly
 * what that hook exists for, and it comes with the SSR-safe behaviour for
 * free — the server snapshot is used for the first client render (matching
 * what was actually sent down the wire), then the real client value takes
 * over immediately after.
 */

export type Theme = 'day' | 'night';

const STORAGE_KEY = 'journal:theme';
/** Fired after a same-tab write, since the native `storage` event only reaches other tabs. */
const LOCAL_CHANGE_EVENT = 'journal:theme-change';

interface ThemeContextValue {
  theme: Theme;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function subscribe(callback: () => void): () => void {
  window.addEventListener('storage', callback);
  window.addEventListener(LOCAL_CHANGE_EVENT, callback);
  return () => {
    window.removeEventListener('storage', callback);
    window.removeEventListener(LOCAL_CHANGE_EVENT, callback);
  };
}

function getSnapshot(): Theme {
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === 'day' || stored === 'night') return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'night' : 'day';
}

/** The server has no notion of this browser's preference; `day` is the printed page's own default. */
function getServerSnapshot(): Theme {
  return 'day';
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const toggle = useCallback(() => {
    const next: Theme = getSnapshot() === 'day' ? 'night' : 'day';
    window.localStorage.setItem(STORAGE_KEY, next);
    window.dispatchEvent(new Event(LOCAL_CHANGE_EVENT));
  }, []);

  const value = useMemo(() => ({ theme, toggle }), [theme, toggle]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme must be used within a ThemeProvider.');
  return value;
}
