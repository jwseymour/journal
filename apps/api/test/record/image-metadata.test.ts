import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractImageMetadata } from '../../src/record/image-metadata.js';

const parseMock = vi.fn();

vi.mock('exifr', () => ({
  default: { parse: (...args: unknown[]) => parseMock(...args) },
}));

/**
 * `exifr` itself is a well-established third-party library — its own
 * correctness (actually reading a JPEG/HEIC byte stream) is out of scope
 * here. What belongs to this file is `extractImageMetadata`'s own logic:
 * which tags it asks for, how it falls back, and — the part actually worth
 * testing carefully — that `reviveValues: false` is passed so exifr never
 * gets a chance to invent a timezone offset EXIF never recorded (see the
 * module's own doc comment), plus how the raw `"YYYY:MM:DD HH:MM:SS"`
 * string it returns is reshaped into `capturedAt`.
 */
describe('extractImageMetadata', () => {
  afterEach(() => {
    parseMock.mockReset();
  });

  it('asks exifr for raw values, not revived Date instances', async () => {
    parseMock.mockResolvedValue({});
    await extractImageMetadata(Buffer.from('x'));
    expect(parseMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ reviveValues: false }));
  });

  it('prefers DateTimeOriginal, converted to the naive T-separated shape', async () => {
    parseMock.mockResolvedValue({ DateTimeOriginal: '2018:07:25 16:34:23', CreateDate: '2000:01:01 00:00:00' });
    const result = await extractImageMetadata(Buffer.from('x'));
    expect(result.capturedAt).toBe('2018-07-25T16:34:23');
  });

  it('falls back to CreateDate when DateTimeOriginal is absent', async () => {
    parseMock.mockResolvedValue({ CreateDate: '2023:01:03 12:37:30' });
    const result = await extractImageMetadata(Buffer.from('x'));
    expect(result.capturedAt).toBe('2023-01-03T12:37:30');
  });

  it('yields no metadata at all when neither date tag is present', async () => {
    parseMock.mockResolvedValue({ ExifImageWidth: 100 });
    const result = await extractImageMetadata(Buffer.from('x'));
    expect(result.capturedAt).toBeNull();
  });

  it('ignores a malformed date string rather than passing it through', async () => {
    parseMock.mockResolvedValue({ DateTimeOriginal: 'not a date' });
    const result = await extractImageMetadata(Buffer.from('x'));
    expect(result.capturedAt).toBeNull();
  });

  it('reads dimensions from whichever tag family the file used', async () => {
    parseMock.mockResolvedValue({ ExifImageWidth: 1440, ExifImageHeight: 960 });
    expect(await extractImageMetadata(Buffer.from('x'))).toMatchObject({ width: 1440, height: 960 });

    parseMock.mockResolvedValue({ PixelXDimension: 6016, PixelYDimension: 4000 });
    expect(await extractImageMetadata(Buffer.from('x'))).toMatchObject({ width: 6016, height: 4000 });

    parseMock.mockResolvedValue({ ImageWidth: 800, ImageHeight: 600 });
    expect(await extractImageMetadata(Buffer.from('x'))).toMatchObject({ width: 800, height: 600 });
  });

  it('discards a non-positive or non-integer dimension rather than trusting it', async () => {
    parseMock.mockResolvedValue({ ExifImageWidth: 0, ExifImageHeight: 12.5 });
    const result = await extractImageMetadata(Buffer.from('x'));
    expect(result.width).toBeNull();
    expect(result.height).toBeNull();
  });

  it('returns no metadata, never throws, when exifr finds nothing at all', async () => {
    parseMock.mockResolvedValue(undefined);
    await expect(extractImageMetadata(Buffer.from('x'))).resolves.toEqual({
      width: null,
      height: null,
      capturedAt: null,
    });
  });

  it('returns no metadata, never throws, when exifr itself throws (corrupt or unrecognised bytes)', async () => {
    parseMock.mockRejectedValue(new Error('not a valid image'));
    await expect(extractImageMetadata(Buffer.from('garbage'))).resolves.toEqual({
      width: null,
      height: null,
      capturedAt: null,
    });
  });
});
