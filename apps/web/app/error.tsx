'use client';

import { Notice } from '@/components/notice';

/**
 * The last resort. Plain, and it does not apologise at length
 * (`design.md` §4).
 *
 * Nothing here can have destroyed an entry: this frontend only ever reads, and
 * the one write it performs reports its own failure without clearing the text.
 */
export default function Error({ reset }: { error: Error; reset: () => void }) {
  return (
    <Notice title="Something went wrong." tone="danger">
      <button type="button" onClick={reset}>
        Try again
      </button>
    </Notice>
  );
}
