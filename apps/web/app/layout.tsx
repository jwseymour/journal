import type { Metadata } from 'next';
import './tokens.css';
import './fonts.css';
import './globals.css';
import { Header } from './header';
import { Providers } from './providers';
import styles from './layout.module.css';

export const metadata: Metadata = {
  title: 'Journal',
};

/**
 * The shell.
 *
 * A running head, toggleable, and nothing else fixed. Copy is plain
 * throughout — the application does not congratulate, encourage, or
 * editorialise about the writing (`design.md` §4).
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
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
        <Providers>
          <div className={styles.shell}>
            <Header />
            <main className={styles.main}>{children}</main>
          </div>
        </Providers>
      </body>
    </html>
  );
}
