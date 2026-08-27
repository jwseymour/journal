const SUFFIX_LENGTH = 6;
const SUFFIX_PATTERN = /(?:^|-)([0-9a-z]{6})$/i;

/**
 * A human-readable, URL-safe slug for a public document — never stored,
 * always derived fresh from the title plus the same "last 6 characters of
 * the id" convention `format.md` §2 already uses for entry filenames
 * (`requirements.md` §10). The descriptive part is cosmetic only:
 * resolving a slug back to a document (`suffixFromSlug`) only ever looks at
 * the trailing id fragment, so editing a document's title later never
 * breaks a link someone already has.
 */
export function slugFor(title: string, id: string): string {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const suffix = id.slice(-SUFFIX_LENGTH).toLowerCase();
  return words.length > 0 ? `${words}-${suffix}` : suffix;
}

/**
 * The id fragment at the end of a slug, or `null` if the slug is not shaped
 * like one this service ever generated. Deliberately strict — exactly 6
 * characters, at the end, after a hyphen or alone — so a lookup against it
 * can be an exact, parameterised match rather than a pattern search.
 */
export function suffixFromSlug(slug: string): string | null {
  const match = SUFFIX_PATTERN.exec(slug);
  return match ? match[1]!.toLowerCase() : null;
}
