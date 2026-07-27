import { describe, expect, it } from 'vitest';
import { entryRelativePath, entryStem, filenameSuffix } from '../../src/record/filename.js';
import { parseTimestamp } from '../../src/record/time.js';

const at = (value: string) => parseTimestamp(value)!;

describe('entryRelativePath', () => {
  it('matches the shape in format.md §1', () => {
    expect(entryRelativePath('01K3F9X2VQ8N7M4TQXYZ8ABCDE', at('2026-07-26T22:55:13+01:00'))).toBe(
      'journal/2026/07/2026-07-26-2255-8abcde.md',
    );
  });

  it('uses the entry’s own local time, never UTC and never this machine’s', () => {
    const id = '01K3F9X2VQ8N7M4TQXYZ8ABCDE';
    // One instant, three offsets. Each is filed under its own wall clock,
    // because local time is how the writing is remembered (`requirements.md` §4.2).
    expect(entryRelativePath(id, at('2026-07-26T22:55:13+01:00'))).toBe(
      'journal/2026/07/2026-07-26-2255-8abcde.md',
    );
    expect(entryRelativePath(id, at('2026-07-26T21:55:13Z'))).toBe(
      'journal/2026/07/2026-07-26-2155-8abcde.md',
    );
    expect(entryRelativePath(id, at('2026-07-27T06:55:13+09:00'))).toBe(
      'journal/2026/07/2026-07-27-0655-8abcde.md',
    );
  });

  it('files by the local month even when UTC disagrees', () => {
    // 1 August in Tokyo is still 31 July in UTC. The directory follows Tokyo.
    expect(entryRelativePath('01K3F9X2VQ8N7M4TQXYZ8ABCDE', at('2026-08-01T00:30:00+09:00'))).toBe(
      'journal/2026/08/2026-08-01-0030-8abcde.md',
    );
  });

  it('pads every component', () => {
    expect(entryRelativePath('01K3F9X2VQ8N7M4TQXYZ8ABCDE', at('2026-01-05T09:07:00Z'))).toBe(
      'journal/2026/01/2026-01-05-0907-8abcde.md',
    );
  });

  it('always uses POSIX separators', () => {
    expect(entryRelativePath('01K3F9X2VQ8N7M4TQXYZ8ABCDE', at('2026-07-26T22:55:13+01:00'))).not.toContain(
      '\\',
    );
  });
});

describe('the suffix', () => {
  it('is the last six characters of the id, lowercased', () => {
    expect(filenameSuffix('01K3F9X2VQ8N7M4TQXYZ8ABCDE')).toBe('8abcde');
    expect(filenameSuffix('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe('9g5fav');
  });

  it('is derived from identity, never the other way round', () => {
    // The stem is a pure function of the id and the timestamp — nothing reads
    // a filename to learn an id (`requirements.md` §4.2).
    const stem = entryStem('01ARZ3NDEKTSV4RRFFQ69G5FAV', at('2026-07-26T22:55:13+01:00'));
    expect(stem).toBe('2026-07-26-2255-9g5fav');
  });
});
