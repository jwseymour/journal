import type { LayoutDiagnostic, LayoutSurface, RawLayoutPanel, RawLayoutSection, RawLayoutSpec } from '@journal/contract';
import { findView, viewsForSurface, type OptionDef } from './spec.js';

/**
 * DSL text → `RawLayoutSpec` + diagnostics. Line-oriented recursive descent
 * over a closed grammar (`serialize.ts` documents the canonical form). Never
 * throws on bad input — every problem is a `LayoutDiagnostic` anchored to a
 * 1-indexed line and column, so the editor can show them all at once
 * (`design.md` §5.3.2). A malformed line is skipped; parsing continues.
 *
 * Grammar (indent is two spaces per level):
 *
 *   layout "<name>"
 *     window: <n>(d|mo|y)          -- optional
 *
 *   section "<title>"
 *     panel <view-kind>
 *       <option-key>: <value>       -- <value>: bare identifier, integer, or
 *                                      a comma-separated identifier list
 */
export interface ParseResult {
  spec: RawLayoutSpec;
  diagnostics: LayoutDiagnostic[];
}

const IDENT = /^[A-Za-z][A-Za-z0-9_.-]*$/;
const DURATION = /^(\d+)(d|mo|y)$/;
const DURATION_DAYS: Record<string, number> = { d: 1, mo: 30, y: 365 };

export function parseLayout(text: string, surface: LayoutSurface): ParseResult {
  const diagnostics: LayoutDiagnostic[] = [];
  const report = (line: number, column: number, message: string): void => {
    diagnostics.push({ line, column, message });
  };

  const rawLines = text.split('\n');
  // (content, indent, 1-indexed line number) for every non-blank line.
  const lines: { content: string; indent: number; line: number }[] = [];
  for (let i = 0; i < rawLines.length; i += 1) {
    const raw = rawLines[i]!;
    if (raw.trim() === '') continue;
    if (raw.includes('\t')) {
      report(i + 1, raw.indexOf('\t') + 1, 'Tabs are not allowed — indent with two spaces per level.');
    }
    const indent = raw.length - raw.trimStart().length;
    if (indent % 2 !== 0) {
      report(i + 1, 1, `Indent must be a multiple of two spaces (got ${indent}).`);
    }
    lines.push({ content: raw.trim(), indent, line: i + 1 });
  }

  let cursor = 0;
  let name = 'Untitled';
  let window: { days: number } | null = null;
  const sections: RawLayoutSection[] = [];

  // ── header ──────────────────────────────────────────────────────────────
  const first = lines[cursor];
  if (first && first.indent === 0 && first.content.startsWith('layout')) {
    const parsed = parseNamedLine(first.content, 'layout');
    if (parsed === null) {
      report(first.line, 1, 'Expected: layout "Name"');
    } else {
      name = parsed;
    }
    cursor += 1;
    // header options
    while (lines[cursor] && lines[cursor]!.indent === 2 && !lines[cursor]!.content.startsWith('panel')) {
      const opt = lines[cursor]!;
      const colon = opt.content.indexOf(':');
      const key = colon >= 0 ? opt.content.slice(0, colon).trim() : opt.content.trim();
      const value = colon >= 0 ? opt.content.slice(colon + 1).trim() : '';
      if (key === 'window') {
        const match = DURATION.exec(value);
        if (!match) {
          report(opt.line, colon + 3, `'${value}' is not a duration — try 30d, 3mo, or 1y.`);
        } else {
          window = { days: Number(match[1]) * DURATION_DAYS[match[2]!]! };
        }
      } else {
        report(opt.line, 1, `Unknown layout option '${key}'. The only one is 'window'.`);
      }
      cursor += 1;
    }
  } else {
    report(first ? first.line : 1, 1, 'A layout must begin with: layout "Name"');
  }

  // ── sections ────────────────────────────────────────────────────────────
  while (cursor < lines.length) {
    const current = lines[cursor]!;

    if (current.indent === 0 && current.content.startsWith('section')) {
      const title = parseNamedLine(current.content, 'section');
      if (title === null) {
        report(current.line, 1, 'Expected: section "Title"');
        cursor += 1;
        continue;
      }
      cursor += 1;
      const panels: RawLayoutPanel[] = [];
      while (cursor < lines.length && lines[cursor]!.indent >= 2) {
        const panelLine = lines[cursor]!;
        if (panelLine.indent === 2 && panelLine.content.startsWith('panel')) {
          const panel = parsePanel(panelLine, surface, report);
          cursor += 1;
          const consumed = consumeOptions(lines, cursor, surface, panel, report);
          cursor = consumed;
          if (panel) panels.push(panel.panel);
        } else {
          report(panelLine.line, 1, `Expected 'panel <kind>' here, not '${truncate(panelLine.content)}'.`);
          cursor += 1;
        }
      }
      sections.push({ title, panels });
      continue;
    }

    report(current.line, 1, `Expected 'section "Title"' at the left margin, not '${truncate(current.content)}'.`);
    cursor += 1;
  }

  return {
    spec: { version: 1, surface, name, window, sections },
    diagnostics,
  };
}

