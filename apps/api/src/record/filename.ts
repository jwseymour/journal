import type { Timestamp } from './time.js';

/**
 * Where an entry's file goes, and what it is called (`format.md` §1, §2).
 *
 *     journal/YYYY/MM/YYYY-MM-DD-HHMM-<suffix>.md
 *
 * The date and time are the entry's **own** wall clock — the digits written in
 * `created`, not this machine's local time and not UTC. Local time is how the
 * writing is remembered, and browsing the files by hand is the whole reason
 * these names exist (`requirements.md` §4.2).
 *
 * The suffix is the last six characters of the `id`, lowercased. Identity runs
 * one way only: the name is derived from the id, and nothing ever resolves an
 * entry by its name. Renaming a file therefore breaks nothing
 * (`requirements.md` §4.2) — the sole exception being attachment links, which
 * `format.md` §4 accepts as the price of relative links that resolve anywhere.
 */

/** The subdirectory of the journal repository that holds the entries. */
export const ENTRIES_DIR = 'journal';

export const ENTRY_EXTENSION = '.md';

const pad = (n: number, width: number): string => String(n).padStart(width, '0');

/** The last six characters of the id, lowercased. */
export function filenameSuffix(id: string): string {
  return id.slice(-6).toLowerCase();
}

/** `2026-07-26-2255-abcde8` — the shared stem of the file and its attachment directory. */
export function entryStem(id: string, created: Timestamp): string {
  const date = `${pad(created.year, 4)}-${pad(created.month, 2)}-${pad(created.day, 2)}`;
  const time = `${pad(created.hour, 2)}${pad(created.minute, 2)}`;
  return `${date}-${time}-${filenameSuffix(id)}`;
}

/**
 * `journal/2026/07/2026-07-26-2255-abcde8.md`, relative to the journal root.
 *
 * Always POSIX-separated. This string reaches the API and possibly a hosted
 * backend one day; a Windows separator here would be a portability trap in
 * something that is only ever informational anyway.
 */
export function entryRelativePath(id: string, created: Timestamp): string {
  const year = pad(created.year, 4);
  const month = pad(created.month, 2);
  return `${ENTRIES_DIR}/${year}/${month}/${entryStem(id, created)}${ENTRY_EXTENSION}`;
}
