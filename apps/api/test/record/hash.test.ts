import { describe, expect, it } from 'vitest';
import { contentHash } from '../../src/record/hash.js';

describe('contentHash', () => {
  it('is deterministic', () => {
    expect(contentHash('---\nid: x\n---\nbody\n')).toBe(contentHash('---\nid: x\n---\nbody\n'));
  });

  it('changes if a single byte changes, anywhere in the file', () => {
    const original = '---\nid: x\ncreated: y\n---\nbody\n';
    expect(contentHash(original)).not.toBe(contentHash(original.replace('body', 'bodx')));
    // Including a change confined entirely to the frontmatter.
    expect(contentHash(original)).not.toBe(contentHash(original.replace('id: x', 'id: y')));
  });

  it('is opaque — not the identity function, not obviously reversible-looking', () => {
    const hash = contentHash('hello');
    expect(hash).not.toContain('hello');
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  it('handles unicode consistently', () => {
    const text = 'Café, 東京, 👩‍👩‍👧‍👦\n';
    expect(contentHash(text)).toBe(contentHash(text));
  });
});
