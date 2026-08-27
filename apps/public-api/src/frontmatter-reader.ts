import YAML from 'yaml';

const DELIMITER = '---';
const BOM = '﻿';

export interface ReadDocumentBodyResult {
  public: boolean;
  body: string;
}

/**
 * The absolute minimum this service ever needs to read from a document
 * file: is it actually public right now, and what's the body?
 *
 * Deliberately not a full parse — `id`/`title`/`created` are already
 * trusted from the shared index, which only ever reflects what the
 * private, authenticated API wrote (`apps/api/src/record/document-frontmatter.ts`
 * does the real, strict parsing on that side). This exists purely as a
 * second, independent check that the file itself still says `public: true`
 * before any content is served (`requirements.md` §10) — the index is a
 * cache and could in principle answer a moment late; the file is never
 * wrong about its own content. Returns `null` for anything that doesn't
 * even look like a document file — that is always treated as "not public"
 * by the caller, never as a reason to guess.
 */
export function readDocumentBody(text: string): ReadDocumentBodyResult | null {
  const content = text.startsWith(BOM) ? text.slice(BOM.length) : text;

  const openEnd = content.startsWith(`${DELIMITER}\n`)
    ? DELIMITER.length + 1
    : content.startsWith(`${DELIMITER}\r\n`)
      ? DELIMITER.length + 2
      : -1;
  if (openEnd === -1) return null;

  let lineStart = openEnd;
  let yamlEnd = -1;
  let bodyStart = -1;
  while (lineStart <= content.length) {
    const newlineAt = content.indexOf('\n', lineStart);
    const lineEnd = newlineAt === -1 ? content.length : newlineAt;
    let line = content.slice(lineStart, lineEnd);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line === DELIMITER) {
      yamlEnd = lineStart;
      bodyStart = newlineAt === -1 ? content.length : newlineAt + 1;
      break;
    }
    if (newlineAt === -1) return null;
    lineStart = newlineAt + 1;
  }
  if (yamlEnd === -1) return null;

  let raw: unknown;
  try {
    raw = YAML.parse(content.slice(openEnd, yamlEnd));
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;

  const isPublic = (raw as Record<string, unknown>)['public'] === true;
  return { public: isPublic, body: content.slice(bodyStart) };
}
