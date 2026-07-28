'use client';

import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from 'react';

/**
 * Toggleable chrome (`design.md` §5.1, §5.2).
 *
 * "Hidden is a first-class state, not a special mode with reduced
 * capability" — so this is nothing but a boolean and a place to read it.
 * Anything that depends on chrome being visible would be the bug this exists
 * to prevent.
 *
 * Remembered in `localStorage`, the same way the theme is, and read the same
 * way — through `useSyncExternalStore` rather than an effect-driven
 * `setState`, which is the correct tool for external state and comes with
 * SSR-safe behaviour built in. See `theme.tsx` for the fuller explanation;
 * the two are deliberately parallel.
 */

const STORAGE_KEY = 'journal:chrome-hidden';
const LOCAL_CHANGE_EVENT = 'journal:chrome-change';

interface ChromeContextValue {
  hidden: boolean;
  toggle: () => void;
}

const ChromeContext = createContext<ChromeContextValue | null>(null);

function subscribe(callback: () => void): () => void {
  window.addEventListener('storage', callback);
  window.addEventListener(LOCAL_CHANGE_EVENT, callback);
  return () => {
    window.removeEventListener('storage', callback);
    window.removeEventListener(LOCAL_CHANGE_EVENT, callback);
  };
}

function getSnapshot(): boolean {
  return window.localStorage.getItem(STORAGE_KEY) === '1';
}

function getServerSnapshot(): boolean {
  return false;
}

export function ChromeProvider({ children }: { children: React.ReactNode }) {
  const hidden = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const toggle = useCallback(() => {
    const next = !getSnapshot();
    window.localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
    window.dispatchEvent(new Event(LOCAL_CHANGE_EVENT));
  }, []);

  const value = useMemo(() => ({ hidden, toggle }), [hidden, toggle]);

  return <ChromeContext.Provider value={value}>{children}</ChromeContext.Provider>;
}

export function useChrome(): ChromeContextValue {
  const value = useContext(ChromeContext);
  if (!value) throw new Error('useChrome must be used within a ChromeProvider.');
  return value;
}
