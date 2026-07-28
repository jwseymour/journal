'use client';

import { COMMANDS } from '@/lib/commands';
import { usePalette } from '@/lib/palette';
import styles from './shortcut-sheet.module.css';

/**
 * `?` — the shortcut sheet (`design.md` §5.2).
 *
 * A reference table, not a menu: this is how the scheme "stays discoverable
 * without a manual" for the keys that are page-specific or purely
 * text-editing, which the command palette cannot sensibly execute from
 * nowhere. Reads the same `lib/commands.ts` table the palette does, so the
 * two can never drift apart.
 */
export function ShortcutSheet() {
  const { overlay, close } = usePalette();
  const open = overlay === 'sheet';
  if (!open) return null;

  const typing = COMMANDS.filter((c) => c.group === 'typing');
  const global = COMMANDS.filter((c) => c.group === 'global');

  return (
    <div className={styles.backdrop} role="presentation" onMouseDown={close}>
      <div
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 className={styles.heading}>While typing</h2>
        <dl className={styles.rows}>
          {typing.map((c) => (
            <div className={c.available ? styles.row : `${styles.row} ${styles.unavailable}`} key={c.id}>
              <dt>
                <kbd className={styles.keys}>{c.keys}</kbd>
              </dt>
              <dd>{c.label}</dd>
            </div>
          ))}
        </dl>

        <h2 className={styles.heading}>Outside a text field</h2>
        <dl className={styles.rows}>
          {global.map((c) => (
            <div className={c.available ? styles.row : `${styles.row} ${styles.unavailable}`} key={c.id}>
              <dt>
                <kbd className={styles.keys}>{c.keys}</kbd>
              </dt>
              <dd>{c.label}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
