'use client';

import { useEffect, useState } from 'react';
import type { MediaMetadata } from '@journal/contract';
import { ApiRequestError, listMedia, mediaFileUrl } from '@/lib/api';
import styles from './media-picker.module.css';

const LIMIT = 60;

/**
 * Choosing an existing photo from the media library to attach to an entry
 * (`plan.md` M19) — the picker side of `attachMediaToEntry`. Deliberately a
 * plain browse-and-click grid, the same shape `/photos` already renders,
 * not a search or filter surface: the library has no captions or albums to
 * search by yet (`app/photos/page.tsx`'s own comment).
 */
export function MediaPicker({ onSelect, onClose }: { onSelect: (mediaId: string) => void; onClose: () => void }) {
  const [media, setMedia] = useState<MediaMetadata[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listMedia({ limit: LIMIT })
      .then((page) => {
        setMedia(page.media);
        setNextCursor(page.nextCursor);
      })
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not load the library.'));
  }, []);

  const loadMore = () => {
    if (!nextCursor) return;
    listMedia({ limit: LIMIT, cursor: nextCursor })
      .then((page) => {
        setMedia((current) => [...(current ?? []), ...page.media]);
        setNextCursor(page.nextCursor);
      })
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.message : 'Could not load more.'));
  };

  return (
    <div className={styles.backdrop} role="presentation" onMouseDown={onClose}>
      <div
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-label="Attach a photo from the library"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className={styles.head}>
          <p className={styles.title}>Attach from library</p>
          <button type="button" className={styles.closeButton} onClick={onClose}>
            Close
          </button>
        </div>

        {error && <p className={styles.error}>{error}</p>}
        {media === null && !error && <p className={styles.hint}>Loading…</p>}
        {media && media.length === 0 && <p className={styles.empty}>Nothing in the library yet.</p>}

        {media && media.length > 0 && (
          <>
            <ul className={styles.grid}>
              {media
                .filter((item) => item.kind === 'image')
                .map((item) => (
                  <li key={item.id} className={styles.tile}>
                    <button
                      type="button"
                      className={styles.thumbButton}
                      onClick={() => onSelect(item.id)}
                      aria-label={`Attach ${item.originalFilename}`}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element -- served by the API, not Next's own image pipeline */}
                      <img src={mediaFileUrl(item.id)} alt={item.originalFilename} className={styles.thumb} loading="lazy" />
                    </button>
                  </li>
                ))}
            </ul>
            {nextCursor && (
              <button type="button" className={styles.loadMore} onClick={loadMore}>
                Load more
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
