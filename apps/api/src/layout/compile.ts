import type { RawLayoutSpec } from '@journal/contract';
import { layoutCompileFailed } from '../errors.js';
import type { ModelClient } from '../model/model-client.js';
import type { ResourceCatalog } from './catalog.js';
import { buildLayoutSpecSchema, specFromModelOutput, type LayoutSpecModelOutput } from './schema.js';
import { viewsForSurface } from './spec.js';

/**
 * Prose → a layout, via the one model seam (`requirements.md` §7.6,
 * `model/model-client.ts`). Same shape as `chat-orchestrator.ts`: the model
 * fills a closed, catalog-derived schema (`schema.ts`) and this re-validates
 * every identifier it returns before anything is serialised. It never saves —
 * the route hands the result back for the user to review and save
 * (`requirements.md` §6.1).
 *
 * A missing or unreachable gateway surfaces as `layout_compile_failed` (503)
 * and never blocks the hand-edit path — the syntax editor works without a
 * model.
 */
export interface LayoutCompiling {
  compile(
    prose: string,
    catalog: ResourceCatalog,
    name: string,
    currentSyntax?: string,
  ): Promise<{ syntax: string; spec: RawLayoutSpec; unresolved: string[] }>;
}

export class LayoutCompiler implements LayoutCompiling {
  readonly #model: ModelClient;

  constructor(model: ModelClient) {
    this.#model = model;
  }

  async compile(
    prose: string,
    catalog: ResourceCatalog,
    name: string,
    currentSyntax?: string,
  ): Promise<{ syntax: string; spec: RawLayoutSpec; unresolved: string[] }> {
    const schema = buildLayoutSpecSchema(catalog);

    let output: LayoutSpecModelOutput;
    try {
      output = await this.#model.extract<LayoutSpecModelOutput>({
        schema,
        system: systemPrompt(catalog),
        prompt: userPrompt(prose, currentSyntax),
      });
    } catch (cause) {
      throw layoutCompileFailed(
        'The layout could not be generated — the AI gateway is unconfigured or unreachable. You can still edit the syntax by hand.',
        cause,
      );
    }

    return specFromModelOutput(output, catalog, name);
  }
}

function systemPrompt(catalog: ResourceCatalog): string {
  const panels = viewsForSurface(catalog.surface)
    .map((view) => {
      const opts = view.options.map((option) => option.key).join(', ') || '(none)';
      return `- ${view.kind} — ${view.title}. Options: ${opts}.`;
    })
    .join('\n');

  const list = (label: string, values: ReadonlySet<string>): string =>
    values.size === 0 ? `${label}: (none defined yet)` : `${label}: ${[...values].join(', ')}`;

  return [
    'You arrange an analysis page from a fixed kit of panels. You do not write code or markup —',
    'you choose which panels appear, in what order, under what section headings, and set their options.',
    '',
    'The panel kit:',
    panels,
    '',
    'Referenceable identifiers (use these exact strings; never invent one):',
    list('metrics', catalog.metrics),
    list('metric fields (as "metric.fieldKey")', catalog.fields),
    list('review media', catalog.reviewMedia),
    list('list types', catalog.listTypes),
    list('concept subjects', catalog.subjects),
    '',
    'Guidance:',
    '- Group related panels under a short, plain section title. Two to four sections is typical.',
    '- Omit an option to mean "everything" — only set metrics/fields/metric/medium/type/subject to narrow.',
    '- Leave window null unless the description names a time span.',
    '- If the description asks for something the kit cannot express, do the closest thing it can.',
  ].join('\n');
}

function userPrompt(prose: string, currentSyntax?: string): string {
  if (currentSyntax) {
    return [
      'Here is the current layout:',
      '',
      currentSyntax,
      '',
      'Revise it to match this description, keeping whatever it does not touch:',
      '',
      prose,
    ].join('\n');
  }
  return `Build a layout matching this description:\n\n${prose}`;
}
