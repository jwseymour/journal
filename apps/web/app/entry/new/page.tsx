'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Coordinates } from '@journal/contract';
import { Composer } from '@/components/composer';
import { ApiRequestError, createEntry, updateEntry } from '@/lib/api';
import { nowRfc3339 } from '@/lib/format';
import { captureLocationOnce } from '@/lib/location';
import styles from './page.module.css';

/**
 * The writing surface — the draft lifecycle in full (`plan.md` M2,
 * `format.md` §5).
 *
 * The full keyboard scheme, rendered markdown, the reference pane and
 * toggleable chrome are M3. What belongs here is everything that protects the
 * writing itself:
 *
 * - **`created` is the first keystroke**, always — set the instant typing
 *   starts, regardless of when the file underneath actually appears.
 * - **The file is written once real content exists, then autosaved from
 *   there.** `format.md` §5 says a file is created on literally the first
 *   keystroke, even a stray space; this waits for the first non-whitespace
 *   character instead, so `POST /entries` is never asked to write a blank
 *   entry (`store/entry-store.ts`'s `create` refuses that, deliberately, for
 *   every caller including plain `curl`). The `created` timestamp still
 *   records the true first-keystroke instant, so nothing temporal is lost —
 *   only *when the file materialises* is deferred, which is a strictly safer
 *   version of "declining to commit an entry that was never written," not a
 *   looser one: a session that only ever produced whitespace now leaves
 *   nothing on disk at all, rather than a file that has to be cleaned up.
 * - **Autosave is debounced, with a periodic safety flush regardless.**
 * - **A write conflict is surfaced plainly and stops autosave.** Nothing here
 *   builds a merge UI — there is no version history to reconcile against
 *   (`requirements.md` §4.4) — so the honest thing is to say so and preserve
 *   exactly what the user has typed, untouched.
 * - **A failed save never clears the text.** The one thing this surface must
 *   never do is lose what was typed.
 * - **Ending the session while still blank discards the draft**, per
 *   `format.md` §5's one narrow deletion — never anything with real content.
 *
 * There is no placeholder. A prompt in an empty journal page would be a
 * writing prompt, and those are prohibited (`design.md` §4).
 */

const AUTOSAVE_DEBOUNCE_MS = 1500;
const AUTOSAVE_SAFETY_INTERVAL_MS = 8000;

