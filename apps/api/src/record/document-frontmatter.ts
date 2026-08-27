import YAML from 'yaml';
import type { DocumentMetadata } from '@journal/contract';
import { malformedEntry } from '../errors.js';
import { isUlid } from './id.js';
import { normaliseBody } from './frontmatter.js';
import { parseTimestamp, type Timestamp } from './time.js';

/**
 * The document file itself: YAML frontmatter, then the body — the concrete
 * form of `requirements.md` §9, mirroring `record/frontmatter.ts`'s
 * entry-file handling exactly (same delimiter search, same verbatim-read /
 * normalise-on-write split, same reason for hand-writing rather than handing
 * the whole file to a general YAML serialiser: a handful of fields in one
 * fixed shape is not enough to be worth outsourcing, and outsourcing it would
 * drift on a library upgrade).
 *
 * `normaliseBody` is imported and reused unchanged — it has nothing
 * entry-specific in it.
 */

const DELIMITER = '---';
const BOM = '﻿';

export interface ParsedDocumentFile {
  readonly metadata: DocumentMetadata;
  readonly created: Timestamp;
  readonly updated: Timestamp;
  readonly body: string;
}

function isValidCitedEntries(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && isUlid(item));
}

/**
 * Render a document to the exact bytes that go on disk.
 *
 * `citedEntries` is omitted entirely when empty — absent, not `[]`, the same
 * convention `serialiseEntryFile` uses for `location`.
 */
export function serialiseDocumentFile(metadata: DocumentMetadata, body: string): string {
  const lines = [
    `id: ${metadata.id}`,
    `title: ${YAML.stringify(metadata.title).trimEnd()}`,
    `created: ${metadata.created}`,
    `updated: ${metadata.updated}`,
    `public: ${metadata.public}`,
  ];
  if (metadata.citedEntries && metadata.citedEntries.length > 0) {
    lines.push(`citedEntries: [${metadata.citedEntries.join(', ')}]`);
  }
  return `${DELIMITER}\n${lines.join('\n')}\n${DELIMITER}\n${normaliseBody(body)}`;
}

function findClosingDelimiter(text: string, from: number): { yamlEnd: number; bodyStart: number } | null {
  let lineStart = from;
  while (lineStart <= text.length) {
    const newlineAt = text.indexOf('\n', lineStart);
    const lineEnd = newlineAt === -1 ? text.length : newlineAt;
    let line = text.slice(lineStart, lineEnd);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line === DELIMITER) {
      return { yamlEnd: lineStart, bodyStart: newlineAt === -1 ? text.length : newlineAt + 1 };
    }
    if (newlineAt === -1) return null;
    lineStart = newlineAt + 1;
  }
  return null;
}

/**
 * Read a document file, or throw `malformed_entry` — reused from
 * `errors.ts` rather than adding a document-specific error code; the
 * meaning ("a file exists but could not be read as the thing it claims to
 * be") is identical.
 *
 * Strictness mirrors `parseEntryFile`: `id`, `title`, `created` and
 * `updated` are required and strict. `citedEntries` is best-effort — a
 * malformed entry in the list is dropped rather than blocking the read,
 * same treatment `location` gets on an entry.
 */
export function parseDocumentFile(text: string, sourceLabel: string): ParsedDocumentFile {
  const content = text.startsWith(BOM) ? text.slice(BOM.length) : text;

  const openEnd = content.startsWith(`${DELIMITER}\n`)
    ? DELIMITER.length + 1
    : content.startsWith(`${DELIMITER}\r\n`)
      ? DELIMITER.length + 2
      : -1;
  if (openEnd === -1) {
    throw malformedEntry(`${sourceLabel}: no frontmatter — the file must open with '---'.`);
  }

  const closing = findClosingDelimiter(content, openEnd);
  if (!closing) {
    throw malformedEntry(`${sourceLabel}: frontmatter is never closed by a '---' line.`);
  }

  let raw: unknown;
  try {
    raw = YAML.parse(content.slice(openEnd, closing.yamlEnd));
  } catch (cause) {
    throw malformedEntry(`${sourceLabel}: frontmatter is not valid YAML.`, cause);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw malformedEntry(`${sourceLabel}: frontmatter is not a mapping.`);
  }
  const fields = raw as Record<string, unknown>;

  const id = fields['id'];
  if (typeof id !== 'string' || !isUlid(id)) {
    throw malformedEntry(`${sourceLabel}: 'id' is missing or is not a ULID.`);
  }

  const title = fields['title'];
  if (typeof title !== 'string' || title.length === 0) {
    throw malformedEntry(`${sourceLabel}: 'title' is missing or is not text.`);
  }

  const createdRaw = fields['created'];
  if (typeof createdRaw !== 'string') {
    throw malformedEntry(`${sourceLabel}: 'created' is missing or is not text.`);
  }
  const created = parseTimestamp(createdRaw);
  if (!created) {
    throw malformedEntry(`${sourceLabel}: 'created' is not an RFC 3339 timestamp with a UTC offset — got '${createdRaw}'.`);
  }

  const updatedRaw = fields['updated'];
  if (typeof updatedRaw !== 'string') {
    throw malformedEntry(`${sourceLabel}: 'updated' is missing or is not text.`);
  }
  const updated = parseTimestamp(updatedRaw);
  if (!updated) {
    throw malformedEntry(`${sourceLabel}: 'updated' is not an RFC 3339 timestamp with a UTC offset — got '${updatedRaw}'.`);
  }

  // Absent, not an error: every document written before this field existed
  // has no `public` key at all, and was exactly as private as an entry —
  // `false` is the correct reading of that silence, not a guess
  // (`requirements.md` §9.3). Present but not a boolean is still rejected,
  // the same strictness `id`/`title`/`created`/`updated` get.
  const publicRaw = fields['public'];
  let isPublic: boolean;
  if (publicRaw === undefined) {
    isPublic = false;
  } else if (typeof publicRaw === 'boolean') {
    isPublic = publicRaw;
  } else {
    throw malformedEntry(`${sourceLabel}: 'public' is present but is not a boolean.`);
  }

  const citedEntriesRaw = fields['citedEntries'];
  const citedEntries = isValidCitedEntries(citedEntriesRaw) ? citedEntriesRaw : undefined;

  return {
    metadata: {
      id,
      title,
      created: created.canonical,
      updated: updated.canonical,
      public: isPublic,
      ...(citedEntries && citedEntries.length > 0 ? { citedEntries } : {}),
    },
    created,
    updated,
    body: content.slice(closing.bodyStart),
  };
}
