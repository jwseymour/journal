'use client';

import Link from 'next/link';
import { useChrome } from '@/lib/chrome';
import { useTheme } from '@/lib/theme';
import styles from './layout.module.css';

/**
 * The running head — toggleable (`design.md` §5.1, §5.2 — `⌘\`).
 *
 * Hidden is a first-class state: when `hidden` is true this renders nothing
 * at all, not a collapsed sliver of itself, so the writing surface gets the
 * full page rather than a merely reduced one.
 */
export function Header() {
  const { hidden } = useChrome();
  const { theme, toggle: toggleTheme } = useTheme();

  if (hidden) return null;

  return (
    <header className={styles.header}>
      <Link href="/" className={styles.wordmark}>
        Journal
      </Link>
      <nav className={styles.nav}>
        <button
          type="button"
          className={styles.themeToggle}
          onClick={toggleTheme}
          aria-label={theme === 'day' ? 'Switch to night' : 'Switch to day'}
          title={theme === 'day' ? 'Switch to night' : 'Switch to day'}
        >
          {theme === 'day' ? '●' : '○'}
        </button>
        <Link href="/search">Search</Link>
        <Link href="/analysis">Analysis</Link>
        <Link href="/chat">Chat</Link>
        <Link href="/entry/new">Write</Link>
      </nav>
    </header>
  );
}
