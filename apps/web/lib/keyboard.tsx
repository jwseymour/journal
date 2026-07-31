'use client';

import { createContext, useCallback, useContext, useEffect, useRef } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useChrome } from './chrome';
import { usePalette } from './palette';
import { useReferencePane } from './reference-pane';
import { useTheme } from './theme';

/**
 * The scheme's mechanism (`design.md` §5.2).
 *
 * > ⌘ combos are only for what must work while your hands are in the text.
 * > Everything else is a plain key, live only when focus is outside a text
 * > field.
 *
 * That single rule is the whole design of this file:
 *
 * - **The app-chrome ⌘ combos** — `⌘K`, `⌘\`, `⌘⇧\` — are handled here,
 *   globally, and fire regardless of focus. They are not text-editing
 *   operations, so nothing about "hands in the text" excludes them; they are
 *   exactly the ones a textarea's own `onKeyDown` cannot own without
 *   swallowing them from every other surface.
 * - **The text-editing ⌘ combos** — `⌘S`, `⌘↩`, `⌘⇧P`, `⌘B`, `⌘I` — belong to
 *   the composer's own `onKeyDown`, not here, because "must work while your
 *   hands are in the text" is most directly satisfied by binding them exactly
 *   where the text is.
 * - **The plain-key scheme** — `n`, `/`, `j`, `k`, `↩`, `e`, `t`, `?`, `Esc`,
 *   and the `g` chord — only fires with focus outside a text field, checked
 *   on every keystroke rather than assumed.
 *
 * Some of these are fixed, page-independent actions (navigate, toggle theme)
 * and are handled directly below. Others depend on what is currently
 * mounted — `j`/`k`/`↩` only mean something on the list, `e` only on an open
 * entry — and are reached through `useGlobalKey`, a small per-key
 * registration so a page can claim a binding only while it is relevant.
 */

type KeyHandler = () => void;

interface KeyboardContextValue {
  registerKey: (key: string, handler: KeyHandler) => () => void;
}

const KeyboardContext = createContext<KeyboardContextValue | null>(null);

function isTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'TEXTAREA' || tag === 'INPUT' || target.isContentEditable;
}

const CHORD_WINDOW_MS = 900;

export function KeyboardProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { toggle: toggleTheme } = useTheme();
  const { toggle: toggleChrome } = useChrome();
  const { toggle: toggleReferencePane } = useReferencePane();
  const { overlay, openPalette, openSheet, close: closeOverlay } = usePalette();

  const registry = useRef(new Map<string, KeyHandler>());
  const chordArmed = useRef(false);
  const chordTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Refs mirroring frequently-changing values the listener closes over, so
  // the single `keydown` listener below can be attached once rather than
  // re-attached on every render. Written in an effect, not during render —
  // a render can be thrown away and re-run under React, and a ref mutation
  // has to happen only as a committed effect of that render actually landing.
  const pathRef = useRef(pathname);
  useEffect(() => {
    pathRef.current = pathname;
  }, [pathname]);

  const overlayRef = useRef(overlay);
  useEffect(() => {
    overlayRef.current = overlay;
  }, [overlay]);

  const registerKey = useCallback((key: string, handler: KeyHandler) => {
    registry.current.set(key, handler);
    return () => {
      // Only clear if this registration is still the current one — a page
      // unmounting after a newer page has already claimed the same key must
      // not clobber the newer registration.
      if (registry.current.get(key) === handler) registry.current.delete(key);
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const withMeta = event.metaKey || event.ctrlKey;

      // The app-chrome ⌘ combos: fire regardless of focus.
      if (withMeta && !event.altKey && event.key.toLowerCase() === 'k' && !event.shiftKey) {
        event.preventDefault();
        openPalette();
        return;
      }
      // `event.code`, not `event.key`: Shift+Backslash reports `key: '|'` on a
      // US layout — the character changes, but the physical key does not,
      // and `code` is what stays stable across that distinction (verified
      // live: Playwright confirmed exactly this key/code split).
      if (withMeta && event.code === 'Backslash') {
        event.preventDefault();
        if (event.shiftKey) toggleReferencePane();
        else toggleChrome();
        return;
      }

      // Everything past here is the plain-key scheme: outside a text field
      // only, and not while an overlay already owns the keyboard (the
      // overlay handles its own Escape and typing).
      if (withMeta || event.altKey) return;
      if (overlayRef.current) return;
      if (isTextField(event.target)) return;

      // The `g` chord: a bare `g`, then one more key within a short window.
      if (chordArmed.current) {
        chordArmed.current = false;
        if (chordTimer.current) clearTimeout(chordTimer.current);
        const key = event.key.toLowerCase();
        if (key === 'h') {
          event.preventDefault();
          router.push('/entry/new');
        } else if (key === 'e') {
          event.preventDefault();
          router.push('/');
        } else if (key === 's') {
          event.preventDefault();
          router.push('/search');
        } else if (key === 'a') {
          event.preventDefault();
          router.push('/analysis');
        } else if (key === 'c') {
          event.preventDefault();
          router.push('/chat');
        }
        return;
      }

      if (event.key === 'g') {
        chordArmed.current = true;
        chordTimer.current = setTimeout(() => {
          chordArmed.current = false;
        }, CHORD_WINDOW_MS);
        return;
      }

      if (event.key === '?') {
        event.preventDefault();
        openSheet();
        return;
      }

      if (event.key === 'Escape') {
        if (pathRef.current.startsWith('/entry/')) {
          event.preventDefault();
          router.push('/');
        }
        return;
      }

      if (event.key === 't') {
        toggleTheme();
        return;
      }

      if (event.key === 'n') {
        router.push('/entry/new');
        return;
      }

      if (event.key === '/') {
        event.preventDefault();
        router.push('/search');
        return;
      }

      // Page-specific: whatever is currently mounted and registered.
      const handler = registry.current.get(event.key);
      if (handler) {
        event.preventDefault();
        handler();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // Deliberately stable across renders — the handler reads current values
    // through refs and the stable context setters above, not closed-over
    // props, so it does not need to be re-attached.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The overlay owns Escape while it is open.
  useEffect(() => {
    if (!overlay) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeOverlay();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [overlay, closeOverlay]);

  return (
    <KeyboardContext.Provider value={{ registerKey }}>{children}</KeyboardContext.Provider>
  );
}

/**
 * Claim a plain, outside-text-field key while the calling component is
 * mounted and `enabled`. Registration is per key, last-mounted-wins, and
 * cleaned up automatically — a page never has to remember to release a key it
 * no longer means anything on.
 */
export function useGlobalKey(key: string, handler: KeyHandler, enabled = true): void {
  const context = useContext(KeyboardContext);
  if (!context) throw new Error('useGlobalKey must be used within a KeyboardProvider.');

  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useEffect(() => {
    if (!enabled) return;
    return context.registerKey(key, () => handlerRef.current());
  }, [context, key, enabled]);
}
