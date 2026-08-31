import { describe, expect, it } from 'vitest';
import {
  contentTypeForExtension,
  isSupportedMediaContentType,
  mediaKindOf,
  mediaRelativePath,
  mediaSidecarPath,
} from '../../src/record/media-filename.js';

describe('media-filename', () => {
  it('accepts exactly the documented content types', () => {
    for (const type of [
      'image/jpeg',
      'image/png',
      'image/heic',
      'image/heif',
      'image/webp',
      'image/gif',
      'video/mp4',
      'video/quicktime',
      'video/webm',
    ]) {
      expect(isSupportedMediaContentType(type)).toBe(true);
    }
    for (const type of ['image/svg+xml', 'application/pdf', 'audio/mpeg', '', 'image/jpg']) {
      expect(isSupportedMediaContentType(type)).toBe(false);
    }
  });

  it('classifies kind by the content type prefix', () => {
    expect(mediaKindOf('image/jpeg')).toBe('image');
    expect(mediaKindOf('image/heic')).toBe('image');
    expect(mediaKindOf('video/mp4')).toBe('video');
    expect(mediaKindOf('video/quicktime')).toBe('video');
  });

  it('builds the binary path from id and content type', () => {
    expect(mediaRelativePath('01ARZ3NDEKTSV4RRFFQ69G5FAV', 'image/jpeg')).toBe(
      'media/01ARZ3NDEKTSV4RRFFQ69G5FAV.jpg',
    );
    expect(mediaRelativePath('01ARZ3NDEKTSV4RRFFQ69G5FAV', 'video/quicktime')).toBe(
      'media/01ARZ3NDEKTSV4RRFFQ69G5FAV.mov',
    );
  });

  it('throws for an unsupported content type rather than inventing an extension', () => {
    expect(() => mediaRelativePath('01ARZ3NDEKTSV4RRFFQ69G5FAV', 'audio/mpeg')).toThrow();
  });

  it('builds the sidecar path from id alone', () => {
    expect(mediaSidecarPath('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe('media/01ARZ3NDEKTSV4RRFFQ69G5FAV.json');
  });

  it('recovers the content type from a scanned extension, and null for an unknown one', () => {
    expect(contentTypeForExtension('.jpg')).toBe('image/jpeg');
    expect(contentTypeForExtension('.mov')).toBe('video/quicktime');
    expect(contentTypeForExtension('.json')).toBeNull();
    expect(contentTypeForExtension('.txt')).toBeNull();
  });
});
