'use client';

import { useEffect, useRef, useState } from 'react';
import { Markdown } from './markdown';
import styles from './composer.module.css';

/**
 * The text-editing surface, shared by the new-entry draft and editing an
 * existing entry (`design.md` §5.1, §5.2) — implemented once, so the scheme
 * cannot drift between the two places text gets typed.
 *
 * Owns exactly two things beyond the raw text: the source/rendered toggle
 * (`⌘⇧P`) and emphasis insertion (`⌘B` / `⌘I`, "inserts plain markdown, not a
 * format" — real `**`/`*` characters land in the text, there is no rich-text
 * state anywhere). Saving, finishing, and what the text actually means belong
 * to whichever page is using this, passed in as `onSave` / `onFinish`.
 */

interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSave?: () => void;
  onFinish?: () => void;
  disabled?: boolean;
  autoFocus?: boolean;
  ariaLabel: string;
}

function wrapSelection(textarea: HTMLTextAreaElement, marker: string): string {
  const { selectionStart, selectionEnd, value } = textarea;
  const before = value.slice(0, selectionStart);
  const selected = value.slice(selectionStart, selectionEnd);
  const after = value.slice(selectionEnd);
  const next = `${before}${marker}${selected}${marker}${after}`;

  // Restore a sensible cursor position on the next paint: around the
  // selection if there was one, otherwise between the two markers.
  requestAnimationFrame(() => {
    const cursor = selectionStart + marker.length;
    textarea.setSelectionRange(cursor, cursor + selected.length);
    textarea.focus();
  });

  return next;
}

export function Composer({ value, onChange, onSave, onFinish, disabled, autoFocus, ariaLabel }: ComposerProps) {
  const [rendered, setRendered] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // `⌘⇧P` works regardless of which of the two views currently has focus —
  // scoped to this component's lifetime, the same pattern the draft
  // lifecycle already uses for its own save shortcuts.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const withMeta = event.metaKey || event.ctrlKey;
      if (withMeta && event.shiftKey && event.key.toLowerCase() === 'p') {
        event.preventDefault();
        setRendered((v) => !v);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  if (rendered) {
    return (
      <div className={styles.rendered} aria-label={`${ariaLabel} — rendered`}>
        {value.trim() ? <Markdown>{value}</Markdown> : <p className={styles.empty}>Nothing written yet.</p>}
      </div>
    );
  }

  return (
    <textarea
      ref={textareaRef}
      className={styles.input}
      value={value}
      autoFocus={autoFocus}
      spellCheck
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        const withMeta = event.metaKey || event.ctrlKey;
        if (!withMeta) return;

        if (event.key === 'Enter' && onFinish) {
          event.preventDefault();
          onFinish();
        } else if (!event.shiftKey && event.key.toLowerCase() === 's' && onSave) {
          event.preventDefault();
          onSave();
        } else if (!event.shiftKey && event.key.toLowerCase() === 'b') {
          event.preventDefault();
          onChange(wrapSelection(event.currentTarget, '**'));
        } else if (!event.shiftKey && event.key.toLowerCase() === 'i') {
          event.preventDefault();
          onChange(wrapSelection(event.currentTarget, '*'));
        }
      }}
    />
  );
}
