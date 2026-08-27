import { describe, expect, it } from 'vitest';
import { readDocumentBody } from '../src/frontmatter-reader.js';

const BOM = '﻿';

function file(frontmatter: string, body: string): string {
  return `---\n${frontmatter}\n---\n${body}`;
}

describe('readDocumentBody', () => {
  it('reads public: true and returns the body', () => {
    const result = readDocumentBody(file('id: x\npublic: true', 'The body.\n'));
    expect(result).toEqual({ public: true, body: 'The body.\n' });
  });

  it('reads public: false', () => {
    const result = readDocumentBody(file('id: x\npublic: false', 'The body.\n'));
    expect(result?.public).toBe(false);
  });

  it('treats a missing public field as not public — never a guess towards true', () => {
    const result = readDocumentBody(file('id: x\ntitle: y', 'The body.\n'));
    expect(result?.public).toBe(false);
  });

  it('treats a non-boolean public value as not public', () => {
    for (const value of ['"yes"', '1', 'null']) {
      const result = readDocumentBody(file(`public: ${value}`, 'x\n'));
      expect(result?.public).toBe(false);
    }
  });

  it('returns null for a file with no frontmatter at all', () => {
    expect(readDocumentBody('Just prose.\n')).toBeNull();
  });

  it('returns null for frontmatter that is never closed', () => {
    expect(readDocumentBody('---\npublic: true\nThe rest, with no closing delimiter.\n')).toBeNull();
  });

  it('returns null for frontmatter that is not valid YAML', () => {
    expect(readDocumentBody(file('public: [unterminated', 'x\n'))).toBeNull();
  });

  it('returns null for frontmatter that is not a mapping', () => {
    expect(readDocumentBody('---\n- one\n- two\n---\nx\n')).toBeNull();
  });

  it('strips a leading BOM before looking for the delimiter', () => {
    const result = readDocumentBody(`${BOM}${file('public: true', 'x\n')}`);
    expect(result).toEqual({ public: true, body: 'x\n' });
  });

  it('accepts CRLF line endings around the delimiters', () => {
    const result = readDocumentBody('---\r\npublic: true\r\n---\r\nx\r\n');
    expect(result).toEqual({ public: true, body: 'x\r\n' });
  });

  it('is unmoved by a body that itself opens with a horizontal rule', () => {
    const result = readDocumentBody(file('public: true', '---\n\nThe rule above is part of what I wrote.\n'));
    expect(result).toEqual({ public: true, body: '---\n\nThe rule above is part of what I wrote.\n' });
  });

  it('is unmoved by a body that is itself a decoy frontmatter block', () => {
    const result = readDocumentBody(
      file('public: true', '---\nid: decoy\npublic: true\n---\n\nDecoy.\n'),
    );
    expect(result).toEqual({ public: true, body: '---\nid: decoy\npublic: true\n---\n\nDecoy.\n' });
  });
});
