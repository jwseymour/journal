'use client';

import { PendingItemsList } from '@/components/pending-items-list';
import styles from './page.module.css';

/**
 * The fallback queue (`plan.md` M18) — everything a `Process` run produced
 * that was never acted on in its popup, all in one unscoped place rather
 * than scattered across per-type suggestion pages. Nothing here reminds or
 * resurfaces on its own (`requirements.md` §12); this is simply where a
 * pending item waits until it is looked at.
 */
export default function PendingPage() {
  return (
    <div className={styles.page}>
      <p className={styles.intro}>
        Everything extracted and not yet decided, from any entry — approved or rejected here exactly
        as it would be in the popup right after Process.
      </p>
      <PendingItemsList />
    </div>
  );
}
