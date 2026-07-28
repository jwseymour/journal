'use client';

import { createContext, useCallback, useContext, useMemo, useState } from 'react';

/** Which overlay, if any, is open: the command palette or the shortcut sheet. */
type Overlay = 'palette' | 'sheet' | null;

interface PaletteContextValue {
  overlay: Overlay;
  openPalette: () => void;
  openSheet: () => void;
  close: () => void;
}

const PaletteContext = createContext<PaletteContextValue | null>(null);

export function PaletteProvider({ children }: { children: React.ReactNode }) {
  const [overlay, setOverlay] = useState<Overlay>(null);
  const openPalette = useCallback(() => setOverlay('palette'), []);
  const openSheet = useCallback(() => setOverlay('sheet'), []);
  const close = useCallback(() => setOverlay(null), []);
  const value = useMemo(() => ({ overlay, openPalette, openSheet, close }), [overlay, openPalette, openSheet, close]);
  return <PaletteContext.Provider value={value}>{children}</PaletteContext.Provider>;
}

export function usePalette(): PaletteContextValue {
  const value = useContext(PaletteContext);
  if (!value) throw new Error('usePalette must be used within a PaletteProvider.');
  return value;
}
