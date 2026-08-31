/**
 * The recording time embedded in an MP4/MOV container's `moov/mvhd` box —
 * ISO/IEC 14496-12 §8.2.2 for MP4, the identical layout QuickTime's own file
 * format uses for MOV.
 *
 * Hand-rolled rather than pulled from a dependency, the same call
 * `record/id.ts` makes for ULIDs: this is a small, frozen, fully specified
 * binary layout — a handful of big-endian integers behind a box header —
 * not something worth a library for. (No general-purpose EXIF/metadata
 * library in the npm ecosystem actually reads this — `exifr`,
 * `image-metadata.ts`'s dependency, covers still images only.)
 *
 * Unlike EXIF's `DateTimeOriginal` (naked wall-clock digits, no offset —
 * see `image-metadata.ts`), `mvhd`'s creation time is a genuine instant:
 * seconds since 1904-01-01T00:00:00 **UTC**. But nothing in the container
 * records *where* it was recorded, so the calendar day this yields is the
 * day in UTC, not necessarily the day at the camera's own location — a
 * known, disclosed approximation for this first step, not a bug.
 * Verified live against a real `.mov` file's `moov/mvhd` box.
 */

const MAC_EPOCH_OFFSET_SECONDS = 2_082_844_800; // 1904-01-01 -> 1970-01-01

interface Box {
  type: string;
  bodyStart: number;
  end: number;
}

function readBoxHeader(buf: Buffer, offset: number): Box | null {
  if (offset + 8 > buf.length) return null;
  let size = buf.readUInt32BE(offset);
  const type = buf.toString('ascii', offset + 4, offset + 8);
  let headerSize = 8;

  if (size === 1) {
    // 64-bit "largesize" — the true size follows immediately as an 8-byte field.
    if (offset + 16 > buf.length) return null;
    const high = buf.readUInt32BE(offset + 8);
    const low = buf.readUInt32BE(offset + 12);
    size = high * 2 ** 32 + low;
    headerSize = 16;
  } else if (size === 0) {
    // "extends to the end of the file" — only legal for the last top-level box.
    size = buf.length - offset;
  }

  if (size < headerSize || offset + size > buf.length) return null;
  return { type, bodyStart: offset + headerSize, end: offset + size };
}

/** The first child box of `type` directly inside `[start, end)` — `mvhd` is
 * always a direct child of `moov`, never nested deeper, so one level of
 * scanning is all either lookup needs. */
function findBox(buf: Buffer, type: string, start: number, end: number): Box | null {
  let offset = start;
  while (offset < end) {
    const box = readBoxHeader(buf, offset);
    if (!box) return null;
    if (box.type === type) return box;
    offset = box.end;
  }
  return null;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * `moov/mvhd`'s creation time, as the same naive
 * `"YYYY-MM-DDTHH:MM:SS"` shape `image-metadata.ts` produces (so both feed
 * `MediaMetadata.capturedAt` uniformly) — read out in UTC, per the caveat
 * above. `null` if the container has no `moov`/`mvhd` at all, the field was
 * never set (all-zero, which real cameras do write), or the bytes don't
 * parse as a well-formed box tree — never thrown, the same "a file with no
 * extractable metadata is still worth storing" stance
 * `extractImageMetadata` takes.
 */
export function extractVideoCapturedAt(buf: Buffer): string | null {
  try {
    const moov = findBox(buf, 'moov', 0, buf.length);
    if (!moov) return null;
    const mvhd = findBox(buf, 'mvhd', moov.bodyStart, moov.end);
    if (!mvhd) return null;

    const version = buf.readUInt8(mvhd.bodyStart);
    let creationSeconds: number;
    if (version === 1) {
      if (mvhd.bodyStart + 12 > buf.length) return null;
      const high = buf.readUInt32BE(mvhd.bodyStart + 4);
      const low = buf.readUInt32BE(mvhd.bodyStart + 8);
      creationSeconds = high * 2 ** 32 + low;
    } else {
      if (mvhd.bodyStart + 8 > buf.length) return null;
      creationSeconds = buf.readUInt32BE(mvhd.bodyStart + 4);
    }

    if (creationSeconds === 0) return null;
    const epochMs = (creationSeconds - MAC_EPOCH_OFFSET_SECONDS) * 1000;
    if (!Number.isFinite(epochMs) || epochMs < 0) return null;

    const date = new Date(epochMs);
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
  } catch {
    return null;
  }
}