export default function NewEntryPage() {
  const router = useRouter();
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [finishing, setFinishing] = useState(false);

  // Mutable, read-after-write state for the save loop. React state is the
  // wrong tool here: the loop needs the true latest body synchronously,
  // mid-flight save or not, which `useState` cannot offer without a stale
  // closure — so the source of truth for saving is these refs, and the
  // `body` state above exists purely to render the textarea.
  const bodyRef = useRef('');
  const entryIdRef = useRef<string | null>(null);
  const savedHashRef = useRef<string | null>(null);
  const savingRef = useRef(false);
  const pendingRef = useRef(false);
  const conflictRef = useRef(false);
  const startedAtRef = useRef<string | null>(null);
  const locationRef = useRef<Coordinates | undefined>(undefined);
  /** Set once the session has been deliberately ended, so nothing else races it. */
  const endedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void captureLocationOnce().then((location) => {
      if (!cancelled) locationRef.current = location;
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * The save loop. Serialises every write through one path: if a save is
   * already in flight when another is requested, that request is remembered
   * and re-run the instant the current one finishes — so a burst of keystrokes
   * during a slow save never launches two overlapping writes, and never loses
   * whatever was typed most recently either.
   */
  const flush = useCallback(async () => {
    if (conflictRef.current) return; // Stopped until the user reloads; see below.
    if (savingRef.current) {
      pendingRef.current = true;
      return;
    }

    savingRef.current = true;
    try {
      // A loop, not recursion — a burst of keystrokes during a slow save
      // marks `pendingRef` rather than launching a second overlapping write,
      // and this keeps saving until nothing newer is waiting.
      for (;;) {
        pendingRef.current = false;
        const toSave = bodyRef.current;

        if (entryIdRef.current === null && toSave.trim().length === 0) {
          break; // Nothing written yet — nothing to save.
        }

        try {
          if (entryIdRef.current === null) {
            const created = await createEntry({
              body: toSave,
              created: startedAtRef.current ?? nowRfc3339(),
              ...(locationRef.current ? { location: locationRef.current } : {}),
            });
            entryIdRef.current = created.id;
            savedHashRef.current = created.contentHash;
          } else {
            const updated = await updateEntry(entryIdRef.current, {
              body: toSave,
              contentHash: savedHashRef.current as string,
            });
            savedHashRef.current = updated.contentHash;
          }
          setError(null);
        } catch (cause) {
          if (cause instanceof ApiRequestError && cause.code === 'edit_conflict') {
            // Something else changed this entry — most likely a hand-edit in
            // a text editor, since nothing else in this session could know
            // its id yet. There is no merge UI to offer, so autosave stops
            // here and the text stays exactly as typed.
            conflictRef.current = true;
            setConflict(true);
          } else {
            setError(cause instanceof ApiRequestError ? cause.message : 'Could not save.');
          }
          break;
        }

        if (!pendingRef.current) break;
      }
    } finally {
      savingRef.current = false;
    }
  }, []);

  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleSave = useCallback(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => void flush(), AUTOSAVE_DEBOUNCE_MS);
  }, [flush]);

  // A safety net independent of the debounce, so continuous uninterrupted
  // typing still lands on disk regularly rather than waiting for a pause.
  useEffect(() => {
    const interval = setInterval(() => void flush(), AUTOSAVE_SAFETY_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [flush]);

  const hasWriting = body.trim().length > 0;

  const onChange = (value: string) => {
    startedAtRef.current ??= nowRfc3339();
    bodyRef.current = value;
    setBody(value);
    if (!conflictRef.current) scheduleSave();
  };

  /**
   * Discard the draft if it never amounted to anything, on the way out.
   *
   * There are three different moments that can end a session — an in-app SPA
   * navigation, `pagehide`, and `beforeunload` (see the effects below for why
   * all three). Each calls this same function rather than doing its own
   * thing, and every request it sends carries `keepalive: true`: a plain
   * `fetch` looks safe from an SPA unmount in isolation, but nothing
   * guarantees *how* the session actually ended, and a request that dies
   * silently on a hard navigation is exactly the bug `keepalive` exists to
   * prevent. Bypasses `lib/api.ts`'s wrapper for the one property it doesn't
   * expose — otherwise this is exactly `updateEntry` followed by `discardEntry`.
   *
   * **The server's copy is brought to "blank" before the delete is attempted,
   * not assumed to already be there.** `discardIfBlank` on the backend checks
   * what is actually on disk, and cancelling the pending debounce just above
   * means the disk copy can easily still hold the last real content — a
   * delete attempted against that is correctly refused. So this does the two
   * steps that were previously left implicit: sync blank, then remove.
   */
  const discardIfBlankOnExit = useCallback(() => {
    if (endedRef.current || conflictRef.current) return;
    endedRef.current = true;
    if (debounceTimer.current) clearTimeout(debounceTimer.current);

    const id = entryIdRef.current;
    const hash = savedHashRef.current;
    if (!id || !hash || bodyRef.current.trim().length !== 0) return;

    const base = process.env.NEXT_PUBLIC_API_URL ?? 'http://127.0.0.1:4319';
    void (async () => {
      await fetch(`${base}/entries/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: '', contentHash: hash }),
        keepalive: true,
      }).catch(() => {});
      await fetch(`${base}/entries/${id}`, { method: 'DELETE', keepalive: true }).catch(() => {});
    })();
  }, []);

  const finish = useCallback(async () => {
    if (finishing || !hasWriting || conflictRef.current) return;
    setFinishing(true);
    await flush();
    if (conflictRef.current) {
      setFinishing(false);
      return;
    }
    if (entryIdRef.current) {
      endedRef.current = true;
      router.push(`/entry/${entryIdRef.current}`);
    } else {
      setFinishing(false);
    }
  }, [finishing, flush, hasWriting, router]);

  // Three different ways a session can end, all calling the same function —
  // see its own comment for why that matters:
  //
  // - an in-app SPA navigation (React unmounts this component);
  // - `pagehide`, the standard event for tab close and hard navigation;
  // - `beforeunload` as well, purely for reliability — verified live that
  //   headless Chromium does not always fire `pagehide` for a plain
  //   navigation, while `beforeunload` fired every time. Registering both
  //   costs nothing (`discardIfBlankOnExit` is idempotent) and closes a gap a
  //   single event cannot be trusted to cover across engines.
  useEffect(() => {
    return () => discardIfBlankOnExit();
  }, [discardIfBlankOnExit]);

  useEffect(() => {
    window.addEventListener('pagehide', discardIfBlankOnExit);
    window.addEventListener('beforeunload', discardIfBlankOnExit);
    return () => {
      window.removeEventListener('pagehide', discardIfBlankOnExit);
      window.removeEventListener('beforeunload', discardIfBlankOnExit);
    };
  }, [discardIfBlankOnExit]);

  useEffect(() => {
    if (!hasWriting || conflict) return;
    const guard = (event: BeforeUnloadEvent) => {
      // Autosave means there is rarely truly-unsaved text, but this remains a
      // plain, honest guard for the moment right after a keystroke and before
      // the debounce has fired.
      if (pendingRef.current || savingRef.current) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [hasWriting, conflict]);

  return (
    <div className={styles.composer}>
      {conflict && (
        <p className={styles.conflict} role="alert">
          This entry changed outside the app while you were writing — most likely edited
          elsewhere. Nothing has been overwritten and nothing further is being saved. Copy
          anything below you want to keep, then reload.
        </p>
      )}
      <Composer
        value={body}
        onChange={onChange}
        onSave={() => void flush()}
        onFinish={() => void finish()}
        disabled={conflict}
        autoFocus
        ariaLabel="Entry"
      />

      <footer className={styles.footer}>
        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : (
          <span />
        )}
        <div className={styles.actions}>
          <kbd className={styles.hint}>⌘⇧P preview</kbd>
          <kbd className={styles.hint}>⌘S save</kbd>
          <kbd className={styles.hint}>⌘↩ finish</kbd>
          <button
            type="button"
            className={styles.finish}
            onClick={() => void finish()}
            disabled={!hasWriting || finishing || conflict}
          >
            {finishing ? 'Saving' : 'Finish'}
          </button>
        </div>
      </footer>
    </div>
  );
}
