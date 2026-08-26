/**
 * Where a document's file goes, and what it is called (`format.md` — the
 * documents section, `requirements.md` §9).
 *
 *     documents/<id>.md
 *
 * No date nesting — documents aren't chronological, they're organised by
 * subject (`requirements.md` §9.1). No slug either: a document's title is
 * edited over its working life, unlike an entry's immutable `created`, so
 * deriving the filename from it would mean either renaming the file on every
 * title change or leaving a stale name behind. Identity stays in `id`, and
 * the filename is exactly that id — nothing ever resolves a document by its
 * name.
 */

/** The subdirectory of the journal repository that holds documents, sibling to `journal/`. */
export const DOCUMENTS_DIR = 'documents';

export const DOCUMENT_EXTENSION = '.md';

/** `documents/01K3F9X2VQ8N7M4TQXYZ8ABCDE.md`, relative to the journal root. Always POSIX-separated. */
export function documentRelativePath(id: string): string {
  return `${DOCUMENTS_DIR}/${id}${DOCUMENT_EXTENSION}`;
}
