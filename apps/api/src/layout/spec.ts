import type { LayoutSurface, RawLayoutPanel, RawLayoutSection, RawLayoutSpec } from '@journal/contract';

export type { LayoutSurface, RawLayoutPanel, RawLayoutSection, RawLayoutSpec } from '@journal/contract';

/**
 * The layout module (`requirements.md` §8 "Layout control", `format.md` §8).
 *
 * One table — `ANALYSIS_VIEWS` below — is the single source of truth for the
 * analysis surface's layout language. The parser, the serialiser, the
 * catalog-resolver, and (in a later phase) the AI schema all read it; only
 * `LayoutExecutor` (per-view data assembly) and the frontend `switch` are
 * hand-written per view. Adding a view kind is adding a row here plus those
 * two, the same "a category is a panel, not a layout" shape `design.md`
 * §5.3.1 describes.
 *
 * Same stance as `apps/api/src/model/chat-orchestrator.ts`: the vocabulary is
 * closed and the identifiers are checked against live catalog state; nothing
 * downstream trusts a name it was handed without resolving it.
 */

/** Which catalog set a view draws from — used by `resolveLayout` to reject a
 * panel whose subject does not exist, and to know which reader the executor
 * will hit. `'threads'` is questions and to-dos merged (the `aging` view). */
export type ResourceKind =
  | 'metrics'
  | 'metric-fields'
  | 'reviews'
  | 'lists'
  | 'concepts'
  | 'questions'
  | 'todos'
  | 'threads';

/** The catalog domain an option's identifiers must belong to. */
export type RefDomain = 'metric' | 'field' | 'medium' | 'list-type' | 'subject';

export interface OptionDef {
  key: string;
  /** `ref` — one identifier; `list` — a comma-separated set of identifiers;
   * `int` — a whole number; `enum` — one of `values`. */
  kind: 'ref' | 'list' | 'int' | 'enum';
  /** For `ref` / `list`: which catalog domain the identifiers are validated
   * against. */
  of?: RefDomain;
  /** For `enum`: the allowed values, first being the default. */
  values?: readonly string[];
  /** The value the serialiser treats as redundant and omits. `undefined`
   * means "always emit when present". */
  default?: string | number;
}

export interface ViewDef {
  kind: string;
  /** The panel title shown in its eyebrow. */
  title: string;
  /** Which catalog set it reads (validation + which executor branch). */
  resource: ResourceKind;
  /** The "all →" link the `Panel` gets, or `null`. */
  seeAllHref: string | null;
  options: readonly OptionDef[];
}

/**
 * The analysis surface's panel kit (`design.md` §5.3.1) — exactly today's
 * hardcoded analysis page, expressed declaratively. Today's single
 * "Breakdowns" panel is split into `breakdown` + `correlation` so a layout
 * can order and drop them independently; everything else is 1:1.
 */
export const ANALYSIS_VIEWS: readonly ViewDef[] = [
  {
    kind: 'presence',
    title: 'Presence',
    resource: 'metrics',
    seeAllHref: '/metrics',
    options: [{ key: 'metrics', kind: 'list', of: 'metric' }],
  },
  {
    kind: 'register',
    title: 'Register',
    resource: 'metric-fields',
    seeAllHref: null,
    options: [{ key: 'fields', kind: 'list', of: 'field' }],
  },
  {
    kind: 'horizon',
    title: 'Horizon',
    resource: 'metric-fields',
    seeAllHref: null,
    options: [{ key: 'fields', kind: 'list', of: 'field' }],
  },
  {
    kind: 'matrix',
    title: 'Aligned matrix',
    resource: 'metrics',
    seeAllHref: null,
    options: [{ key: 'metrics', kind: 'list', of: 'metric' }],
  },
  {
    kind: 'breakdown',
    title: 'Breakdowns',
    resource: 'metric-fields',
    seeAllHref: null,
    options: [{ key: 'metric', kind: 'ref', of: 'metric' }],
  },
  {
    kind: 'correlation',
    title: 'Correlations',
    resource: 'metrics',
    seeAllHref: null,
    options: [{ key: 'metric', kind: 'ref', of: 'metric' }],
  },
  {
    kind: 'reviews',
    title: 'Reviews',
    resource: 'reviews',
    seeAllHref: '/reviews',
    options: [
      { key: 'medium', kind: 'ref', of: 'medium' },
      { key: 'limit', kind: 'int', default: 20 },
    ],
  },
  {
    kind: 'rating-distribution',
    title: 'Rating distribution',
    resource: 'reviews',
    seeAllHref: null,
    options: [],
  },
  {
    kind: 'rating-spread',
    title: 'Ratings spread',
    resource: 'reviews',
    seeAllHref: null,
    options: [],
  },
  {
    kind: 'questions',
    title: 'Questions',
    resource: 'questions',
    seeAllHref: '/questions',
    options: [
      { key: 'show', kind: 'enum', values: ['open', 'all'], default: 'open' },
      { key: 'limit', kind: 'int', default: 5 },
    ],
  },
  {
    kind: 'todos',
    title: 'Todos',
    resource: 'todos',
    seeAllHref: '/todos',
    options: [
      { key: 'show', kind: 'enum', values: ['open', 'all'], default: 'open' },
      { key: 'limit', kind: 'int', default: 5 },
    ],
  },
  {
    kind: 'lists',
    title: 'Lists',
    resource: 'lists',
    seeAllHref: '/lists',
    options: [{ key: 'type', kind: 'ref', of: 'list-type' }],
  },
  {
    kind: 'concepts',
    title: 'Concepts',
    resource: 'concepts',
    seeAllHref: '/opinions',
    options: [{ key: 'subject', kind: 'ref', of: 'subject' }],
  },
  {
    kind: 'aging',
    title: 'How long things stay open',
    resource: 'threads',
    seeAllHref: null,
    options: [{ key: 'limit', kind: 'int', default: 12 }],
  },
];

const VIEWS_BY_SURFACE: Record<LayoutSurface, readonly ViewDef[]> = {
  analysis: ANALYSIS_VIEWS,
  // The public surface's kit is a later milestone (`requirements.md` §11).
  home: [],
};

export function viewsForSurface(surface: LayoutSurface): readonly ViewDef[] {
  return VIEWS_BY_SURFACE[surface];
}

export function findView(surface: LayoutSurface, kind: string): ViewDef | undefined {
  return viewsForSurface(surface).find((view) => view.kind === kind);
}

/** A panel option value as parsed: a bare identifier / enum value / int, or a
 * list of identifiers. */
export type OptionValue = string | number | readonly string[];

export function panelOption(panel: RawLayoutPanel, key: string): OptionValue | undefined {
  return panel.options[key];
}
