'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useChrome } from '@/lib/chrome';
import { COMMANDS } from '@/lib/commands';
import { usePalette } from '@/lib/palette';
import { useReferencePane } from '@/lib/reference-pane';
import { useTheme } from '@/lib/theme';
import styles from './command-palette.module.css';

/**
 * `⌘K` — command palette, and search (`design.md` §5.2).
 *
 * Search itself is M6; until then this is a command launcher that also
 * documents the rest of the scheme. Every command from `lib/commands.ts`
 * appears, filterable by typing — a command with a global action executes on
 * selection, and one that only means something while writing, or that has no
 * feature behind it yet, shows a short note instead of pretending to do
 * something.
 */

/** Global actions the palette itself can execute — everything else is informational. */
function useExecutableActions(): Record<string, () => void> {
  const router = useRouter();
  const { toggle: toggleTheme } = useTheme();
  const { toggle: toggleChrome } = useChrome();
  const { toggle: toggleReferencePane } = useReferencePane();
  const { openSheet } = usePalette();

  return useMemo(
    () => ({
      'new-entry': () => router.push('/entry/new'),
      'go-writing': () => router.push('/entry/new'),
      'go-entries': () => router.push('/'),
      'go-documents': () => router.push('/documents'),
      'go-pending': () => router.push('/pending'),
      'go-chat': () => router.push('/chat'),
      'toggle-theme': () => toggleTheme(),
      'toggle-chrome': () => toggleChrome(),
      'toggle-reference': () => toggleReferencePane(),
      shortcuts: () => openSheet(),
    }),
    [router, toggleTheme, toggleChrome, toggleReferencePane, openSheet],
  );
}

/**
 * Mounted only while open, so every opening starts with genuinely fresh
 * state by construction — no effect has to reset it, because there is
 * nothing left over from last time to reset.
 */
function CommandPaletteContent({ close }: { close: () => void }) {
  const actions = useExecutableActions();
  const [query, setQuery] = useState('');
  const [highlighted, setHighlighted] = useState(0);
  const [prevQuery, setPrevQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState<string | null>(null);

  const results = useMemo(() => {
    const list = COMMANDS.filter((c) => c.id !== 'palette');
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter((c) => c.label.toLowerCase().includes(q) || c.keys.toLowerCase().includes(q));
  }, [query]);

  // The sanctioned alternative to an effect for "reset derived state when an
  // input changes": compare against the previous value during render and
  // adjust immediately, rather than committing a stale render first and
  // fixing it up afterwards.
  if (query !== prevQuery) {
    setPrevQuery(query);
    setHighlighted(0);
  }

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const activate = (id: string) => {
    const action = actions[id];
    if (action) {
      action();
      close();
      return;
    }
    const spec = COMMANDS.find((c) => c.id === id);
    setNote(
      spec?.available
        ? 'This is used while writing — its shortcut works from the composer.'
        : 'Not built yet.',
    );
  };

  return (
    <div className={styles.backdrop} role="presentation" onMouseDown={close}>
      <div
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <input
          ref={inputRef}
          className={styles.input}
          type="text"
          placeholder="Type a command…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setHighlighted((i) => Math.min(i + 1, results.length - 1));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setHighlighted((i) => Math.max(i - 1, 0));
            } else if (event.key === 'Enter') {
              event.preventDefault();
              const target = results[highlighted];
              if (target) activate(target.id);
            }
          }}
        />
        <ul className={styles.list} role="listbox">
          {results.length === 0 && <li className={styles.empty}>No matching command.</li>}
          {results.map((command, index) => (
            <li key={command.id}>
              <button
                type="button"
                className={index === highlighted ? `${styles.item} ${styles.highlighted}` : styles.item}
                onMouseEnter={() => setHighlighted(index)}
                onClick={() => activate(command.id)}
              >
                <span className={command.available ? styles.label : `${styles.label} ${styles.unavailable}`}>
                  {command.label}
                </span>
                <kbd className={styles.keys}>{command.keys}</kbd>
              </button>
            </li>
          ))}
        </ul>
        {note && <p className={styles.note}>{note}</p>}
      </div>
    </div>
  );
}

export function CommandPalette() {
  const { overlay, close } = usePalette();
  if (overlay !== 'palette') return null;
  return <CommandPaletteContent close={close} />;
}
