import { describe, expect, it } from 'vitest';
import { chunkParagraphs } from '../../src/search/chunk.js';

describe('chunkParagraphs', () => {
  it('splits on a blank line between paragraphs', () => {
    expect(chunkParagraphs('First paragraph.\n\nSecond paragraph.')).toEqual([
      'First paragraph.',
      'Second paragraph.',
    ]);
  });

  it('treats a single paragraph with no blank line as one chunk', () => {
    expect(chunkParagraphs('Just one paragraph of writing.')).toEqual([
      'Just one paragraph of writing.',
    ]);
  });

  it('tolerates more than one blank line between paragraphs', () => {
    expect(chunkParagraphs('First.\n\n\n\nSecond.')).toEqual(['First.', 'Second.']);
  });

  it('tolerates a blank line carrying trailing whitespace', () => {
    expect(chunkParagraphs('First.\n  \nSecond.')).toEqual(['First.', 'Second.']);
  });

  it('trims each paragraph', () => {
    expect(chunkParagraphs('  First.  \n\n  Second.  ')).toEqual(['First.', 'Second.']);
  });

  it('drops leading and trailing blank paragraphs', () => {
    expect(chunkParagraphs('\n\nFirst.\n\nSecond.\n\n')).toEqual(['First.', 'Second.']);
  });

  it('returns nothing for a whitespace-only body', () => {
    expect(chunkParagraphs('   \n\n  \n')).toEqual([]);
  });

  it('returns nothing for an empty body', () => {
    expect(chunkParagraphs('')).toEqual([]);
  });

  it('keeps a single newline inside a paragraph intact', () => {
    expect(chunkParagraphs('Line one.\nLine two, same paragraph.')).toEqual([
      'Line one.\nLine two, same paragraph.',
    ]);
  });
});
