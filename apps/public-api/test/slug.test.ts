import { describe, expect, it } from 'vitest';
import { slugFor, suffixFromSlug } from '../src/slug.js';

const ID = '01K3F9X2VQ8N7M4TQXYZABCDEF';

describe('slugFor', () => {
  it('lowercases the title and joins words with hyphens', () => {
    expect(slugFor('The Greenhouse Project', ID)).toBe('the-greenhouse-project-abcdef');
  });

  it('appends the last 6 characters of the id, lowercased', () => {
    expect(slugFor('x', ID)).toBe('x-abcdef');
  });

  it('collapses punctuation and whitespace into single hyphens', () => {
    expect(slugFor("It's — a test!!  Right?", ID)).toBe('it-s-a-test-right-abcdef');
  });

  it('strips leading and trailing hyphens produced by punctuation', () => {
    expect(slugFor('!!! Loud', ID)).toBe('loud-abcdef');
  });

  it('falls back to the bare suffix when the title has no word characters', () => {
    expect(slugFor('!!!', ID)).toBe('abcdef');
  });

  it('handles non-ASCII by dropping it rather than guessing a transliteration', () => {
    expect(slugFor('Café days', ID)).toBe('caf-days-abcdef');
  });
});

describe('suffixFromSlug', () => {
  it('recovers the suffix from a slug slugFor produced', () => {
    const slug = slugFor('The Greenhouse Project', ID);
    expect(suffixFromSlug(slug)).toBe('abcdef');
  });

  it('recovers a bare 6-character suffix with no descriptive prefix', () => {
    expect(suffixFromSlug('abcdef')).toBe('abcdef');
  });

  it('is case-insensitive on the way in, but always returns lowercase', () => {
    expect(suffixFromSlug('some-title-ABCDEF')).toBe('abcdef');
  });

  it('is unaffected by an edited title — the resolving fragment is still recovered', () => {
    const original = slugFor('Original title', ID);
    const afterRename = slugFor('Completely different title', ID);
    expect(suffixFromSlug(original)).toBe(suffixFromSlug(afterRename));
  });

  it('returns null for anything not shaped like a slug this service generates', () => {
    for (const bad of ['', 'no-suffix-here', 'toolong123456', 'abcd', 'abcdef7']) {
      expect(suffixFromSlug(bad)).toBeNull();
    }
  });
});
