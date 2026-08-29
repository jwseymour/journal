import type { Metadata } from 'next';
import Link from 'next/link';
import './tokens.css';
import './fonts.css';
import './globals.css';
import styles from './layout.module.css';

export const metadata: Metadata = {
  title: 'Journal',
};

/**
 * The whole shell (`requirements.md` §10, `plan.md` M14/M17) — a name, a
 * list, a read view, and search over exactly what's published. Nothing
 * else: no navigation into anything private, no analysis surfaces, because
 * none of that is public. Styled to match `apps/web`'s running head, per the
 * owner's preference, rather than the placeholder look M14 originally chose.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <link
          rel="preload"
          href="/fonts/literata-latin.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
        <div className={styles.shell}>
          <header className={styles.header}>
            <Link href="/" className={styles.wordmark}>
              Journal
            </Link>
            <nav className={styles.nav}>
              <Link href="/">Documents</Link>
              <Link href="/entries">Entries</Link>
              <Link href="/search">Search</Link>
            </nav>
          </header>
          <main className={styles.main}>{children}</main>
        </div>
      </body>
    </html>
  );
}
