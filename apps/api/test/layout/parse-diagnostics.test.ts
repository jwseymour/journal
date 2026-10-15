import { describe, expect, it } from 'vitest';
import { parseLayout } from '../../src/layout/parse.js';

/**
 * The parser never throws — every problem is a `LayoutDiagnostic` anchored to
 * a line and column, so the syntax editor can show them all at once
 * (`design.md` §5.3.2). Each case here pins one specific message.
 */

const firstDiagnostic = (text: string) => parseLayout(text, 'analysis').diagnostics[0];

describe('parseLayout diagnostics', () => {
  it('flags a missing header', () => {
    const d = firstDiagnostic('section "A"\n  panel presence\n');
    expect(d).toMatchObject({ line: 1, message: expect.stringContaining('layout "Name"') });
  });

  it('flags a tab', () => {
    const d = firstDiagnostic('layout "A"\n\nsection "B"\n\tpanel presence\n');
    expect(d).toMatchObject({ line: 4, message: expect.stringContaining('Tabs are not allowed') });
  });

  it('flags odd indentation', () => {
    const d = firstDiagnostic('layout "A"\n\nsection "B"\n   panel presence\n');
    expect(d).toMatchObject({ line: 4, message: expect.stringContaining('multiple of two spaces') });
  });

  it('flags an unknown panel kind and lists the known ones', () => {
    const d = firstDiagnostic('layout "A"\n\nsection "B"\n  panel nonsense\n');
    expect(d).toMatchObject({ line: 4, message: expect.stringContaining("Unknown panel 'nonsense'") });
    expect(d?.message).toContain('presence');
  });

  it('flags an unknown option key for a known panel', () => {
    const d = firstDiagnostic('layout "A"\n\nsection "B"\n  panel presence\n    colour: blue\n');
    expect(d).toMatchObject({ line: 5, message: expect.stringContaining("has no option 'colour'") });
  });

  it('flags an unknown layout option', () => {
    const d = firstDiagnostic('layout "A"\n  theme: dark\n\nsection "B"\n  panel presence\n');
    expect(d).toMatchObject({ line: 2, message: expect.stringContaining("Unknown layout option 'theme'") });
  });

  it('flags a bad duration unit', () => {
    const d = firstDiagnostic('layout "A"\n  window: 3w\n\nsection "B"\n  panel presence\n');
    expect(d).toMatchObject({ line: 2, message: expect.stringContaining('not a duration') });
  });

  it('flags a non-numeric int option', () => {
    const d = firstDiagnostic('layout "A"\n\nsection "B"\n  panel aging\n    limit: lots\n');
    expect(d).toMatchObject({ line: 5, message: expect.stringContaining('whole number') });
  });

  it('flags an out-of-set enum option', () => {
    const d = firstDiagnostic('layout "A"\n\nsection "B"\n  panel questions\n    show: sometimes\n');
    expect(d).toMatchObject({ line: 5, message: expect.stringContaining('must be one of') });
  });

  it('flags a section that is missing its quoted title', () => {
    const d = firstDiagnostic('layout "A"\n\nsection B\n  panel presence\n');
    expect(d).toMatchObject({ line: 3, message: expect.stringContaining('section "Title"') });
  });

  it('recovers: a bad panel line does not stop later sections parsing', () => {
    const { spec, diagnostics } = parseLayout(
      'layout "A"\n\nsection "B"\n  panel nonsense\n\nsection "C"\n  panel todos\n',
      'analysis',
    );
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(spec.sections.map((s) => s.title)).toEqual(['B', 'C']);
    expect(spec.sections[1]?.panels.map((p) => p.view)).toEqual(['todos']);
  });

  it('a duration in months or years converts to days', () => {
    expect(parseLayout('layout "A"\n  window: 3mo\n', 'analysis').spec.window).toEqual({ days: 90 });
    expect(parseLayout('layout "A"\n  window: 1y\n', 'analysis').spec.window).toEqual({ days: 365 });
  });
});
