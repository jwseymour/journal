import type { EntryPage, EntryPeriodsResponse } from '@journal/contract';
import { Notice } from '@/components/notice';
import { ApiRequestError, listEntries, listEntryPeriods } from '@/lib/api';
import { HomeBrowser } from './home-browser';
import { HomeSearch } from './home-search';
import styles from './page.module.css';

/**
 * The home page: search, the most recent entry, and a collapsible
 * Year/Month browser to reach everything older.
 *
 * Never prerendered: what is on disk is the truth, and a journal must not
 * serve a snapshot taken at build time.
 */
export const dynamic = 'force-dynamic';

const RECENT_COUNT = 1;

/**
 * Note what is deliberately absent: any total, any count of entries written,
 * any calendar of activity. Per-entry facts are content and are fine; an
 * aggregate over writing *behaviour* is a streak by another name
 * (`design.md` §4, `plan.md` standing rule 7). The Year/Month tree below
 * shows only labels — "2026", "March" — never a count of what's inside them.
 */
export default async function HomePage() {
  let recent: EntryPage;
  let periods: EntryPeriodsResponse;
  try {
    [recent, periods] = await Promise.all([
      listEntries({ limit: RECENT_COUNT }),
      listEntryPeriods(),
    ]);
  } catch (error) {
    return (
      <Notice title="The journal could not be read." tone="danger">
        {error instanceof ApiRequestError ? error.message : 'Something went wrong.'}
      </Notice>
    );
  }

  if (recent.entries.length === 0) {
    return <p className={styles.empty}>No entries.</p>;
  }

  return (
    <div>
      <section className={styles.section}>
        <HomeSearch />
      </section>
      <HomeBrowser recentEntries={recent.entries} periods={periods.periods} />
    </div>
  );
}
