import { extractImageMetadata } from './image-metadata.js';
import { mediaKindOf } from './media-filename.js';
import { extractVideoCapturedAt } from './video-metadata.js';

/** What both `image-metadata.ts` and `video-metadata.ts` can recover from a
 * file's own bytes — everything else `MediaMetadata` carries
 * (`originalFilename`, `uploadedAt`) is known only at upload time and lives
 * in the sidecar (`media-filename.ts`'s own comment). */
export interface ExtractedMediaMetadata {
  width: number | null;
  height: number | null;
  capturedAt: string | null;
}

/** Dispatches on `contentType` alone — the one place a caller needs to know
 * that images and video are read by two entirely different parsers. */
export async function extractMediaMetadata(data: Buffer, contentType: string): Promise<ExtractedMediaMetadata> {
  if (mediaKindOf(contentType) === 'video') {
    return { width: null, height: null, capturedAt: extractVideoCapturedAt(data) };
  }
  return extractImageMetadata(data);
}
