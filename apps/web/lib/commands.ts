/**
 * The scheme itself, as data (`design.md` §5.2).
 *
 * One list, designed as a whole rather than accumulated per feature — this is
 * what makes both the command palette and the shortcut sheet possible without
 * the two ever disagreeing, because they read the same table.
 *
 * `available` distinguishes a command with somewhere to go right now from one
 * that documents where the scheme is *heading* — search, recording and
 * analysis are real keys in the design but their features are later
 * milestones (M4, M6, M8). Listing them un-actionable, rather than leaving
 * the keys silently dead, is what keeps `⌘K` and `?` an honest description of
 * the whole scheme rather than only the part that happens to work today.
 */

export type CommandGroup = 'typing' | 'global';

export interface CommandSpec {
  id: string;
  keys: string;
  label: string;
  group: CommandGroup;
  available: boolean;
}

export const COMMANDS: readonly CommandSpec[] = [
  // While typing — ⌘ combos, live regardless of focus.
  { id: 'palette', keys: '⌘K', label: 'Command palette, and search', group: 'typing', available: true },
  { id: 'save', keys: '⌘S', label: 'Save now', group: 'typing', available: true },
  { id: 'finish', keys: '⌘↩', label: 'Finish the entry', group: 'typing', available: true },
  { id: 'record', keys: '⌘⌥R', label: 'Start / stop recording', group: 'typing', available: false },
  { id: 'toggle-source', keys: '⌘⇧P', label: 'Toggle source and rendered', group: 'typing', available: true },
  { id: 'toggle-chrome', keys: '⌘\\', label: 'Toggle chrome', group: 'typing', available: true },
  { id: 'toggle-reference', keys: '⌘⇧\\', label: 'Toggle the reference pane', group: 'typing', available: true },
  { id: 'emphasis-bold', keys: '⌘B', label: 'Emphasis (bold)', group: 'typing', available: true },
  { id: 'emphasis-italic', keys: '⌘I', label: 'Emphasis (italic)', group: 'typing', available: true },

  // Outside a text field — plain keys.
  { id: 'new-entry', keys: 'n', label: 'New entry', group: 'global', available: true },
  { id: 'search', keys: '/', label: 'Search', group: 'global', available: false },
  { id: 'next', keys: 'j', label: 'Next', group: 'global', available: true },
  { id: 'previous', keys: 'k', label: 'Previous', group: 'global', available: true },
  { id: 'open', keys: '↩', label: 'Open', group: 'global', available: true },
  { id: 'edit', keys: 'e', label: 'Edit the open entry', group: 'global', available: true },
  { id: 'toggle-theme', keys: 't', label: 'Day / night', group: 'global', available: true },
  { id: 'go-writing', keys: 'g then h', label: 'Go to writing', group: 'global', available: true },
  { id: 'go-entries', keys: 'g then e', label: 'Go to entries', group: 'global', available: true },
  { id: 'go-search', keys: 'g then s', label: 'Go to search', group: 'global', available: false },
  { id: 'go-analysis', keys: 'g then a', label: 'Go to analysis', group: 'global', available: false },
  { id: 'shortcuts', keys: '?', label: 'Shortcut sheet', group: 'global', available: true },
  { id: 'back', keys: 'Esc', label: 'Step back one level', group: 'global', available: true },
];
