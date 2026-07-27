import { describe, expect, it } from 'vitest';
import type { EntryMetadata } from '@journal/contract';
import { AppError } from '../../src/errors.js';
import {
  normaliseBody,
  parseEntryFile,
  serialiseEntryFile,
} from '../../src/record/frontmatter.js';

/**
 * Round-trip fidelity, which matters more than anything else in the codebase.
 *
 * If this file can corrupt a body then Pillar 1 is already broken and nothing
 * built on top of it is worth having (`plan.md` M1).
 */

const META: EntryMetadata = {
  id: '01K3F9X2VQ8N7M4TQXYZ8ABCDE',
  created: '2026-07-26T22:55:13+01:00',
};

const AT = 'test.md';

/** Bodies chosen to break a naive parser. */
const HOSTILE_BODIES: ReadonlyArray<readonly [string, string]> = [
  ['plain prose', 'A perfectly ordinary sentence.\n'],
  ['opens with a horizontal rule', '---\n\nThe rule above is part of what I wrote.\n'],
  ['opens with a rule and nothing else', '---\n'],
  [
    'is itself a frontmatter block',
    '---\nid: 01ARZ3NDEKTSV4RRFFQ69G5FAV\ncreated: 1999-01-01T00:00:00Z\n---\n\nDecoy.\n',
  ],
  ['contains loose YAML', 'Notes:\n  - one\n  - two\nkey: value\nnested:\n  a: 1\n'],
  ['contains several rules', 'One\n\n---\n\nTwo\n\n---\n\nThree\n'],
  ['emoji, including a ZWJ sequence', 'Family 👩‍👩‍👧‍👦, flag 🇬🇧, skin tone 👍🏽, plain 🙂\n'],
  ['accented and non-latin text', 'Café, jamón, żółć, Ελλάδα, Москва, 東京, العربية\n'],
  ['keeps interior blank lines', 'One\n\n\n\nTwo\n'],
  ['keeps trailing blank lines', 'Words\n\n\n\n'],
  ['has no trailing newline', 'Words with no newline at the end'],
  ['is a single newline', '\n'],
  ['opens with a blank line', '\nIt began with a pause.\n'],
  ['opens with whitespace', '   \tIndented opening.\n'],
  ['keeps tabs and runs of spaces', 'Tabs\there\tand   three   spaces.\n'],
  ['contains a null-ish escape sequence as text', 'Literally \\n and \\t and \\\\ as characters.\n'],
  ['contains backticks and code fences', '```yaml\nid: fake\n---\n```\n'],
  ['contains lone surrogate-safe astral text', '𝔍𝔬𝔲𝔯𝔫𝔞𝔩 𝕥𝕖𝕩𝕥\n'],
  ['contains a BOM in the middle', 'Before﻿after\n'],
];

describe('normaliseBody', () => {
  it('is the entire set of transformations, and no more', () => {
    expect(normaliseBody('a\r\nb\r\n')).toBe('a\nb\n');
    expect(normaliseBody('a\rb')).toBe('a\nb\n');
    expect(normaliseBody('﻿leading BOM\n')).toBe('leading BOM\n');
    expect(normaliseBody('no newline')).toBe('no newline\n');
    // Never trimmed: interior and trailing blank lines survive untouched.
    expect(normaliseBody('  spaced  \n\n\n')).toBe('  spaced  \n\n\n');
    // An empty body stays empty; the closing '---' already ends the file.
    expect(normaliseBody('')).toBe('');
  });

  it('is idempotent, so repeated saves cannot erode a file', () => {
    for (const [, body] of HOSTILE_BODIES) {
      const once = normaliseBody(body);
      expect(normaliseBody(once)).toBe(once);
    }
  });
});

describe('serialise then parse', () => {
  it.each(HOSTILE_BODIES)('returns the body unharmed when it %s', (_name, body) => {
    const file = serialiseEntryFile(META, body);
    const parsed = parseEntryFile(file, AT);
    expect(parsed.body).toBe(normaliseBody(body));
    expect(parsed.metadata).toEqual(META);
  });

  it.each(HOSTILE_BODIES)('re-serialises to identical bytes when the body %s', (_name, body) => {
    const file = serialiseEntryFile(META, body);
    const parsed = parseEntryFile(file, AT);
    expect(serialiseEntryFile(parsed.metadata, parsed.body)).toBe(file);
  });

  it('survives fifty thousand words', () => {
    const body = `${Array.from({ length: 50_000 }, (_, i) => `word${i}`).join(' ')}\n`;
    const parsed = parseEntryFile(serialiseEntryFile(META, body), AT);
    expect(parsed.body).toBe(body);
    expect(parsed.body.length).toBeGreaterThan(300_000);
  });

  it('normalises pasted CRLF exactly once and then leaves it alone', () => {
    const pasted = 'Pasted\r\nfrom\r\nsomewhere else\r\n';
    const first = serialiseEntryFile(META, pasted);
    expect(first).toContain('Pasted\nfrom\nsomewhere else\n');
    expect(first).not.toContain('\r');
    const parsed = parseEntryFile(first, AT);
    expect(serialiseEntryFile(META, parsed.body)).toBe(first);
  });
});

