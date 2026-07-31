'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { EntryPeriod, EntrySummary } from '@journal/contract';
import { useGlobalKey } from '@/lib/keyboard';
import { listEntries } from '@/lib/api';
import {
  PeriodTree,
  entryKey,
  groupPeriodsByYear,
  monthKey,
  yearKey,
  type MonthState,
} from './period-tree';
import { RecentEntries } from './recent-entries';
import styles from './page.module.css';

const MONTH_PAGE_SIZE = 30;

interface FlatRow {
  key: string;
  kind: 'entry' | 'year' | 'month';
}

/**
 * Owns everything the home page's browsing surface needs to share across
 * `recent-entries.tsx` and `period-tree.tsx`: which years/months are open,
 * each open month's fetched entries, and the one keyboard/mouse selection
 * that runs across both, extended over a taller, richer list than the old
 * flat entry list this replaces.
 *
 * `GET /entries/periods` (fetched once by `page.tsx`, passed down as
 * `periods`) is cheap even for a large corpus, so expanding a Year is a pure
 * client-side filter with no network request; expanding a Month is the only
 * thing that fetches, and its result is cached here for as long as the
 * browser is mounted so re-collapsing/re-expanding is free.
 */
export function HomeBrowser({
  recentEntries,
  periods,
}: {
  recentEntries: EntrySummary[];
  periods: EntryPeriod[];
}) {
  const router = useRouter();

  const [openYears, setOpenYears] = useState<Set<number>>(new Set());
  const [openMonths, setOpenMonths] = useState<Set<string>>(new Set());
  const [monthEntries, setMonthEntries] = useState<Map<string, MonthState>>(new Map());
  const [selected, setSelected] = useState(-1);

  // Mirrors of the state above, read synchronously from callbacks that must
  // not themselves trigger a render (deciding whether to fetch, finding a
  // cursor) — kept separate from the state itself so those reads never race
  // a setState that has not yet committed.
  const openMonthsRef = useRef(openMonths);
  useEffect(() => {
    openMonthsRef.current = openMonths;
  }, [openMonths]);

  const monthEntriesRef = useRef(monthEntries);
  useEffect(() => {
    monthEntriesRef.current = monthEntries;
  }, [monthEntries]);

  // Which month keys have ever been requested — guards against a month
  // being fetched twice (e.g. the auto-expand-previous path and a manual
  // click racing each other).
  const requestedRef = useRef(new Set<string>());

  const rowRefs = useRef(new Map<string, HTMLElement>());
  const registerRef = useCallback(
    (key: string) => (el: HTMLElement | null) => {
      if (el) rowRefs.current.set(key, el);
      else rowRefs.current.delete(key);
    },
    [],
  );

  const ensureLoaded = useCallback((year: number, month: number) => {
    const key = `${year}-${month}`;
    if (requestedRef.current.has(key)) return;
    requestedRef.current.add(key);

    setMonthEntries((prev) => {
      const next = new Map(prev);
      next.set(key, { entries: [], nextCursor: null, loading: true });
      return next;
    });

    listEntries({ year, month, limit: MONTH_PAGE_SIZE })
      .then((page) => {
        setMonthEntries((prev) => {
          const next = new Map(prev);
          next.set(key, { entries: page.entries, nextCursor: page.nextCursor, loading: false });
          return next;
        });
      })
      .catch(() => {
        requestedRef.current.delete(key);
        setMonthEntries((prev) => {
          const next = new Map(prev);
          next.set(key, { entries: [], nextCursor: null, loading: false });
          return next;
        });
      });
  }, []);

  const loadMore = useCallback((year: number, month: number) => {
    const key = `${year}-${month}`;
    const state = monthEntriesRef.current.get(key);
    if (!state || state.loading || !state.nextCursor) return;

    setMonthEntries((prev) => {
      const cur = prev.get(key);
      if (!cur) return prev;
      const next = new Map(prev);
      next.set(key, { ...cur, loading: true });
      return next;
    });

    listEntries({ year, month, limit: MONTH_PAGE_SIZE, cursor: state.nextCursor })
      .then((page) => {
        setMonthEntries((prev) => {
          const cur = prev.get(key);
          if (!cur) return prev;
          const next = new Map(prev);
          next.set(key, {
            entries: [...cur.entries, ...page.entries],
            nextCursor: page.nextCursor,
            loading: false,
          });
          return next;
        });
      })
      .catch(() => {
        setMonthEntries((prev) => {
          const cur = prev.get(key);
          if (!cur) return prev;
          const next = new Map(prev);
          next.set(key, { ...cur, loading: false });
          return next;
        });
      });
  }, []);

  const openYear = useCallback((year: number) => {
    setOpenYears((prev) => (prev.has(year) ? prev : new Set(prev).add(year)));
  }, []);

  const toggleYear = useCallback((year: number) => {
    setOpenYears((prev) => {
      const next = new Set(prev);
      if (next.has(year)) next.delete(year);
      else next.add(year);
      return next;
    });
  }, []);

  const openMonth = useCallback(
    (year: number, month: number) => {
      const key = `${year}-${month}`;
      if (openMonthsRef.current.has(key)) return;
      setOpenMonths((prev) => new Set(prev).add(key));
      ensureLoaded(year, month);
    },
    [ensureLoaded],
  );

  const toggleMonth = useCallback(
    (year: number, month: number) => {
      const key = `${year}-${month}`;
      if (openMonthsRef.current.has(key)) {
        setOpenMonths((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      } else {
        setOpenMonths((prev) => new Set(prev).add(key));
        ensureLoaded(year, month);
      }
    },
    [ensureLoaded],
  );

  // Scrolling to the bottom of an open month either loads more of the same
  // month, or — once it is exhausted — opens the chronologically previous
  // one, so browsing feels continuous rather than stopping at a wall.
  const onSentinel = useCallback(
    (year: number, month: number) => {
      const key = `${year}-${month}`;
      const state = monthEntriesRef.current.get(key);
      if (!state) return;

      if (state.nextCursor) {
        loadMore(year, month);
        return;
      }

      const idx = periods.findIndex((p) => p.year === year && p.month === month);
      const prevPeriod = idx >= 0 ? periods[idx + 1] : undefined;
      if (!prevPeriod) return;

      openYear(prevPeriod.year);
      openMonth(prevPeriod.year, prevPeriod.month);
    },
    [periods, loadMore, openYear, openMonth],
  );

  const flat = useMemo<FlatRow[]>(() => {
    const rows: FlatRow[] = recentEntries.map((entry) => ({ key: entryKey(entry.id), kind: 'entry' }));

    for (const { year, months } of groupPeriodsByYear(periods)) {
      rows.push({ key: yearKey(year), kind: 'year' });
      if (!openYears.has(year)) continue;

      for (const month of months) {
        rows.push({ key: monthKey(year, month), kind: 'month' });
        if (!openMonths.has(`${year}-${month}`)) continue;

        const state = monthEntries.get(`${year}-${month}`);
        for (const entry of state?.entries ?? []) {
          rows.push({ key: entryKey(entry.id), kind: 'entry' });
        }
      }
    }

    return rows;
  }, [recentEntries, periods, openYears, openMonths, monthEntries]);

  const onSelectRow = useCallback(
    (key: string) => {
      setSelected(flat.findIndex((row) => row.key === key));
    },
    [flat],
  );

  const selectedKey = flat[selected]?.key ?? null;

  useEffect(() => {
    if (!selectedKey) return;
    rowRefs.current.get(selectedKey)?.scrollIntoView({ block: 'nearest' });
  }, [selectedKey]);

  useGlobalKey('j', () => setSelected((i) => Math.min(i + 1, flat.length - 1)));
  useGlobalKey('k', () => setSelected((i) => Math.max(i - 1, 0)));
  useGlobalKey('Enter', () => {
    const row = flat[selected];
    if (!row) return;

    if (row.kind === 'entry') {
      router.push(`/entry/${row.key.slice('entry:'.length)}`);
    } else if (row.kind === 'year') {
      toggleYear(Number(row.key.slice('year:'.length)));
    } else {
      const [yearPart, monthPart] = row.key.slice('month:'.length).split('-');
      toggleMonth(Number(yearPart), Number(monthPart));
    }
  });

  return (
    <div>
      {recentEntries.length > 0 && (
        <section className={styles.section}>
          <h2 className={styles.heading}>Recent</h2>
          <RecentEntries
            entries={recentEntries}
            selectedKey={selectedKey}
            onSelectRow={onSelectRow}
            registerRef={registerRef}
          />
        </section>
      )}

      <section className={styles.section}>
        <h2 className={styles.heading}>All entries</h2>
        <PeriodTree
          periods={periods}
          openYears={openYears}
          openMonths={openMonths}
          monthEntries={monthEntries}
          selectedKey={selectedKey}
          onToggleYear={toggleYear}
          onToggleMonth={toggleMonth}
          onSelectRow={onSelectRow}
          onSentinel={onSentinel}
          registerRef={registerRef}
        />
      </section>
    </div>
  );
}
