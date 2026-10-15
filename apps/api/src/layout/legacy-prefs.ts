import { serializeLayout } from './serialize.js';
import type { RawLayoutPanel, RawLayoutSection, RawLayoutSpec } from './spec.js';

/**
 * One-shot translation of the pre-M20 client-only analysis customization
 * (`journal:analysis-prefs` in `localStorage`) into a durable layout
 * (`requirements.md` §8, M20). Runs once, server-side, when the frontend
 * first loads and finds non-default values in that key; the client then
 * drops it. Silent — no prompt (`design.md` §4).
 *
 * The old prefs could only reorder and hide panels within three fixed
 * registers and pick the presence-calendar metrics. Everything it could
 * express maps onto the layout language directly; anything it could not is
 * simply not carried.
 */

export interface LegacyAnalysisPrefs {
  windowDays?: number;
  order?: { rhythms?: string[]; tallies?: string[]; threads?: string[] };
  hidden?: string[];
  calendarMetrics?: string[];
}

const DEFAULT_WINDOW_DAYS = 30;

/** Old panel id → the view kind(s) it becomes. The old bundled "breakdowns"
 * panel is the one split (into `breakdown` + `correlation`), matching
 * `DEFAULT_ANALYSIS_LAYOUT`. */
const PANEL_MAP: Record<string, string[]> = {
  calendar: ['presence'],
  register: ['register'],
  horizon: ['horizon'],
  matrix: ['matrix'],
  breakdowns: ['breakdown', 'correlation'],
  reviews: ['reviews'],
  distribution: ['rating-distribution'],
  spread: ['rating-spread'],
  questions: ['questions'],
  todos: ['todos'],
  lists: ['lists'],
  concepts: ['concepts'],
  aging: ['aging'],
};

const DEFAULT_ORDER = {
  rhythms: ['calendar', 'register', 'horizon', 'matrix'],
  tallies: ['breakdowns', 'reviews', 'distribution', 'spread'],
  threads: ['questions', 'todos', 'lists', 'concepts', 'aging'],
} as const;

const REGISTER_TITLE = { rhythms: 'Rhythms', tallies: 'Tallies', threads: 'Threads' } as const;

/** Translate the prefs to canonical DSL text for a layout named `name`. */
export function legacyPrefsToSyntax(prefs: LegacyAnalysisPrefs, name: string): string {
  const hidden = new Set(prefs.hidden ?? []);

  const sections: RawLayoutSection[] = (['rhythms', 'tallies', 'threads'] as const).map((register) => {
    const order = prefs.order?.[register] ?? DEFAULT_ORDER[register];
    const panels: RawLayoutPanel[] = [];
    for (const oldId of order) {
      if (hidden.has(oldId)) continue;
      for (const view of PANEL_MAP[oldId] ?? []) {
        const options: RawLayoutPanel['options'] = {};
        if (view === 'presence' && (prefs.calendarMetrics?.length ?? 0) > 0) {
          options['metrics'] = [...prefs.calendarMetrics!];
        }
        panels.push({ view, options });
      }
    }
    return { title: REGISTER_TITLE[register], panels };
  });

  const spec: RawLayoutSpec = {
    version: 1,
    surface: 'analysis',
    name,
    window:
      prefs.windowDays !== undefined && prefs.windowDays !== DEFAULT_WINDOW_DAYS
        ? { days: prefs.windowDays }
        : null,
    sections: sections.filter((section) => section.panels.length > 0),
  };

  return serializeLayout(spec);
}
