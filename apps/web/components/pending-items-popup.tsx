'use client';

import { PendingItemsList } from './pending-items-list';
import styles from './pending-items-popup.module.css';

/**
 * Shown right after a `Process` run finishes (`plan.md` M18) — everything
 * that run produced, ready to review and approve in as few clicks as
 * possible. Closing without deciding everything loses nothing: whatever is
 * left over surfaces again at `/pending`, the same unscoped fallback queue
 * this popup's list component also powers.
 */
export function PendingItemsPopup({ entryId, onClose }: { entryId: string; onClose: () => void }) {
  return (
    <div className={styles.backdrop} role="presentation" onMouseDown={onClose}>
      <div
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-label="Review extracted items"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className={styles.head}>
          <h2 className={styles.heading}>Review what was found</h2>
          <button type="button" className={styles.closeButton} onClick={onClose}>
            Done for now
          </button>
        </div>
        <div className={styles.body}>
          <PendingItemsList entryId={entryId} />
        </div>
      </div>
    </div>
  );
}
