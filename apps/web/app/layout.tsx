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
 * The shell.
 *
 * A running head and nothing else. Chrome becomes toggleable in M3, at which
 * point hidden is a first-class state rather than a reduced one
 * (`design.md` §5.1) — so this deliberately holds nothing the writing surface
 * depends on.
 *
 * Copy is plain throughout. The application does not congratulate, encourage,
 * or editorialise about the writing (`design.md` §4).
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {/* Hoisted into <head> by React. The roman latin subset covers almost
            everything; the other three load only when a glyph needs them. */}
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
              <Link href="/entry/new">Write</Link>
            </nav>
          </header>
          <main className={styles.main}>{children}</main>
        </div>
      </body>
    </html>
  );
}
