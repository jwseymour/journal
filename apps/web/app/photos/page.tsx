'use client';

import { useEffect, useRef, useState } from 'react';
import type { MediaMetadata } from '@journal/contract';
import { formatCapturedDate } from '@/lib/format';
import { ApiRequestError, deleteMedia, listMedia, mediaFileUrl, uploadMedia } from '@/lib/api';
import styles from './page.module.css';

const LIMIT = 60;

/**
 * The media library (`requirements.md` — photo library, M19): bulk-uploaded
 * photos and video, independent of any entry. Attaching one to a specific
 * entry happens from that entry's own composer (`plan.md` M21), not here —
 * this page is purely the upload/browse/delete surface. No albums, no
 * captions, no cross-entry photo browsing beyond this grid.
 */
export default function PhotosPage() {
  const [media, setMedia] = useState<MediaMetadata[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = () => {
    listMedia({ limit: LIMIT })
      .then((page) => {
        setMedia(page.media);
        setNextCursor(page.nextCursor);
      })
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not load the library.'));
  };

  useEffect(load, []);

  const loadMore = () => {
    if (!nextCursor) return;
    listMedia({ limit: LIMIT, cursor: nextCursor })
      .then((page) => {
        setMedia((current) => [...(current ?? []), ...page.media]);
        setNextCursor(page.nextCursor);
      })
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not load more.'));
  };

  const uploadFiles = async (files: Iterable<File>): Promise<void> => {
    const list = Array.from(files);
    if (list.length === 0) return;

    setError(null);
    setUploadProgress({ done: 0, total: list.length });
    const uploaded: MediaMetadata[] = [];
    for (const file of list) {
      try {
        uploaded.push(await uploadMedia(file));
      } catch (cause) {
        setError(cause instanceof ApiRequestError ? cause.message : `Could not upload ${file.name}.`);
      }
      setUploadProgress((progress) => (progress ? { done: progress.done + 1, total: progress.total } : progress));
    }
    if (uploaded.length > 0) {
      setMedia((current) => [...uploaded, ...(current ?? [])]);
    }
    setUploadProgress(null);
  };

  const onFileInputChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
    if (event.target.files) void uploadFiles(event.target.files);
    event.target.value = '';
  };

  const onDrop = (event: React.DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer.files) void uploadFiles(event.dataTransfer.files);
  };

  const remove = (id: string): void => {
    setRemovingId(id);
    deleteMedia(id)
      .then(() => setMedia((current) => current?.filter((item) => item.id !== id) ?? current))
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not remove it.'))
      .finally(() => setRemovingId(null));
  };

  if (error && media === null) return <p className={styles.error}>{error}</p>;
  if (media === null) return <p className={styles.hint}>Loading…</p>;

  return (
    <div>
      <div
        className={dragging ? styles.dropzoneActive : styles.dropzone}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <p className={styles.dropzoneText}>Drop photos or videos here, or</p>
        <button type="button" className={styles.uploadButton} onClick={() => fileInputRef.current?.click()}>
          Choose files
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/heic,image/heif,image/webp,image/gif,video/mp4,video/quicktime,video/webm"
          multiple
          className={styles.hiddenInput}
          onChange={onFileInputChange}
        />
        {uploadProgress && (
          <p className={styles.progress}>
            Uploading {uploadProgress.done} of {uploadProgress.total}…
          </p>
        )}
      </div>

      {error && <p className={styles.error}>{error}</p>}

      {media.length === 0 ? (
        <p className={styles.empty}>Nothing uploaded yet.</p>
      ) : (
        <>
          <ul className={styles.grid}>
            {media.map((item) => (
              <li key={item.id} className={styles.tile}>
                <a href={mediaFileUrl(item.id)} target="_blank" rel="noreferrer" className={styles.thumbLink}>
                  {item.kind === 'video' ? (
                    <video src={mediaFileUrl(item.id)} className={styles.thumb} muted />
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element -- served by the API, not Next's own image pipeline
                    <img src={mediaFileUrl(item.id)} alt={item.originalFilename} className={styles.thumb} loading="lazy" />
                  )}
                </a>
                <div className={styles.caption}>
                  <span className={styles.captionDate}>
                    {item.capturedAt ? formatCapturedDate(item.capturedAt) : 'No date'}
                  </span>
                  <button
                    type="button"
                    className={styles.removeButton}
                    onClick={() => remove(item.id)}
                    disabled={removingId === item.id}
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
          {nextCursor && (
            <button type="button" className={styles.uploadButton} onClick={loadMore}>
              Load more
            </button>
          )}
        </>
      )}
    </div>
  );
}
