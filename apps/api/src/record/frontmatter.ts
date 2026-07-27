import YAML from 'yaml';
import type { Coordinates, EntryMetadata } from '@journal/contract';
import { malformedEntry } from '../errors.js';
import { isUlid } from './id.js';
import { parseTimestamp, type Timestamp } from './time.js';

/**
 * The entry file itself: YAML frontmatter, then the body (`format.md` §3).
 *
 * This module is the whole of Pillar 1's blast radius. If it can corrupt a
 * body, everything built on top of it is worthless — so the rules below are
 * deliberately narrow and the tests on them are deliberately paranoid.
 *
 * **Reading is verbatim. Writing normalises.** A body read from disk comes back
 * exactly as its bytes, with nothing trimmed or reflowed. The only
 * transformations in the system happen on the way *out* — BOM removed, line
 * endings made LF, one trailing newline guaranteed — and they exist solely so
 * the files are well-formed text. They are idempotent, so a file can be read
 * and written any number of times without drifting.
 *
 * **The body starts immediately after the closing `---` line.** Not after a
 * blank line. `format.md` §3 says everything after the delimiter is body,
 * including a leading blank line or a `---` of its own, and that is the only
 * reading under which a hand-edited file round-trips byte for byte. So no blank
 * line is inserted on write and none is stripped on read.
 */

const DELIMITER = '---';
const BOM = '﻿';

export interface ParsedEntryFile {
  readonly metadata: EntryMetadata;
  /** Parsed once here so callers need not re-parse `created` to order or name. */
  readonly created: Timestamp;
  /** Byte-verbatim, exactly as it sat on disk. */
  readonly body: string;
}

/**
 * The complete set of transformations applied to a body, and nothing beyond it
 * (`format.md` §3).
 *
 * Idempotent by construction: applying it twice changes nothing the first pass
 * did not already change, which is what stops repeated saves from eroding a
 * file. Note that trailing blank lines are *kept* — "never trimmed" means what
 * it says; only the guarantee of a final newline is added.
 */
export function normaliseBody(body: string): string {
  let out = body.startsWith(BOM) ? body.slice(BOM.length) : body;
  // CRLF first, then any surviving lone CR, so old-Mac line endings also land
  // as LF rather than being left as invisible control characters.
  out = out.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (out.length > 0 && !out.endsWith('\n')) out += '\n';
  return out;
}

/**
 * A coordinate as decimal text, never in exponential notation.
 *
 * `String(1e-7)` yields `1e-7`, which some YAML readers take as a string rather
 * than a number. These files are meant to outlive the libraries that read them,
 * so the written form stays plainly decimal. Precision is never reduced — the
 * device's reading is kept whole (`format.md` §3).
 */
function formatCoordinate(value: number): string {
  const plain = String(value);
  if (!plain.includes('e') && !plain.includes('E')) return plain;
  return value.toFixed(20).replace(/0+$/, '').replace(/\.$/, '');
}

function isValidCoordinates(value: unknown): value is Coordinates {
  if (typeof value !== 'object' || value === null) return false;
  const { lat, lon } = value as Record<string, unknown>;
  if (typeof lat !== 'number' || typeof lon !== 'number') return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  return lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

/**
 * Render an entry to the exact bytes that go on disk.
 *
 * Hand-written rather than handed to a YAML serialiser, because `format.md` §3
 * shows one canonical shape — three fields, flow mapping for the coordinates —
 * and a general serialiser would drift from it on a library upgrade. Three
 * fields is not enough work to be worth outsourcing.
 *
 * `location` is omitted entirely when absent. Not null, not empty
 * (`format.md` §3).
 */
export function serialiseEntryFile(metadata: EntryMetadata, body: string): string {
  const lines = [`id: ${metadata.id}`, `created: ${metadata.created}`];
  if (metadata.location) {
    const { lat, lon } = metadata.location;
    lines.push(`location: { lat: ${formatCoordinate(lat)}, lon: ${formatCoordinate(lon)} }`);
  }
  return `${DELIMITER}\n${lines.join('\n')}\n${DELIMITER}\n${normaliseBody(body)}`;
}

/**
 * Locate the closing delimiter: the first line after the opening one that is
 * exactly `---`. A trailing CR is tolerated so a file saved with Windows line
 * endings still reads.
 */
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
 * Read an entry file, or throw `malformed_entry`.
 *
 * Strictness is deliberately uneven, and the asymmetry is the point:
 *
 * - **`id` and `created` are required and strict.** Without them the entry
 *   cannot be identified or placed in time, and there is nothing to serve.
 * - **`location` is best effort.** If it is unreadable it is dropped and the
 *   entry is still returned. Refusing to surface someone's writing because its
 *   coordinates are malformed would invert Pillar 1 — and nothing is lost,
 *   because the file on disk is never touched by this.
 * - **Unknown keys are ignored.** `format.md` §3 permits only three fields, but
 *   a stray key added by hand is not a reason to make an entry unreachable.
 */
export function parseEntryFile(text: string, sourceLabel: string): ParsedEntryFile {
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

  const createdRaw = fields['created'];
  if (typeof createdRaw !== 'string') {
    throw malformedEntry(
      `${sourceLabel}: 'created' is missing or is not text. It must be an RFC 3339 timestamp with a UTC offset.`,
    );
  }
  const created = parseTimestamp(createdRaw);
  if (!created) {
    throw malformedEntry(
      `${sourceLabel}: 'created' is not an RFC 3339 timestamp with a UTC offset — got '${createdRaw}'.`,
    );
  }

  const locationRaw = fields['location'];
  const location = isValidCoordinates(locationRaw) ? locationRaw : undefined;

  return {
    metadata: {
      id,
      created: created.canonical,
      ...(location ? { location } : {}),
    },
    created,
    body: content.slice(closing.bodyStart),
  };
}
