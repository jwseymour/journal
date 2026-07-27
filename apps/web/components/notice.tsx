import styles from './notice.module.css';

/**
 * A quiet panel for the states that are not the populated one — empty, error,
 * missing (`design.md` §6.5).
 *
 * Shared so that the copy stays consistent and stays plain. Nothing here
 * apologises at length, encourages, or editorialises (`design.md` §4).
 *
 * `tone="danger"` is the only place the reserved red appears. It means an
 * error or something irreversible, and nothing else (`design.md` §2.1).
 */
export function Notice({
  title,
  tone = 'quiet',
  children,
}: {
  title: string;
  tone?: 'quiet' | 'danger';
  children?: React.ReactNode;
}) {
  return (
    <div className={tone === 'danger' ? `${styles.notice} ${styles.danger}` : styles.notice}>
      <p className={styles.title}>{title}</p>
      {children ? <div className={styles.detail}>{children}</div> : null}
    </div>
  );
}
