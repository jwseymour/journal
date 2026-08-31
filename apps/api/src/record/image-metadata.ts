import exifr from 'exifr';

/**
 * What a photo's own EXIF carries that this app cares about.
 *
 * `reviveValues: false` is deliberate: exifr's default converts date tags
 * into `Date` instances by interpreting EXIF's naked wall-clock digits in
 * *this process's own timezone* — silently inventing an offset EXIF never
 * recorded. Reading the raw `"YYYY:MM:DD HH:MM:SS"` string instead and
 * parsing it by hand keeps `capturedAt` exactly as ambiguous as the format
 * itself, which is the honest thing to store (`record/time.ts`'s own
 * distinction between the wall clock and the instant — EXIF only ever gives
 * the former).
 */

export interface ImageMetadata {
  width: number | null;
  height: number | null;
  /** `DateTimeOriginal`, falling back to `CreateDate` — local wall-clock
   * digits, no offset. `null` if the file carried neither. */
  capturedAt: string | null;
}

const EXIF_DATE = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

function normaliseExifDate(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const match = EXIF_DATE.exec(raw);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}`;
}

function toPositiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

const NO_METADATA: ImageMetadata = { width: null, height: null, capturedAt: null };

/**
 * Reads what EXIF an image carries. Never throws — a file with no EXIF, or
 * one exifr cannot parse at all (corrupt, or simply not a format it
 * understands), yields `NO_METADATA` rather than failing the upload: a
 * photo with no extractable metadata is still worth storing
 * (`requirements.md` §4.6's stance on attachments, applied here — the
 * binary itself is never the thing at risk).
 */
export async function extractImageMetadata(data: Buffer): Promise<ImageMetadata> {
  let tags: Record<string, unknown> | null;
  try {
    tags =
      (await exifr.parse(data, {
        reviveValues: false,
        pick: [
          'DateTimeOriginal',
          'CreateDate',
          'ExifImageWidth',
          'ExifImageHeight',
          'PixelXDimension',
          'PixelYDimension',
          'ImageWidth',
          'ImageHeight',
        ],
      })) ?? null;
  } catch {
    tags = null;
  }

  if (!tags) return NO_METADATA;

  const capturedAt = normaliseExifDate(tags['DateTimeOriginal']) ?? normaliseExifDate(tags['CreateDate']);
  const width = toPositiveInt(tags['ExifImageWidth'] ?? tags['PixelXDimension'] ?? tags['ImageWidth']);
  const height = toPositiveInt(tags['ExifImageHeight'] ?? tags['PixelYDimension'] ?? tags['ImageHeight']);

  return { width, height, capturedAt };
}