interface PendingPanel {
  panel: RawLayoutPanel;
  view: string;
}

function parsePanel(
  line: { content: string; line: number },
  surface: LayoutSurface,
  report: (line: number, column: number, message: string) => void,
): PendingPanel | null {
  const rest = line.content.slice('panel'.length).trim();
  if (rest === '' || !IDENT.test(rest)) {
    report(line.line, 7, `Expected a panel kind after 'panel', got '${truncate(rest)}'.`);
    return null;
  }
  if (!findView(surface, rest)) {
    const known = viewsForSurface(surface)
      .map((view) => view.kind)
      .join(', ');
    report(line.line, 7, `Unknown panel '${rest}'. Known panels: ${known}.`);
    return null;
  }
  return { panel: { view: rest, options: {} }, view: rest };
}

/** Reads every indent-4 option line following a panel, coercing each value by
 * the option's declared kind. Returns the new cursor position. */
function consumeOptions(
  lines: { content: string; indent: number; line: number }[],
  start: number,
  surface: LayoutSurface,
  pending: PendingPanel | null,
  report: (line: number, column: number, message: string) => void,
): number {
  let cursor = start;
  const view = pending ? findView(surface, pending.view) : undefined;
  while (cursor < lines.length && lines[cursor]!.indent >= 4) {
    const optLine = lines[cursor]!;
    cursor += 1;
    if (optLine.indent !== 4) {
      report(optLine.line, 1, 'A panel option is indented four spaces.');
      continue;
    }
    const colon = optLine.content.indexOf(':');
    if (colon < 0) {
      report(optLine.line, 1, `Expected 'key: value', got '${truncate(optLine.content)}'.`);
      continue;
    }
    const key = optLine.content.slice(0, colon).trim();
    const rawValue = optLine.content.slice(colon + 1).trim();
    if (!pending || !view) continue; // panel itself was invalid; swallow its options

    const def: OptionDef | undefined = view.options.find((option) => option.key === key);
    if (!def) {
      const known = view.options.map((option) => option.key).join(', ') || '(none)';
      report(optLine.line, 1, `Panel '${pending.view}' has no option '${key}'. Options: ${known}.`);
      continue;
    }

    const coerced = coerceOption(def, rawValue, optLine.line, colon + 3, report);
    if (coerced !== undefined) pending.panel.options[key] = coerced;
  }
  return cursor;
}

function coerceOption(
  def: OptionDef,
  raw: string,
  line: number,
  column: number,
  report: (line: number, column: number, message: string) => void,
): string | number | string[] | undefined {
  switch (def.kind) {
    case 'int': {
      if (!/^\d+$/.test(raw)) {
        report(line, column, `'${def.key}' takes a whole number, got '${truncate(raw)}'.`);
        return undefined;
      }
      return Number(raw);
    }
    case 'enum': {
      if (!def.values?.includes(raw)) {
        report(line, column, `'${def.key}' must be one of: ${def.values?.join(', ')}. Got '${truncate(raw)}'.`);
        return undefined;
      }
      return raw;
    }
    case 'ref': {
      if (!IDENT.test(raw)) {
        report(line, column, `'${def.key}' takes one name, got '${truncate(raw)}'.`);
        return undefined;
      }
      return raw;
    }
    case 'list': {
      const items = raw
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item !== '');
      if (items.length === 0) {
        report(line, column, `'${def.key}' takes a comma-separated list of names.`);
        return undefined;
      }
      const bad = items.find((item) => !IDENT.test(item));
      if (bad !== undefined) {
        report(line, column, `'${bad}' is not a valid name in '${def.key}'.`);
        return undefined;
      }
      return items;
    }
  }
}

/** `keyword "quoted text"` → the unescaped text, or `null` if it does not
 * match. */
function parseNamedLine(content: string, keyword: string): string | null {
  const rest = content.slice(keyword.length);
  const match = /^\s+"((?:[^"\\]|\\.)*)"\s*$/.exec(rest);
  if (!match) return null;
  // Single-pass unescape, the reverse of `serialize.ts`'s `quote`: `\x` → `x`.
  return match[1]!.replace(/\\(.)/g, '$1');
}

function truncate(text: string): string {
  return text.length > 30 ? `${text.slice(0, 30)}…` : text;
}
