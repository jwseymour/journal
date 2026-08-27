import { describe, expect, it } from 'vitest';
import type { DocumentMetadata } from '@journal/contract';
import { AppError } from '../../src/errors.js';
import { parseDocumentFile, serialiseDocumentFile } from '../../src/record/document-frontmatter.js';

/**
 * Round-trip fidelity for documents, mirroring `frontmatter.test.ts`'s
 * paranoia — a document is directly authored content, just as an entry is,
 * so it deserves the same care (`requirements.md` §9).
 */

const META: DocumentMetadata = {
  id: '01K3F9X2VQ8N7M4TQXYZ8ABCDE',
  title: 'The greenhouse project',
  created: '2026-07-26T22:55:13+01:00',
  updated: '2026-08-25T09:00:00+01:00',
  public: false,
};

const AT = 'test.md';

const HOSTILE_BODIES: ReadonlyArray<readonly [string, string]> = [
  ['plain prose', 'A perfectly ordinary sentence.\n'],
  ['opens with a horizontal rule', '---\n\nThe rule above is part of what I wrote.\n'],
  [
    'is itself a frontmatter block',
    '---\nid: 01ARZ3NDEKTSV4RRFFQ69G5FAV\ntitle: Decoy\ncreated: 1999-01-01T00:00:00Z\nupdated: 1999-01-01T00:00:00Z\n---\n\nDecoy.\n',
  ],
  ['contains loose YAML', 'Notes:\n  - one\n  - two\nkey: value\n'],
  ['emoji, including a ZWJ sequence', 'Family 👩‍👩‍👧‍👦, flag 🇬🇧, plain 🙂\n'],
  ['keeps interior and trailing blank lines', 'One\n\n\n\nTwo\n\n\n'],
  ['has no trailing newline', 'Words with no newline at the end'],
];

describe('serialise then parse', () => {
  it.each(HOSTILE_BODIES)('returns the body unharmed when it %s', (_name, body) => {
    const file = serialiseDocumentFile(META, body);
    const parsed = parseDocumentFile(file, AT);
    expect(parsed.body).toBe(body.endsWith('\n') ? body : `${body}\n`);
    expect(parsed.metadata).toEqual(META);
  });

  it.each(HOSTILE_BODIES)('re-serialises to identical bytes', (_name, body) => {
    const file = serialiseDocumentFile(META, body);
    const parsed = parseDocumentFile(file, AT);
    expect(serialiseDocumentFile(parsed.metadata, parsed.body)).toBe(file);
  });
});

describe('the bytes on disk', () => {
  it('matches the documented shape exactly', () => {
    const file = serialiseDocumentFile(META, 'The body begins here.\n');
    expect(file).toBe(
      '---\n' +
        'id: 01K3F9X2VQ8N7M4TQXYZ8ABCDE\n' +
        'title: The greenhouse project\n' +
        'created: 2026-07-26T22:55:13+01:00\n' +
        'updated: 2026-08-25T09:00:00+01:00\n' +
        'public: false\n' +
        '---\n' +
        'The body begins here.\n',
    );
  });

  it('omits citedEntries entirely when absent — not null, not empty', () => {
    const file = serialiseDocumentFile(META, 'x\n');
    expect(file).not.toContain('citedEntries');
  });

  it('writes citedEntries as a flow sequence of ids', () => {
    const file = serialiseDocumentFile(
      { ...META, citedEntries: ['01ARZ3NDEKTSV4RRFFQ69G5FAV', '01ARZ3NDEKTSV4RRFFQ69G5FAW'] },
      'x\n',
    );
    expect(file).toContain('citedEntries: [01ARZ3NDEKTSV4RRFFQ69G5FAV, 01ARZ3NDEKTSV4RRFFQ69G5FAW]');
  });

  it('quotes a title that would otherwise be ambiguous YAML', () => {
    const file = serialiseDocumentFile({ ...META, title: 'Yes: this has a colon' }, 'x\n');
    const parsed = parseDocumentFile(file, AT);
    expect(parsed.metadata.title).toBe('Yes: this has a colon');
  });
});

