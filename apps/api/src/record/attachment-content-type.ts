import { contentTypeForExtension } from './media-filename.js';

/**
 * The content type an attachment is served back with — inferred from its
 * filename's extension, since an attachment carries no stored content type
 * of its own (`format.md` §4 only ever names a bare filename). Reuses the
 * media library's own extension table (`plan.md` M19) for the extensions a
 * library-sourced attachment can carry, and adds `.wav` for the one other
 * kind of attachment this app produces today — a kept voice recording
 * (`requirements.md` §4.7).
 */
export function attachmentContentType(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot === -1) return 'application/octet-stream';
  const ext = filename.slice(dot).toLowerCase();
  if (ext === '.wav') return 'audio/wav';
  return contentTypeForExtension(ext) ?? 'application/octet-stream';
}
