import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractMediaMetadata } from '../../src/record/media-metadata.js';

const parseMock = vi.fn();
vi.mock('exifr', () => ({ default: { parse: (...args: unknown[]) => parseMock(...args) } }));

describe('extractMediaMetadata', () => {
  afterEach(() => {
    parseMock.mockReset();
  });

  it('dispatches an image content type to the EXIF parser', async () => {
    parseMock.mockResolvedValue({ DateTimeOriginal: '2020:05:06 07:08:09' });
    const result = await extractMediaMetadata(Buffer.from('x'), 'image/jpeg');
    expect(parseMock).toHaveBeenCalled();
    expect(result).toEqual({ width: null, height: null, capturedAt: '2020-05-06T07:08:09' });
  });

  it('dispatches a video content type to the box parser instead, never calling exifr', async () => {
    const result = await extractMediaMetadata(Buffer.from('not a real container'), 'video/mp4');
    expect(parseMock).not.toHaveBeenCalled();
    expect(result).toEqual({ width: null, height: null, capturedAt: null });
  });
});
