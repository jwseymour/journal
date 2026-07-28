'use client';

import { CommandPalette } from '@/components/command-palette';
import { ReferencePane } from '@/components/reference-pane';
import { ShortcutSheet } from '@/components/shortcut-sheet';
import { ChromeProvider } from '@/lib/chrome';
import { KeyboardProvider } from '@/lib/keyboard';
import { PaletteProvider } from '@/lib/palette';
import { ReferencePaneProvider } from '@/lib/reference-pane';
import { ThemeProvider } from '@/lib/theme';

/**
 * Everything M3 added to the shell, composed in one place.
 *
 * Order matters only in that `KeyboardProvider` reads the others — theme,
 * chrome, the reference pane and the palette all need to exist before it
 * mounts. The overlays render here, once, rather than per-page, since the
 * state they read is app-wide regardless of which page is currently shown.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <ChromeProvider>
        <ReferencePaneProvider>
          <PaletteProvider>
            <KeyboardProvider>
              {children}
              <CommandPalette />
              <ShortcutSheet />
              <ReferencePane />
            </KeyboardProvider>
          </PaletteProvider>
        </ReferencePaneProvider>
      </ChromeProvider>
    </ThemeProvider>
  );
}
