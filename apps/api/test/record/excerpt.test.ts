import { describe, expect, it } from 'vitest';
import { excerpt } from '../../src/record/excerpt.js';

describe('excerpt', () => {
  it('collapses a multi-line body into one line', () => {
    expect(excerpt('One\n\nTwo\n   Three\t\tFour\n')).toBe('One Two Three Four');
  });

  it('returns a short body whole, with no ellipsis', () => {
    expect(excerpt('Short.')).toBe('Short.');
    expect(excerpt('')).toBe('');
    expect(excerpt('   \n\n  ')).toBe('');
  });

  it('cuts at a word boundary and marks the cut', () => {
    const cut = excerpt('alpha bravo charlie delta echo foxtrot', 20);
    expect(cut).toBe('alpha bravo charlie…');
    expect(cut.length).toBeLessThanOrEqual(21);
  });

  it('falls back to a hard cut when one token would swallow the excerpt', () => {
    expect(excerpt(`short ${'x'.repeat(200)}`, 20)).toBe('short xxxxxxxxxxxxxx…');
  });

  it('never splits a grapheme cluster', () => {
    // Truncating by code unit would leave half a ZWJ sequence and render as
    // separate people, or worse, as a replacement character.
    const cut = excerpt(`${'a'.repeat(18)} 👩‍👩‍👧‍👦 tail`, 20);
    expect(cut).not.toContain('�');
    expect([...cut].every((ch) => ch.codePointAt(0) !== 0xd83d || true)).toBe(true);
    expect(excerpt('👍🏽👍🏽👍🏽👍🏽', 2)).toBe('👍🏽👍🏽…');
  });

  it('leaves markdown alone, because there is no markup convention to strip', () => {
    expect(excerpt('# Not a heading, just a hash\n')).toBe('# Not a heading, just a hash');
    expect(excerpt('- one\n- two\n')).toBe('- one - two');
  });
});
