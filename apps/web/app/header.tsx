'use client';

import Link from 'next/link';
import { useChrome } from '@/lib/chrome';
import { logout } from '@/lib/api';
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

  async function handleSignOut(): Promise<void> {
    try {
      await logout();
    } finally {
      // Best-effort either way — the cookie is gone or never existed, and
      // the login page will correctly show "signed out" in both cases.
      window.location.href = '/login';
    }
  }

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
        <Link href="/documents">Documents</Link>
        <Link href="/photos">Photos</Link>
        <Link href="/pending">Pending</Link>
        <Link href="/chat">Chat</Link>
        <Link href="/entry/new">Write</Link>
        <button type="button" className={styles.themeToggle} onClick={handleSignOut}>
          Sign out
        </button>
      </nav>
    </header>
  );
}
