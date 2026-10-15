/**
 * The analysis surface's built-in layout — today's hardcoded page, in the
 * language. `POST /analysis/render` falls back to this when no layout is
 * named and none is stored as the default. Kept as the canonical DSL string
 * (a round-trip through `parseLayout`/`serializeLayout` reproduces it byte
 * for byte — asserted in the fixture tests).
 *
 * The section order and panel order are `DEFAULT_ORDER` from the pre-M20
 * `apps/web/app/analysis/page.tsx` verbatim, with the old combined
 * "Breakdowns" panel split into `breakdown` + `correlation`.
 */
export const DEFAULT_ANALYSIS_LAYOUT = `layout "Analysis"
  window: 30d

section "Rhythms"
  panel presence
  panel register
  panel horizon
  panel matrix

section "Tallies"
  panel breakdown
  panel correlation
  panel reviews
  panel rating-distribution
  panel rating-spread

section "Threads"
  panel questions
  panel todos
  panel lists
  panel concepts
  panel aging
`;
