import { z } from 'zod';
import type { RawLayoutPanel, RawLayoutSpec } from '@journal/contract';
import { catalogHas, domainLabel, type ResourceCatalog } from './catalog.js';
import { serializeLayout } from './serialize.js';
import { viewsForSurface, type OptionDef } from './spec.js';

/**
 * The closed vocabulary the layout compiler (`compile.ts`) lets the model
 * fill — built from the same `ANALYSIS_VIEWS` table the parser and serialiser
 * read, plus the live catalog, exactly as `temporal-metrics.ts`'s
 * `buildMetricSchema` builds a Zod schema from live DB state. The model never
 * emits DSL or code: it fills this shape, every `view` is enum-constrained to
 * a real kind, and every identifier it returns is re-checked against the
 * catalog afterwards (`opinion-summarizer.ts`'s stance) before anything is
 * serialised.
 */

/** One panel as the model returns it: a view kind plus a flat bag of the
 * option values any view might take. Which of these actually apply is
 * decided per-view when the spec is assembled. */
function buildPanelSchema(viewKinds: readonly string[]) {
  return z
    .object({
      view: z.enum(viewKinds as [string, ...string[]]).describe('The panel kind.'),
      metrics: z
        .array(z.string())
        .optional()
        .describe('For presence / matrix: the metric names to show. Omit for "all".'),
      fields: z
        .array(z.string())
        .optional()
        .describe('For register / horizon: metric fields as "metric.fieldKey". Omit for "all".'),
      metric: z.string().optional().describe('For breakdown / correlation: the single metric to focus on.'),
      medium: z.string().optional().describe('For reviews: the single review medium to focus on.'),
      type: z.string().optional().describe('For lists: the single list type to focus on.'),
      subject: z.string().optional().describe('For concepts: the single concept subject to focus on.'),
      show: z.enum(['open', 'all']).optional().describe('For questions / todos: which items. Default "open".'),
      limit: z.number().int().positive().max(200).optional().describe('For questions / todos / reviews / aging: row cap.'),
    })
    .strict();
}

export function buildLayoutSpecSchema(catalog: ResourceCatalog) {
  const viewKinds = viewsForSurface(catalog.surface).map((view) => view.kind);
  return z
    .object({
      window: z
        .object({ days: z.number().int().positive() })
        .nullable()
        .optional()
        .describe('The default time window in days, or null to leave it to the caller.'),
      sections: z
        .array(
          z
            .object({
              title: z.string().min(1).describe('A short heading for this group of panels.'),
              panels: z.array(buildPanelSchema(viewKinds)).min(1),
            })
            .strict(),
        )
        .min(1),
    })
    .strict();
}

export type LayoutSpecModelOutput = z.infer<ReturnType<typeof buildLayoutSpecSchema>>;

/** The option key on a `ViewDef` that a given model-output field feeds. */
const FIELD_TO_OPTION: Record<string, string> = {
  metrics: 'metrics',
  fields: 'fields',
  metric: 'metric',
  medium: 'medium',
  type: 'type',
  subject: 'subject',
  show: 'show',
  limit: 'limit',
};

/**
 * Turn validated model output into a `RawLayoutSpec` + canonical DSL, checking
 * every referenced identifier against the catalog. Anything that does not
 * resolve is dropped from the panel and named in `unresolved` — surfaced to
 * the user plainly rather than silently kept or silently lost
 * (`requirements.md` §6.1).
 */
export function specFromModelOutput(
  output: LayoutSpecModelOutput,
  catalog: ResourceCatalog,
  name: string,
): { spec: RawLayoutSpec; syntax: string; unresolved: string[] } {
  const views = new Map(viewsForSurface(catalog.surface).map((view) => [view.kind, view]));
  const unresolved: string[] = [];

  const sections = output.sections.map((section) => ({
    title: section.title,
    panels: section.panels
      .map((panel): RawLayoutPanel | null => {
        const view = views.get(panel.view);
        if (!view) return null; // enum makes this unreachable, but never trust it
        const options: RawLayoutPanel['options'] = {};

        for (const def of view.options) {
          const modelKey = Object.keys(FIELD_TO_OPTION).find((key) => FIELD_TO_OPTION[key] === def.key);
          if (!modelKey) continue;
          const raw = (panel as Record<string, unknown>)[modelKey];
          if (raw === undefined) continue;
          const coerced = coerceOptionValue(def, raw, catalog, unresolved);
          if (coerced !== undefined) options[def.key] = coerced;
        }

        return { view: panel.view, options };
      })
      .filter((panel): panel is RawLayoutPanel => panel !== null),
  }));

  const spec: RawLayoutSpec = {
    version: 1,
    surface: catalog.surface,
    name,
    window: output.window ?? null,
    sections: sections.filter((section) => section.panels.length > 0),
  };
  return { spec, syntax: serializeLayout(spec), unresolved };
}

function coerceOptionValue(
  def: OptionDef,
  raw: unknown,
  catalog: ResourceCatalog,
  unresolved: string[],
): RawLayoutPanel['options'][string] | undefined {
  switch (def.kind) {
    case 'int':
      return typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? raw : undefined;
    case 'enum':
      return typeof raw === 'string' && def.values?.includes(raw) ? raw : undefined;
    case 'ref': {
      if (typeof raw !== 'string' || def.of === undefined) return undefined;
      if (catalogHas(catalog, def.of, raw)) return raw;
      unresolved.push(`no ${domainLabel(def.of)} “${raw}”`);
      return undefined;
    }
    case 'list': {
      if (!Array.isArray(raw) || def.of === undefined) return undefined;
      const kept = raw.filter((item): item is string => typeof item === 'string' && catalogHas(catalog, def.of!, item));
      for (const item of raw) {
        if (typeof item === 'string' && !kept.includes(item)) unresolved.push(`no ${domainLabel(def.of)} “${item}”`);
      }
      return kept.length > 0 ? kept : undefined;
    }
  }
}
