import type { RawLayoutSpec } from '@journal/contract';
import { catalogHas, domainLabel, type ResourceCatalog } from './catalog.js';
import { findView, type OptionValue, type ViewDef } from './spec.js';

/**
 * `RawLayoutSpec` (grammar-valid, identifiers unchecked) → a plan the
 * executor can run: every panel is either resolved against the live catalog
 * or replaced by an `ok: false` marker the frontend renders as a quiet
 * "couldn't resolve" note. Never throws — the same degrade-don't-fail stance
 * `chat-orchestrator.ts` takes for an unresolvable ref.
 *
 * An unknown view kind cannot reach here (the parser rejects it), but this
 * guards against it anyway, since a stored spec could in principle outlast a
 * removed view.
 */
export interface ResolvedPlan {
  name: string;
  sections: PlannedSection[];
}

export interface PlannedSection {
  title: string;
  panels: PlannedPanel[];
}

export type PlannedPanel =
  | { ok: true; view: ViewDef; title: string; options: Record<string, OptionValue> }
  | { ok: false; title: string; message: string };

export function resolveLayout(raw: RawLayoutSpec, catalog: ResourceCatalog): ResolvedPlan {
  return {
    name: raw.name,
    sections: raw.sections.map((section) => ({
      title: section.title,
      panels: section.panels.map((panel) => resolvePanel(panel.view, panel.options, catalog)),
    })),
  };
}

function resolvePanel(
  viewKind: string,
  options: Record<string, OptionValue>,
  catalog: ResourceCatalog,
): PlannedPanel {
  const view = findView(catalog.surface, viewKind);
  if (!view) {
    return { ok: false, title: viewKind, message: `Unknown panel '${viewKind}'.` };
  }

  for (const def of view.options) {
    if (def.kind !== 'ref' && def.kind !== 'list') continue;
    const value = options[def.key];
    if (value === undefined || def.of === undefined) continue;
    const identifiers = Array.isArray(value) ? value : [String(value)];
    const missing = identifiers.filter((identifier) => !catalogHas(catalog, def.of!, identifier));
    if (missing.length > 0) {
      const label = domainLabel(def.of);
      const list = missing.map((name) => `'${name}'`).join(', ');
      return {
        ok: false,
        title: view.title,
        message:
          missing.length === 1
            ? `No ${label} ${list} — it may have been renamed or removed.`
            : `No ${label}s ${list} — they may have been renamed or removed.`,
      };
    }
  }

  return { ok: true, view, title: view.title, options };
}
