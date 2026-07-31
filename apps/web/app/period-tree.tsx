'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import type { EntryPeriod, EntrySummary } from '@journal/contract';
import { formatDate, formatTime, monthName } from '@/lib/format';
import pageStyles from './page.module.css';
import styles from './period-tree.module.css';

/**
 * The collapsible Year → Month → Entry browser (`design.md` home-page
 * redesign) — controlled entirely by `home-browser.tsx`, which owns which
 * years/months are open, the cached entries per open month, and the one
 * keyboard selection shared with `recent-entries.tsx`.
 *
 * Free multi-open — any number of years and months can be open at once —
 * without JavaScript scroll-position tracking, because each Year and each
 * open Month renders in its own `<section>` with its own sticky `<button
 * position: sticky>` header. A sticky element only stays pinned while its
 * own containing section is in view, so nesting sections is what makes the
 * right ancestor headers stack correctly as you scroll through any number
 * of open branches — the browser resolves it, not this component.
 *
 * Year and Month headers show only their label, never a count: an entry
 * count is an aggregate over writing behaviour, which this application
 * never shows (`design.md` §4, `plan.md` standing rule 7).
 */

export interface MonthState {
  entries: EntrySummary[];
  nextCursor: string | null;
  loading: boolean;
}

export type RegisterRef = (key: string) => (el: HTMLElement | null) => void;

export function yearKey(year: number): string {
  return `year:${year}`;
}

export function monthKey(year: number, month: number): string {
  return `month:${year}-${month}`;
}

export function entryKey(id: string): string {
  return `entry:${id}`;
}

/** Groups already-sorted (year desc, month desc) periods by year, preserving order. */
export function groupPeriodsByYear(periods: EntryPeriod[]): { year: number; months: number[] }[] {
  const groups: { year: number; months: number[] }[] = [];
  for (const { year, month } of periods) {
    const last = groups.at(-1);
    if (last && last.year === year) last.months.push(month);
    else groups.push({ year, months: [month] });
  }
  return groups;
}

export function PeriodTree({
  periods,
  openYears,
  openMonths,
  monthEntries,
  selectedKey,
  onToggleYear,
  onToggleMonth,
  onSelectRow,
  onSentinel,
  registerRef,
}: {
  periods: EntryPeriod[];
  openYears: Set<number>;
  openMonths: Set<string>;
  monthEntries: Map<string, MonthState>;
  selectedKey: string | null;
  onToggleYear: (year: number) => void;
  onToggleMonth: (year: number, month: number) => void;
  onSelectRow: (key: string) => void;
  onSentinel: (year: number, month: number) => void;
  registerRef: RegisterRef;
}) {
  const groups = groupPeriodsByYear(periods);

  if (groups.length === 0) {
    return <p className={styles.empty}>No entries.</p>;
  }

  return (
    <div className={styles.tree}>
      {groups.map(({ year, months }) => {
        const yKey = yearKey(year);
        const isYearOpen = openYears.has(year);

        return (
          <section key={year} className={styles.yearSection}>
            <button
              type="button"
              ref={registerRef(yKey)}
              className={yKey === selectedKey ? `${styles.yearHeader} ${styles.selected}` : styles.yearHeader}
              aria-expanded={isYearOpen}
              onClick={() => onToggleYear(year)}
              onMouseEnter={() => onSelectRow(yKey)}
            >
              {year}
            </button>

            {isYearOpen && (
              <div className={styles.months}>
                {months.map((month) => {
                  const mKeyStr = `${year}-${month}`;
                  const mKey = monthKey(year, month);
                  const isMonthOpen = openMonths.has(mKeyStr);

                  return (
                    <section key={month} className={styles.monthSection}>
                      <button
                        type="button"
                        ref={registerRef(mKey)}
                        className={
                          mKey === selectedKey ? `${styles.monthHeader} ${styles.selected}` : styles.monthHeader
                        }
                        aria-expanded={isMonthOpen}
                        onClick={() => onToggleMonth(year, month)}
                        onMouseEnter={() => onSelectRow(mKey)}
                      >
                        {monthName(month)}
                      </button>

                      {isMonthOpen && (
                        <MonthEntries
                          year={year}
                          month={month}
                          state={monthEntries.get(mKeyStr)}
                          selectedKey={selectedKey}
                          onSelectRow={onSelectRow}
                          onSentinel={onSentinel}
                          registerRef={registerRef}
                        />
                      )}
                    </section>
                  );
                })}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function MonthEntries({
  year,
  month,
  state,
  selectedKey,
  onSelectRow,
  onSentinel,
  registerRef,
}: {
  year: number;
  month: number;
  state: MonthState | undefined;
  selectedKey: string | null;
  onSelectRow: (key: string) => void;
  onSentinel: (year: number, month: number) => void;
  registerRef: RegisterRef;
}) {
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // Watches this month's own sentinel, mounted only while the month is open
  // — scrolling to it loads more of this month, or, once exhausted, opens
  // the chronologically previous one (`home-browser.tsx` decides which). No
  // margin: it fires exactly when the sentinel reaches the viewport, not a
  // literal pixel distance before (`design.md` §6.2 — no literal sizes).
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) onSentinel(year, month);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [year, month, onSentinel]);

  if (!state || (state.loading && state.entries.length === 0)) {
    return <p className={styles.monthLoading}>Loading…</p>;
  }

  if (state.entries.length === 0) {
    return <p className={styles.monthEmpty}>No entries.</p>;
  }

  return (
    <>
      <ol className={`${pageStyles.list} ${styles.entries}`}>
        {state.entries.map((entry) => {
          const eKey = entryKey(entry.id);
          return (
            <li key={entry.id}>
              <Link
                href={`/entry/${entry.id}`}
                ref={registerRef(eKey)}
                className={eKey === selectedKey ? `${pageStyles.item} ${pageStyles.selected}` : pageStyles.item}
                onMouseEnter={() => onSelectRow(eKey)}
              >
                <span className={pageStyles.when}>
                  <time dateTime={entry.created}>{formatDate(entry.created)}</time>
                  <span>{formatTime(entry.created)}</span>
                </span>
                <span className={pageStyles.excerpt}>{entry.excerpt}</span>
              </Link>
            </li>
          );
        })}
      </ol>
      <div ref={sentinelRef} className={styles.sentinel} />
    </>
  );
}
