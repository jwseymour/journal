'use client';

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import type { LayoutSummary, ResolvedLayout } from '@journal/contract';
import { ApiRequestError, importLegacyAnalysisPrefs, listLayouts, renderAnalysisLayout } from '@/lib/api';
import { LayoutControls } from '@/components/analysis/layout-controls';
import { ResolvedLayoutView } from '@/components/analysis/resolved-layout';
import styles from './page.module.css';

const WINDOW_PRESETS: { label: string; days: number }[] = [
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: '12mo', days: 366 },
  { label: 'All', days: 3650 },
];
const DEFAULT_WINDOW_DAYS = 30;

// ─────────────────────────────────────────────────────────────────────────
// The time window is a per-device lens, not part of the layout — the same
// kind of client-only preference the theme/chrome toggles keep in
// `localStorage`. Everything else about the page's arrangement lives in a
// server-resolved, durable layout (`requirements.md` §8, M20).
// ─────────────────────────────────────────────────────────────────────────

const PREFS_KEY = 'journal:analysis-prefs';
const PREFS_CHANGE_EVENT = 'journal:analysis-prefs-change';

interface Prefs {
  windowDays: number;
}

const DEFAULT_PREFS: Prefs = { windowDays: DEFAULT_WINDOW_DAYS };

function defaultPrefs(): Prefs {
  return DEFAULT_PREFS;
}

let cachedRaw: string | null = null;
let cachedPrefs: Prefs = DEFAULT_PREFS;

function readPrefs(): Prefs {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(PREFS_KEY);
  } catch {
    raw = null;
  }
  if (raw === cachedRaw) return cachedPrefs;
  cachedRaw = raw;
  try {
    const parsed = raw ? (JSON.parse(raw) as Partial<Prefs>) : null;
    const windowDays = typeof parsed?.windowDays === 'number' ? parsed.windowDays : DEFAULT_WINDOW_DAYS;
    cachedPrefs = windowDays === DEFAULT_WINDOW_DAYS ? DEFAULT_PREFS : { windowDays };
  } catch {
    cachedPrefs = DEFAULT_PREFS;
  }
  return cachedPrefs;
}

function subscribePrefs(callback: () => void): () => void {
  window.addEventListener('storage', callback);
  window.addEventListener(PREFS_CHANGE_EVENT, callback);
  return () => {
    window.removeEventListener('storage', callback);
    window.removeEventListener(PREFS_CHANGE_EVENT, callback);
  };
}

function usePrefs(): [Prefs, (updater: Prefs | ((prev: Prefs) => Prefs)) => void] {
  const prefs = useSyncExternalStore(subscribePrefs, readPrefs, defaultPrefs);

  const setPrefs = useCallback((updater: Prefs | ((prev: Prefs) => Prefs)) => {
    const current = readPrefs();
    const next = typeof updater === 'function' ? (updater as (p: Prefs) => Prefs)(current) : updater;
    try {
      window.localStorage.setItem(PREFS_KEY, JSON.stringify({ windowDays: next.windowDays }));
    } catch {
      // Same tolerance as the read above.
    }
    window.dispatchEvent(new Event(PREFS_CHANGE_EVENT));
  }, []);

  return [prefs, setPrefs];
}

/** The pre-M20 `setPrefs` always wrote the full object, default `order`
 * included, so a user who only ever touched the window control still has an
 * `order` key. Migration must fire only for a *meaningful* customization —
 * a reordering, a hidden panel, or a calendar-metric pick — never for a
 * blob that just mirrors the old defaults. */
const LEGACY_DEFAULT_ORDER: Record<string, string[]> = {
  rhythms: ['calendar', 'register', 'horizon', 'matrix'],
  tallies: ['breakdowns', 'reviews', 'distribution', 'spread'],
  threads: ['questions', 'todos', 'lists', 'concepts', 'aging'],
};

function orderIsCustomized(order: unknown): boolean {
  if (typeof order !== 'object' || order === null) return false;
  const record = order as Record<string, unknown>;
  for (const register of Object.keys(LEGACY_DEFAULT_ORDER)) {
    const value = record[register];
    if (Array.isArray(value) && JSON.stringify(value) !== JSON.stringify(LEGACY_DEFAULT_ORDER[register])) {
      return true;
    }
  }
  return false;
}

/**
 * The pre-M20 key could also hold `order` / `hidden` / `calendarMetrics` —
 * the client-only panel customization. On first load after M20, if any of
 * those carry a real customization, hand the whole blob to the API once: it
 * translates them into a durable "My layout" default server-side
 * (`layout/legacy-prefs.ts`). Then strip the key back to just `windowDays`.
 * Silent, no prompt (`design.md` §4). Returns the migrated default's id, or
 * `null` if there was nothing to migrate.
 */
