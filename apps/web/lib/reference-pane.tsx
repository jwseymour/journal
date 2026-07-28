'use client';

import { createContext, useCallback, useContext, useMemo, useState } from 'react';

/**
 * Whether the reference pane is open (`requirements.md` §4.5, `design.md`
 * §5.1, §5.2 — `⌘⇧\`).
 *
 * Session state only, not persisted: unlike the theme or chrome visibility,
 * whether previous entries are open for reference belongs to the writing
 * session at hand, not a standing interface preference.
 */

interface ReferencePaneContextValue {
  open: boolean;
  toggle: () => void;
  close: () => void;
}

const ReferencePaneContext = createContext<ReferencePaneContextValue | null>(null);

export function ReferencePaneProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((v) => !v), []);
  const close = useCallback(() => setOpen(false), []);
  const value = useMemo(() => ({ open, toggle, close }), [open, toggle, close]);
  return <ReferencePaneContext.Provider value={value}>{children}</ReferencePaneContext.Provider>;
}

export function useReferencePane(): ReferencePaneContextValue {
  const value = useContext(ReferencePaneContext);
  if (!value) throw new Error('useReferencePane must be used within a ReferencePaneProvider.');
  return value;
}