describe('the bytes on disk', () => {
  it('matches format.md §3 exactly', () => {
    const file = serialiseEntryFile(
      { ...META, location: { lat: 51.5072, lon: -0.1276 } },
      'The body begins here.\n',
    );
    expect(file).toBe(
      '---\n' +
        'id: 01K3F9X2VQ8N7M4TQXYZ8ABCDE\n' +
        'created: 2026-07-26T22:55:13+01:00\n' +
        'location: { lat: 51.5072, lon: -0.1276 }\n' +
        '---\n' +
        'The body begins here.\n',
    );
  });

  it('omits location entirely when it is absent — not null, not empty', () => {
    const file = serialiseEntryFile(META, 'x\n');
    expect(file).not.toContain('location');
  });

  it('writes coordinates as decimals, never in exponential notation', () => {
    const file = serialiseEntryFile({ ...META, location: { lat: 1e-7, lon: -0.0000002 } }, 'x\n');
    expect(file).toContain('location: { lat: 0.0000001, lon: -0.0000002 }');
    expect(file).not.toMatch(/e-/);
  });

  it('does not insert a blank line between the frontmatter and the body', () => {
    // `format.md` §3: everything after the closing '---' is body. Inserting a
    // separator here would mean a hand-edited file no longer round-trips.
    expect(serialiseEntryFile(META, 'First line.\n')).toMatch(/---\nFirst line\.\n$/);
  });
});

describe('reading files written by hand', () => {
  it('accepts CRLF frontmatter', () => {
    const file = '---\r\nid: 01K3F9X2VQ8N7M4TQXYZ8ABCDE\r\ncreated: 2026-07-26T22:55:13+01:00\r\n---\r\nBody\r\n';
    const parsed = parseEntryFile(file, AT);
    expect(parsed.metadata.id).toBe(META.id);
    // The body is returned verbatim. Normalising happens only on the way out.
    expect(parsed.body).toBe('Body\r\n');
  });

  it('accepts a leading BOM', () => {
    const parsed = parseEntryFile(`﻿${serialiseEntryFile(META, 'Body\n')}`, AT);
    expect(parsed.metadata.id).toBe(META.id);
  });

  it('accepts block-style location', () => {
    const file =
      '---\nid: 01K3F9X2VQ8N7M4TQXYZ8ABCDE\ncreated: 2026-07-26T22:55:13+01:00\nlocation:\n  lat: 51.5\n  lon: -0.1\n---\nBody\n';
    expect(parseEntryFile(file, AT).metadata.location).toEqual({ lat: 51.5, lon: -0.1 });
  });

  it('ignores unknown keys rather than making the entry unreachable', () => {
    const file =
      '---\nid: 01K3F9X2VQ8N7M4TQXYZ8ABCDE\ncreated: 2026-07-26T22:55:13+01:00\nmood: fine\n---\nBody\n';
    const parsed = parseEntryFile(file, AT);
    expect(parsed.metadata).toEqual(META);
    expect(parsed.body).toBe('Body\n');
  });

  it('drops an unusable location but still returns the writing', () => {
    for (const location of ['nonsense', '{ lat: 999, lon: 0 }', '{ lat: banana, lon: 2 }', 'null']) {
      const file = `---\nid: ${META.id}\ncreated: ${META.created}\nlocation: ${location}\n---\nThe prose survives.\n`;
      const parsed = parseEntryFile(file, AT);
      expect(parsed.metadata.location).toBeUndefined();
      expect(parsed.body).toBe('The prose survives.\n');
    }
  });

  it('normalises created to the canonical form', () => {
    const file = `---\nid: ${META.id}\ncreated: 2026-07-26T22:55:13.482+01:00\n---\nx\n`;
    expect(parseEntryFile(file, AT).metadata.created).toBe('2026-07-26T22:55:13+01:00');
  });
});

describe('refusing to guess', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['no frontmatter at all', 'Just prose.\n'],
    ['frontmatter never closed', `---\nid: ${META.id}\ncreated: ${META.created}\n`],
    ['a missing id', `---\ncreated: ${META.created}\n---\nx\n`],
    ['an id that is not a ULID', `---\nid: not-a-ulid\ncreated: ${META.created}\n---\nx\n`],
    ['a missing created', `---\nid: ${META.id}\n---\nx\n`],
    ['a created with no offset', `---\nid: ${META.id}\ncreated: 2026-07-26T22:55:13\n---\nx\n`],
    ['a created that is only a date', `---\nid: ${META.id}\ncreated: 2026-07-26\n---\nx\n`],
    ['frontmatter that is a list', '---\n- one\n- two\n---\nx\n'],
    ['an opening rule that is not at byte zero', `\n---\nid: ${META.id}\n---\nx\n`],
  ];

  it.each(cases)('rejects %s', (_name, file) => {
    let thrown: unknown;
    try {
      parseEntryFile(file, AT);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe('malformed_entry');
    expect((thrown as AppError).message).toContain(AT);
  });
});