async function migrateLegacyPrefs(): Promise<string | null> {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(PREFS_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed: { windowDays?: number; order?: unknown; hidden?: unknown[]; calendarMetrics?: unknown[] };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const hasLegacy =
    orderIsCustomized(parsed.order) ||
    (Array.isArray(parsed.hidden) && parsed.hidden.length > 0) ||
    (Array.isArray(parsed.calendarMetrics) && parsed.calendarMetrics.length > 0);
  if (!hasLegacy) return null;

  try {
    const layout = await importLegacyAnalysisPrefs(parsed);
    try {
      window.localStorage.setItem(PREFS_KEY, JSON.stringify({ windowDays: parsed.windowDays ?? DEFAULT_WINDOW_DAYS }));
      window.dispatchEvent(new Event(PREFS_CHANGE_EVENT));
    } catch {
      // Non-fatal — the migration itself succeeded.
    }
    return layout.id;
  } catch {
    return null; // A failed migration just leaves the built-in default in place.
  }
}

/**
 * The analysis surface (`plan.md` M8, M20, `design.md` §5.3). As of M20 the
 * page's whole arrangement comes from a durable layout resolved behind the
 * API: one `POST /analysis/render` returns every panel with its data already
 * aggregated (`requirements.md` §7.1). This component picks a layout and a
 * window, fetches, and hands the result to one renderer.
 */
export default function AnalysisPage() {
  const [prefs, setPrefs] = usePrefs();
  const [layout, setLayout] = useState<ResolvedLayout | null>(null);
  const [layouts, setLayouts] = useState<LayoutSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [customizing, setCustomizing] = useState(false);
  const [listVersion, setListVersion] = useState(0);
  const [ready, setReady] = useState(false);

  // One-shot legacy migration, then load the layout list.
  useEffect(() => {
    let live = true;
    migrateLegacyPrefs()
      .then((migratedId) =>
        listLayouts('analysis').then((response) => {
          if (!live) return;
          setLayouts(response.layouts);
          setSelectedId(migratedId ?? response.defaultId);
          setReady(true);
        }),
      )
      .catch(() => {
        if (live) setReady(true);
      });
    return () => {
      live = false;
    };
  }, []);

  const refreshLayouts = useCallback((next?: { selectId?: string | null }) => {
    listLayouts('analysis')
      .then((response) => {
        setLayouts(response.layouts);
        if (next && 'selectId' in next) setSelectedId(next.selectId ?? response.defaultId);
        setListVersion((v) => v + 1);
      })
      .catch(() => setListVersion((v) => v + 1));
  }, []);

  useEffect(() => {
    if (!ready) return;
    let live = true;
    renderAnalysisLayout({
      ...(selectedId ? { layoutId: selectedId } : {}),
      windowDays: prefs.windowDays,
    })
      .then((resolved) => {
        if (!live) return;
        setLayout(resolved);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (live) setError(cause instanceof ApiRequestError ? cause.message : 'Could not load analysis.');
      });
    return () => {
      live = false;
    };
  }, [ready, selectedId, prefs.windowDays, listVersion]);

  if (error) return <p className={styles.error}>{error}</p>;
  if (layout === null) return <p className={styles.hint}>Loading…</p>;

  return (
    <div className={styles.breakout}>
      <div className={styles.frame}>
        <div className={styles.controls}>
          <div className={styles.windowControl} role="group" aria-label="Time window">
            {WINDOW_PRESETS.map((preset) => (
              <button
                key={preset.label}
                type="button"
                className={prefs.windowDays === preset.days ? styles.windowButtonActive : styles.windowButton}
                onClick={() => setPrefs({ windowDays: preset.days })}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <button type="button" className={styles.customizeButton} onClick={() => setCustomizing((c) => !c)}>
            {customizing ? 'Done' : 'Customize'}
          </button>
        </div>

        {customizing && (
          <LayoutControls
            key={selectedId ?? 'builtin'}
            surface="analysis"
            layouts={layouts}
            selectedId={selectedId}
            currentSyntax={layout.syntax}
            onSelect={setSelectedId}
            onChanged={refreshLayouts}
          />
        )}

        <ResolvedLayoutView layout={layout} />

        <section className={styles.section}>
          <Link href="/categories" className={styles.seeAll}>
            Manage categories →
          </Link>
        </section>
      </div>
    </div>
  );
}
