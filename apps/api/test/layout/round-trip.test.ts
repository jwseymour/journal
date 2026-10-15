import { describe, expect, it } from 'vitest';
import type { RawLayoutSpec } from '@journal/contract';
import { DEFAULT_ANALYSIS_LAYOUT } from '../../src/layout/defaults.js';
import { parseLayout } from '../../src/layout/parse.js';
import { serializeLayout } from '../../src/layout/serialize.js';

/**
 * The fidelity anchor for the layout language (`format.md` §8): canonical DSL
 * text survives a parse→serialise round trip byte for byte, and a spec
 * survives serialise→parse structurally. If either drifts, a stored
 * `derived/layouts/<id>.dsl` and the index's cached spec can disagree.
 */

/** Each is already in canonical form (2-space indent, one blank line between
 * sections, options in declared order, defaults omitted). */
const CANONICAL: Record<string, string> = {
  'the built-in default': DEFAULT_ANALYSIS_LAYOUT,

  'a window and a single section': `layout "Minimal"
  window: 90d

section "Just rhythms"
  panel presence
  panel register
`,

  'no window at all': `layout "No window"

section "Threads"
  panel questions
  panel todos
`,

  'options that are not the default': `layout "Tuned"

section "Reading"
  panel reviews
    medium: book
    limit: 40
  panel questions
    show: all
    limit: 12
  panel aging
    limit: 30
`,

  'list options and a quoted section title': `layout "Named"

section "Sleep & mood"
  panel register
    fields: sleep.hours, mood.rating
  panel presence
    metrics: sleep, mood
`,

  'a name containing a quote': `layout "The \\"big\\" board"

section "One"
  panel matrix
`,
};

describe('canonical DSL survives a parse → serialise round trip', () => {
  for (const [name, dsl] of Object.entries(CANONICAL)) {
    it(name, () => {
      const { spec, diagnostics } = parseLayout(dsl, 'analysis');
      expect(diagnostics).toEqual([]);
      expect(serializeLayout(spec)).toBe(dsl);
    });
  }
});

describe('serialise → parse is structurally stable', () => {
  for (const [name, dsl] of Object.entries(CANONICAL)) {
    it(name, () => {
      const first = parseLayout(dsl, 'analysis').spec;
      const second = parseLayout(serializeLayout(first), 'analysis').spec;
      expect(second).toEqual(first);
    });
  }
});

describe('serialisation is idempotent and normalises non-canonical input', () => {
  it('collapses extra blank lines, trims trailing spaces, drops a default-valued option', () => {
    const messy = [
      'layout "Messy"',
      '',
      '',
      'section "A"',
      '',
      '  panel questions',
      '    show: open', // equal to the default — should not survive
      '    limit: 5', // equal to the default — should not survive
      '  panel todos',
      '',
      '',
    ].join('\n');

    const { spec } = parseLayout(messy, 'analysis');
    const canonical = serializeLayout(spec);
    expect(canonical).toBe(`layout "Messy"

section "A"
  panel questions
  panel todos
`);
    // Idempotent: serialising the re-parsed canonical form changes nothing.
    expect(serializeLayout(parseLayout(canonical, 'analysis').spec)).toBe(canonical);
  });
});

describe('DEFAULT_ANALYSIS_LAYOUT', () => {
  it('parses with no diagnostics and names every section the pre-M20 page had', () => {
    const { spec, diagnostics } = parseLayout(DEFAULT_ANALYSIS_LAYOUT, 'analysis');
    expect(diagnostics).toEqual([]);
    expect(spec.sections.map((s) => s.title)).toEqual(['Rhythms', 'Tallies', 'Threads']);
    expect(spec.window).toEqual({ days: 30 });
  });

  it('lists the 14 panels in DEFAULT_ORDER, breakdown split into breakdown + correlation', () => {
    const { spec } = parseLayout(DEFAULT_ANALYSIS_LAYOUT, 'analysis');
    const panels = spec.sections.flatMap((s) => s.panels.map((p) => p.view));
    expect(panels).toEqual([
      'presence',
      'register',
      'horizon',
      'matrix',
      'breakdown',
      'correlation',
      'reviews',
      'rating-distribution',
      'rating-spread',
      'questions',
      'todos',
      'lists',
      'concepts',
      'aging',
    ]);
  });
});

// A spec the serialiser is handed directly (not via the parser) still comes
// back as canonical text.
it('serialises a hand-built spec into canonical form', () => {
  const spec: RawLayoutSpec = {
    version: 1,
    surface: 'analysis',
    name: 'Hand built',
    window: { days: 7 },
    sections: [
      {
        title: 'Only',
        panels: [
          { view: 'reviews', options: { medium: 'film', limit: 20 } }, // limit 20 is the default
          { view: 'aging', options: { limit: 12 } }, // 12 is the default
        ],
      },
    ],
  };
  expect(serializeLayout(spec)).toBe(`layout "Hand built"
  window: 7d

section "Only"
  panel reviews
    medium: film
  panel aging
`);
});
