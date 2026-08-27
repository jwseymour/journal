import type { Metadata } from 'next';
import Link from 'next/link';
import './tokens.css';
import './globals.css';
import styles from './layout.module.css';

export const metadata: Metadata = {
  title: 'Journal',
};

/**
 * The whole shell (`requirements.md` §10, `plan.md` M14) — a name, a list,
 * and a read view. Nothing else: no navigation into anything private, no
 * search, no analysis surfaces, because none of that is public.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className={styles.shell}>
          <header className={styles.header}>
            <Link href="/" className={styles.siteName}>
              Journal
            </Link>
          </header>
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}
