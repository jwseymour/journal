import type { LayoutDiagnostic, ResolvedLayout } from '@journal/contract';
import { buildAnalysisCatalog } from './catalog.js';
import { DEFAULT_ANALYSIS_LAYOUT } from './defaults.js';
import { LayoutExecutor, type LayoutExecutorDeps } from './execute.js';
import { parseLayout } from './parse.js';
import { resolveLayout } from './resolve.js';
import { serializeLayout } from './serialize.js';

/** The analysis surface's default window when neither the request nor the
 * layout names one — the same 30 days `http/app.ts`'s
 * `METRICS_SUMMARY_WINDOW_DAYS` uses. */
export const ANALYSIS_DEFAULT_WINDOW_DAYS = 30;

export interface RenderedLayout {
  layout: ResolvedLayout;
  /** Non-empty only for a caller-supplied `syntax` that did not fully parse.
   * The route turns a non-empty list into `layout_invalid`; the built-in
   * default never produces any. */
  diagnostics: LayoutDiagnostic[];
}

/**
 * Parse → resolve against the live catalog → execute. `syntax` is the DSL to
 * render; omit it for the surface's built-in default
 * (`DEFAULT_ANALYSIS_LAYOUT`). `windowDays` overrides the layout's own
 * `window:`.
 */
export function renderAnalysisLayout(
  deps: LayoutExecutorDeps,
  options: { syntax?: string; windowDays?: number; layoutId?: string | null },
  now?: number,
): RenderedLayout {
  const syntax = options.syntax ?? DEFAULT_ANALYSIS_LAYOUT;
  const { spec, diagnostics } = parseLayout(syntax, 'analysis');

  const catalog = buildAnalysisCatalog(deps.categories, deps.metricFields);
  const plan = resolveLayout(spec, catalog);
  const windowDays = options.windowDays ?? spec.window?.days ?? ANALYSIS_DEFAULT_WINDOW_DAYS;
  // The canonical form of what actually parsed — what the syntax editor shows
  // and what a save would store, never the raw request text.
  const canonicalSyntax = serializeLayout(spec);

  const layout = new LayoutExecutor(deps).render(
    plan,
    windowDays,
    options.layoutId ?? null,
    canonicalSyntax,
    now,
  );
  return { layout, diagnostics };
}

/** Parse + re-serialise to canonical form — the live-validation surface the
 * syntax editor calls (`design.md` §5.3.2). */
export function parseAndCanonicalise(
  syntax: string,
  surface: 'analysis' | 'home' = 'analysis',
): { spec: ReturnType<typeof parseLayout>['spec']; canonicalSyntax: string; diagnostics: LayoutDiagnostic[] } {
  const { spec, diagnostics } = parseLayout(syntax, surface);
  return { spec, canonicalSyntax: serializeLayout(spec), diagnostics };
}