describe('reading files written by hand', () => {
  it('ignores unknown keys rather than making the document unreachable', () => {
    const file = `---\nid: ${META.id}\ntitle: ${META.title}\ncreated: ${META.created}\nupdated: ${META.updated}\nmood: fine\n---\nBody\n`;
    const parsed = parseDocumentFile(file, AT);
    expect(parsed.metadata).toEqual(META);
    expect(parsed.body).toBe('Body\n');
  });

  it('drops a malformed citedEntries but still returns the writing', () => {
    for (const citedEntries of ['nonsense', '[not-a-ulid]', 'null']) {
      const file = `---\nid: ${META.id}\ntitle: ${META.title}\ncreated: ${META.created}\nupdated: ${META.updated}\ncitedEntries: ${citedEntries}\n---\nThe prose survives.\n`;
      const parsed = parseDocumentFile(file, AT);
      expect(parsed.metadata.citedEntries).toBeUndefined();
      expect(parsed.body).toBe('The prose survives.\n');
    }
  });

  it('normalises created and updated to their canonical forms', () => {
    const file = `---\nid: ${META.id}\ntitle: ${META.title}\ncreated: 2026-07-26T22:55:13.482+01:00\nupdated: 2026-08-25T09:00:00.000+01:00\n---\nx\n`;
    const parsed = parseDocumentFile(file, AT);
    expect(parsed.metadata.created).toBe('2026-07-26T22:55:13+01:00');
    expect(parsed.metadata.updated).toBe('2026-08-25T09:00:00+01:00');
  });
});

describe('public (`requirements.md` §9.3)', () => {
  it('defaults to false when the field is absent — every document written before it existed', () => {
    const file = `---\nid: ${META.id}\ntitle: ${META.title}\ncreated: ${META.created}\nupdated: ${META.updated}\n---\nx\n`;
    const parsed = parseDocumentFile(file, AT);
    expect(parsed.metadata.public).toBe(false);
  });

  it('round-trips true', () => {
    const file = serialiseDocumentFile({ ...META, public: true }, 'x\n');
    expect(file).toContain('public: true');
    expect(parseDocumentFile(file, AT).metadata.public).toBe(true);
  });

  it('rejects a value that is present but not a boolean', () => {
    const file = `---\nid: ${META.id}\ntitle: ${META.title}\ncreated: ${META.created}\nupdated: ${META.updated}\npublic: "yes"\n---\nx\n`;
    let thrown: unknown;
    try {
      parseDocumentFile(file, AT);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe('malformed_entry');
  });
});

describe('refusing to guess', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['no frontmatter at all', 'Just prose.\n'],
    ['frontmatter never closed', `---\nid: ${META.id}\ntitle: ${META.title}\n`],
    ['a missing id', `---\ntitle: ${META.title}\ncreated: ${META.created}\nupdated: ${META.updated}\n---\nx\n`],
    ['a missing title', `---\nid: ${META.id}\ncreated: ${META.created}\nupdated: ${META.updated}\n---\nx\n`],
    ['an empty title', `---\nid: ${META.id}\ntitle: ""\ncreated: ${META.created}\nupdated: ${META.updated}\n---\nx\n`],
    ['a missing created', `---\nid: ${META.id}\ntitle: ${META.title}\nupdated: ${META.updated}\n---\nx\n`],
    ['a missing updated', `---\nid: ${META.id}\ntitle: ${META.title}\ncreated: ${META.created}\n---\nx\n`],
    [
      'a created with no offset',
      `---\nid: ${META.id}\ntitle: ${META.title}\ncreated: 2026-07-26T22:55:13\nupdated: ${META.updated}\n---\nx\n`,
    ],
  ];

  it.each(cases)('rejects %s', (_name, file) => {
    let thrown: unknown;
    try {
      parseDocumentFile(file, AT);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe('malformed_entry');
    expect((thrown as AppError).message).toContain(AT);
  });
});
