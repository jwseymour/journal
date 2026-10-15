import { describe, expect, it } from 'vitest';
import type { ResourceCatalog } from '../../src/layout/catalog.js';
import { parseLayout } from '../../src/layout/parse.js';
import { resolveLayout } from '../../src/layout/resolve.js';

/**
 * Grammar-valid but catalog-checked: `resolveLayout` turns every panel into
 * either a runnable plan entry or an `ok: false` marker the frontend shows as
 * a quiet note. It never throws — the same degrade-don't-fail stance
 * `chat-orchestrator.ts` takes for an unresolvable reference.
 */

const catalog: ResourceCatalog = {
  surface: 'analysis',
  metrics: new Set(['sleep', 'exercise']),
  fields: new Set(['sleep.hours', 'exercise.distance_km']),
  reviewMedia: new Set(['book', 'film']),
  listTypes: new Set(['reading']),
  subjects: new Set(['stoicism']),
};

const plan = (dsl: string) => resolveLayout(parseLayout(dsl, 'analysis').spec, catalog);

describe('resolveLayout', () => {
  it('resolves a panel whose identifiers are all in the catalog', () => {
    const { sections } = plan('layout "A"\n\nsection "S"\n  panel register\n    fields: sleep.hours\n');
    expect(sections[0]?.panels[0]).toMatchObject({ ok: true, title: 'Register' });
  });

  it('degrades a ref option naming a metric that does not exist', () => {
    const { sections } = plan('layout "A"\n\nsection "S"\n  panel correlation\n    metric: cycling\n');
    expect(sections[0]?.panels[0]).toEqual({
      ok: false,
      title: 'Correlations',
      message: expect.stringContaining("No metric 'cycling'"),
    });
  });

  it('degrades a list option when any one identifier is missing, and names all missing ones', () => {
    const { sections } = plan(
      'layout "A"\n\nsection "S"\n  panel presence\n    metrics: sleep, running, swimming\n',
    );
    const panel = sections[0]?.panels[0];
    expect(panel).toMatchObject({ ok: false });
    if (panel && !panel.ok) {
      expect(panel.message).toContain("'running'");
      expect(panel.message).toContain("'swimming'");
      expect(panel.message).not.toContain("'sleep'");
    }
  });

  it('leaves an option-free panel (rating-spread) resolved', () => {
    const { sections } = plan('layout "A"\n\nsection "S"\n  panel rating-spread\n');
    expect(sections[0]?.panels[0]).toMatchObject({ ok: true, title: 'Ratings spread' });
  });

  it('carries the layout name through', () => {
    expect(plan('layout "My board"\n\nsection "S"\n  panel matrix\n').name).toBe('My board');
  });

  it('never throws on a fully broken reference set', () => {
    expect(() =>
      plan('layout "A"\n\nsection "S"\n  panel lists\n    type: ghosts\n  panel concepts\n    subject: nihilism\n'),
    ).not.toThrow();
  });
});
