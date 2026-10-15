import { describe, expect, it } from 'vitest';
import type { ResourceCatalog } from '../../src/layout/catalog.js';
import { LayoutCompiler } from '../../src/layout/compile.js';
import { buildLayoutSpecSchema, specFromModelOutput } from '../../src/layout/schema.js';
import type { ExtractionRequest, ModelClient } from '../../src/model/model-client.js';

const catalog: ResourceCatalog = {
  surface: 'analysis',
  metrics: new Set(['sleep', 'exercise']),
  fields: new Set(['sleep.hours']),
  reviewMedia: new Set(['book']),
  listTypes: new Set(['reading']),
  subjects: new Set(['stoicism']),
};

class FakeModelClient implements ModelClient {
  last?: ExtractionRequest<unknown>;
  constructor(private readonly answer: unknown) {}
  async extract<T>(request: ExtractionRequest<T>): Promise<T> {
    this.last = request as ExtractionRequest<unknown>;
    return this.answer as T;
  }
}

class ThrowingModelClient implements ModelClient {
  async extract<T>(): Promise<T> {
    throw new Error('AI_GATEWAY_API_KEY is not set');
  }
}

describe('buildLayoutSpecSchema', () => {
  it('enum-constrains the view kind to the surface kit', () => {
    const schema = buildLayoutSpecSchema(catalog);
    const ok = schema.safeParse({ sections: [{ title: 'S', panels: [{ view: 'todos' }] }] });
    expect(ok.success).toBe(true);
    const bad = schema.safeParse({ sections: [{ title: 'S', panels: [{ view: 'not-a-panel' }] }] });
    expect(bad.success).toBe(false);
  });

  it('rejects an unknown extra field on a panel', () => {
    const schema = buildLayoutSpecSchema(catalog);
    expect(schema.safeParse({ sections: [{ title: 'S', panels: [{ view: 'todos', nonsense: 1 }] }] }).success).toBe(false);
  });
});

describe('specFromModelOutput', () => {
  it('keeps catalog-resolved identifiers and drops the rest into unresolved', () => {
    const { spec, syntax, unresolved } = specFromModelOutput(
      {
        window: { days: 45 },
        sections: [
          {
            title: 'Rhythm',
            panels: [
              { view: 'presence', metrics: ['sleep', 'cycling'] },
              { view: 'register', fields: ['sleep.hours', 'mood.rating'] },
              { view: 'reviews', medium: 'film' },
            ],
          },
        ],
      },
      catalog,
      'From prose',
    );

    expect(spec.name).toBe('From prose');
    expect(spec.window).toEqual({ days: 45 });
    expect(spec.sections[0]?.panels[0]?.options).toEqual({ metrics: ['sleep'] });
    expect(spec.sections[0]?.panels[1]?.options).toEqual({ fields: ['sleep.hours'] });
    expect(spec.sections[0]?.panels[2]?.options).toEqual({}); // 'film' is not a medium — dropped
    expect(unresolved).toEqual([
      expect.stringContaining('cycling'),
      expect.stringContaining('mood.rating'),
      expect.stringContaining('film'),
    ]);
    // Serialises to canonical DSL.
    expect(syntax).toContain('layout "From prose"');
    expect(syntax).toContain('  panel presence\n    metrics: sleep');
  });

  it('drops a section left with no usable panels', () => {
    const { spec } = specFromModelOutput(
      { sections: [{ title: 'Empty', panels: [{ view: 'presence', metrics: ['ghost'] }] }] },
      catalog,
      'x',
    );
    // presence with only a bogus metric still renders (metrics option just
    // becomes empty) — so the panel survives; the section is kept.
    expect(spec.sections).toHaveLength(1);
    expect(spec.sections[0]?.panels[0]?.options).toEqual({});
  });
});

describe('LayoutCompiler', () => {
  it('compiles prose into canonical DSL, re-validating every identifier', async () => {
    const model = new FakeModelClient({
      sections: [{ title: 'Only', panels: [{ view: 'correlation', metric: 'exercise' }, { view: 'correlation', metric: 'rowing' }] }],
    });
    const compiler = new LayoutCompiler(model);
    const { syntax, unresolved } = await compiler.compile('correlations for exercise and rowing', catalog, 'Mine');

    expect(syntax).toContain('layout "Mine"');
    expect(syntax).toContain('  panel correlation\n    metric: exercise');
    expect(unresolved).toEqual([expect.stringContaining('rowing')]);
    // The system prompt lists the real catalog, never invents identifiers.
    expect(model.last?.system).toContain('sleep, exercise');
  });

  it('passes the current syntax through for a revise-in-place compile', async () => {
    const model = new FakeModelClient({ sections: [{ title: 'S', panels: [{ view: 'todos' }] }] });
    const compiler = new LayoutCompiler(model);
    await compiler.compile('just todos now', catalog, 'Mine', 'layout "Mine"\n\nsection "Old"\n  panel questions\n');
    expect(model.last?.prompt).toContain('Here is the current layout:');
    expect(model.last?.prompt).toContain('panel questions');
  });

  it('turns any model failure into layout_compile_failed (503), never blocking hand-edit', async () => {
    const compiler = new LayoutCompiler(new ThrowingModelClient());
    await expect(compiler.compile('anything', catalog, 'Mine')).rejects.toMatchObject({
      code: 'layout_compile_failed',
      status: 503,
    });
  });
});
