'use client';

import { useCallback, useRef, useState } from 'react';
import type { LayoutDiagnostic, LayoutSummary, LayoutSurface } from '@journal/contract';
import {
  ApiRequestError,
  compileLayout,
  createLayout,
  deleteLayout,
  parseLayoutSyntax,
  setDefaultLayout,
  updateLayout,
} from '@/lib/api';
import styles from './layout-controls.module.css';

const PARSE_DEBOUNCE_MS = 400;

/**
 * The Customize disclosure's layout controls (`design.md` §5.3.2, M20): pick
 * a named layout, hand-edit its DSL with live validation, save. Every
 * judgement — parse, validate, canonicalise — is the API's
 * (`requirements.md` §7.1); this component edits text and reports what the
 * server says about it.
 *
 * The caller gives this a `key` tied to the selected layout, so switching
 * layouts remounts it and the editor re-seeds from `currentSyntax` with no
 * syncing effect.
 */
export function LayoutControls({
  surface,
  layouts,
  selectedId,
  currentSyntax,
  onSelect,
  onChanged,
}: {
  surface: LayoutSurface;
  layouts: LayoutSummary[];
  selectedId: string | null;
  currentSyntax: string;
  onSelect: (id: string | null) => void;
  onChanged: (next?: { selectId?: string | null }) => void;
}) {
  const selected = layouts.find((l) => l.id === selectedId) ?? null;

  const [draft, setDraft] = useState(currentSyntax);
  const [dirty, setDirty] = useState(false);
  const [diagnostics, setDiagnostics] = useState<LayoutDiagnostic[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [prose, setProse] = useState('');
  const [compiling, setCompiling] = useState(false);
  const [unresolved, setUnresolved] = useState<string[]>([]);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const validate = useCallback(
    (text: string) => {
      if (debounce.current) clearTimeout(debounce.current);
      debounce.current = setTimeout(() => {
        parseLayoutSyntax(surface, text)
          .then((result) => setDiagnostics(result.diagnostics))
          .catch(() => setDiagnostics([]));
      }, PARSE_DEBOUNCE_MS);
    },
    [surface],
  );

  const onDraftChange = (text: string) => {
    setDraft(text);
    setDirty(true);
    setStatus(null);
    validate(text);
  };

  const guardConflict = (error: unknown) => {
    if (error instanceof ApiRequestError && error.code === 'edit_conflict') {
      setStatus('This layout changed elsewhere. Reload to pick up the newer version.');
    } else if (error instanceof ApiRequestError) {
      setStatus(error.message);
    } else {
      setStatus('Could not save.');
    }
  };

  const save = () => {
    if (!selected) return;
    updateLayout(selected.id, { syntax: draft, expectedUpdatedAt: selected.updatedAt })
      .then((layout) => {
        setDirty(false);
        setDiagnostics([]);
        setStatus('Saved.');
        onChanged({ selectId: layout.id });
      })
      .catch(guardConflict);
  };

  const saveAsNew = () => {
    const name = window.prompt('Name for the new layout')?.trim();
    if (!name) return;
    createLayout({ surface, name, syntax: draft })
      .then((layout) => {
        setDirty(false);
        setStatus('Saved as a new layout.');
        onChanged({ selectId: layout.id });
      })
      .catch(guardConflict);
  };

  const makeDefault = () => {
    if (!selected || selected.isDefault) return;
    setDefaultLayout(selected.id)
      .then(() => {
        setStatus('Set as the default.');
        onChanged();
      })
      .catch(guardConflict);
  };

  const generate = () => {
    if (prose.trim() === '' || compiling) return;
    setCompiling(true);
    setStatus(null);
    compileLayout({
      surface,
      prose: prose.trim(),
      name: selected?.name ?? 'Untitled',
      currentSyntax: draft,
    })
      .then((result) => {
        setDraft(result.syntax);
        setDirty(true);
        setDiagnostics([]);
        setUnresolved(result.unresolved);
        setStatus('Generated — review the syntax below, then save.');
      })
      .catch((error: unknown) => {
        if (error instanceof ApiRequestError && error.code === 'layout_compile_failed') {
          setStatus('The AI is not configured here — edit the syntax by hand below.');
        } else {
          setStatus(error instanceof ApiRequestError ? error.message : 'Could not generate a layout.');
        }
      })
      .finally(() => setCompiling(false));
  };

  const remove = () => {
    if (!selected) return;
    if (!window.confirm(`Delete the layout “${selected.name}”?`)) return;
    deleteLayout(selected.id)
      .then(() => {
        setStatus(null);
        onChanged({ selectId: null });
      })
      .catch(guardConflict);
  };

  return (
    <div className={styles.panel}>
      <div className={styles.field}>
        <p className={styles.label}>Layout</p>
        <div className={styles.row}>
          <select
            className={styles.select}
            value={selectedId ?? ''}
            onChange={(event) => onSelect(event.target.value === '' ? null : event.target.value)}
          >
            <option value="">Built-in default</option>
            {layouts.map((layout) => (
              <option key={layout.id} value={layout.id}>
                {layout.name}
                {layout.isDefault ? ' (default)' : ''}
              </option>
            ))}
          </select>
          <button type="button" className={styles.button} onClick={makeDefault} disabled={!selected || selected.isDefault}>
            Set as default
          </button>
          <button type="button" className={styles.button} onClick={remove} disabled={!selected}>
            Delete
          </button>
        </div>
      </div>

      <div className={styles.field}>
        <p className={styles.label}>Describe an arrangement</p>
        <p className={styles.note}>
          A sentence or two about how you want this page laid out. Generating fills the syntax below
          — nothing is saved until you save it.
        </p>
        <textarea
          className={styles.prose}
          spellCheck={false}
          rows={2}
          placeholder="e.g. Put reviews and ratings first, then the metric calendars, and drop the correlations."
          value={prose}
          onChange={(event) => setProse(event.target.value)}
        />
        <div className={styles.row}>
          <button
            type="button"
            className={styles.button}
            onClick={generate}
            disabled={compiling || prose.trim() === ''}
          >
            {compiling ? 'Generating…' : 'Generate'}
          </button>
        </div>
        {unresolved.length > 0 && (
          <ul className={styles.diagnostics}>
            {unresolved.map((note, i) => (
              <li key={i} className={styles.note}>
                Left out: {note}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className={styles.field}>
        <p className={styles.label}>Syntax</p>
        <p className={styles.note}>
          {selected
            ? `Editing “${selected.name}”. Rename by changing the layout "…" line.`
            : 'The built-in layout. Save it as a new layout to start editing.'}
        </p>
        <textarea
          className={styles.editor}
          spellCheck={false}
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
        />
        {diagnostics.length > 0 && (
          <ul className={styles.diagnostics}>
            {diagnostics.map((diagnostic, i) => (
              <li key={i} className={styles.diagnostic}>
                Line {diagnostic.line}: {diagnostic.message}
              </li>
            ))}
          </ul>
        )}
        <div className={styles.row}>
          <button
            type="button"
            className={styles.button}
            onClick={save}
            disabled={!selected || !dirty || diagnostics.length > 0}
          >
            Save
          </button>
          <button
            type="button"
            className={styles.button}
            onClick={saveAsNew}
            disabled={diagnostics.length > 0}
          >
            Save as new
          </button>
          {status && <span className={status === 'Saved.' || status.startsWith('Saved') || status.startsWith('Set') ? styles.saved : styles.diagnostic}>{status}</span>}
        </div>
      </div>
    </div>
  );
}
