'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { transcribe as transcribeAudio } from '@/lib/api';
import { encodeWav } from '@/lib/wav';
import { VoiceRecorder } from '@/lib/recorder';
import { Markdown } from './markdown';
import styles from './composer.module.css';

/**
 * The text-editing surface, shared by the new-entry draft and editing an
 * existing entry (`design.md` §5.1, §5.2) — implemented once, so the scheme
 * cannot drift between the two places text gets typed.
 *
 * Owns four things beyond the raw text: the source/rendered toggle (`⌘⇧P`),
 * emphasis insertion (`⌘B` / `⌘I`, "inserts plain markdown, not a format" —
 * real `**`/`*` characters land in the text, there is no rich-text state
 * anywhere), and voice (`⌘⌥R`). Saving, finishing, and what the text actually
 * means belong to whichever page is using this, passed in as `onSave` /
 * `onFinish`.
 *
 * **The transcript is always produced and inserted; keeping the audio is a
 * separate, optional, additional step** (`requirements.md` §4.7). Composer
 * handles recording and transcription entirely on its own — neither needs an
 * entry to exist. Keeping the audio does need one (attachments live beside a
 * real entry file), which Composer has no notion of, so that step is
 * delegated to `onAttachAudio`, provided by whichever page knows how to make
 * sure an entry exists first.
 */

interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSave?: () => void;
  onFinish?: () => void;
  /** Uploads the recording and resolves to the relative link to insert. Voice
   * recording still works without this — the transcript is always inserted
   * regardless — but "keep audio" has nothing to do without it. */
  onAttachAudio?: (blob: Blob, suggestedFilename: string) => Promise<string>;
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

/** Inserts `text` at `position` in `value`, padding with a space on either
 * side only where the neighbouring character actually needs it. */
function insertAt(value: string, position: number, text: string): string {
  const before = value.slice(0, position);
  const after = value.slice(position);
  const leadingSpace = before.length > 0 && !/\s$/.test(before) ? ' ' : '';
  const trailingSpace = after.length > 0 && !/^\s/.test(after) ? ' ' : '';
  return `${before}${leadingSpace}${text}${trailingSpace}${after}`;
}

type RecordingState =
  | { phase: 'idle' }
  | { phase: 'recording' }
  | { phase: 'transcribing' }
  | { phase: 'ready-to-attach'; blob: Blob; sampleRate: number }
  | { phase: 'error'; message: string };

export function Composer({
  value,
  onChange,
  onSave,
  onFinish,
  onAttachAudio,
  disabled,
  autoFocus,
  ariaLabel,
}: ComposerProps) {
  const [rendered, setRendered] = useState(false);
  const [recording, setRecording] = useState<RecordingState>({ phase: 'idle' });
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const recorderRef = useRef<VoiceRecorder | null>(null);
  const insertPositionRef = useRef<number | null>(null);

  const startRecording = useCallback(async () => {
    if (recording.phase === 'recording') return;
    insertPositionRef.current = textareaRef.current?.selectionStart ?? value.length;
    try {
      const recorder = new VoiceRecorder();
      await recorder.start();
      recorderRef.current = recorder;
      setRecording({ phase: 'recording' });
    } catch {
      setRecording({ phase: 'error', message: 'Could not access the microphone.' });
    }
  }, [recording.phase, value.length]);

  const stopRecording = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    recorderRef.current = null;
    setRecording({ phase: 'transcribing' });

    try {
      const { samples, sampleRate } = await recorder.stop();
      const { text } = await transcribeAudio(samples, sampleRate);
      const position = insertPositionRef.current ?? value.length;
      onChange(insertAt(value, position, text));

      if (onAttachAudio) {
        setRecording({ phase: 'ready-to-attach', blob: encodeWav(samples, sampleRate), sampleRate });
      } else {
        setRecording({ phase: 'idle' });
      }
    } catch {
      setRecording({ phase: 'error', message: 'The recording could not be transcribed.' });
    }
  }, [onAttachAudio, onChange, value]);

  const keepAudio = useCallback(async () => {
    if (recording.phase !== 'ready-to-attach' || !onAttachAudio) return;
    const { blob } = recording;
    setRecording({ phase: 'transcribing' }); // reuse as a generic "working" state
    try {
      const filename = `voice-${new Date().toISOString().replace(/[:.]/g, '')}.wav`;
      const link = await onAttachAudio(blob, filename);
      onChange(insertAt(value, value.length, `[voice recording](${link})`));
      setRecording({ phase: 'idle' });
    } catch {
      setRecording({ phase: 'error', message: 'Could not save the audio as an attachment.' });
    }
  }, [recording, onAttachAudio, onChange, value]);

  // `⌘⌥R` works regardless of which view currently has focus, the same as
  // `⌘⇧P` below — scoped to this component's lifetime.
  //
  // `event.code`, not `event.key`: Option held with a letter remaps `.key` on
  // a Mac keyboard (Option+R types "®" on a US layout), the same class of
  // gotcha `lib/keyboard.tsx` hit and fixed for Shift+Backslash. `.code`
  // reports the physical key regardless of what character the modifier would
  // otherwise produce.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const withMeta = event.metaKey || event.ctrlKey;
      if (withMeta && event.altKey && event.code === 'KeyR') {
        event.preventDefault();
        if (recorderRef.current) void stopRecording();
        else void startRecording();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [startRecording, stopRecording]);

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

  const status = (
    <RecordingStatus state={recording} onKeepAudio={() => void keepAudio()} />
  );

  if (rendered) {
    return (
      <>
        <div className={styles.rendered} aria-label={`${ariaLabel} — rendered`}>
          {value.trim() ? <Markdown>{value}</Markdown> : <p className={styles.empty}>Nothing written yet.</p>}
        </div>
        {status}
      </>
    );
  }

  return (
    <>
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
      {status}
    </>
  );
}

function RecordingStatus({ state, onKeepAudio }: { state: RecordingState; onKeepAudio: () => void }) {
  if (state.phase === 'idle') return null;

  if (state.phase === 'recording') {
    return (
      <p className={styles.recording} role="status">
        <span className={styles.recordingDot} aria-hidden="true" />
        Recording — <kbd>⌘⌥R</kbd> to stop
      </p>
    );
  }

  if (state.phase === 'transcribing') {
    return (
      <p className={styles.recordingMuted} role="status">
        Transcribing…
      </p>
    );
  }

  if (state.phase === 'ready-to-attach') {
    return (
      <p className={styles.recordingMuted} role="status">
        Transcript added.{' '}
        <button type="button" className={styles.keepAudioButton} onClick={onKeepAudio}>
          Keep the audio too
        </button>
      </p>
    );
  }

  return (
    <p className={styles.recordingError} role="alert">
      {state.message}
    </p>
  );
}
