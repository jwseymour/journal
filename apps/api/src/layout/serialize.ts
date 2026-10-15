import type { RawLayoutSpec } from '@journal/contract';
import { findView, type OptionDef } from './spec.js';

/**
 * `RawLayoutSpec` → canonical DSL text. The fidelity anchor: a round-trip
 * through `parseLayout` must change nothing already in this form, and this is
 * what `LayoutStore` writes to `derived/layouts/<id>.dsl` (`format.md` §8).
 *
 * Canonical form:
 * - two-space indent per level; `layout` / `section` at column 0, `panel` at
 *   two, panel options at four
 * - the optional `window:` line sits directly under `layout` with no blank
 *   line; then exactly one blank line before the first section, and exactly
 *   one between sections; none anywhere else; one trailing newline
 * - a panel option is emitted only when present and not equal to its default
 *   (`OptionDef.default`), in the view's declared option order
 * - list values are `, `-joined; strings are bare (never quoted — identifiers
 *   only); a name with a `"` in it is the one quoted string, on the `layout`
 *   and `section` lines
 */
export function serializeLayout(spec: RawLayoutSpec): string {
  const lines: string[] = [`layout ${quote(spec.name)}`];
  if (spec.window) lines.push(`  window: ${spec.window.days}d`);

  for (const section of spec.sections) {
    lines.push('');
    lines.push(`section ${quote(section.title)}`);
    for (const panel of section.panels) {
      lines.push(`  panel ${panel.view}`);
      const view = findView(spec.surface, panel.view);
      const optionDefs: readonly OptionDef[] = view?.options ?? [];
      // Emit in declared order for a view we know; otherwise fall back to
      // insertion order so an unknown view still round-trips.
      const keys = view ? optionDefs.map((option) => option.key) : Object.keys(panel.options);
      for (const key of keys) {
        const value = panel.options[key];
        if (value === undefined) continue;
        const def = optionDefs.find((option) => option.key === key);
        if (def?.default !== undefined && isDefault(value, def.default)) continue;
        lines.push(`    ${key}: ${formatValue(value)}`);
      }
    }
  }

  return `${lines.join('\n')}\n`;
}

function isDefault(value: string | number | readonly string[], fallback: string | number): boolean {
  if (Array.isArray(value)) return false;
  return value === fallback;
}

function formatValue(value: string | number | readonly string[]): string {
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}

/** Names and section titles are the only quoted strings. A `"` inside one is
 * backslash-escaped, matching the parser. */
function quote(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
