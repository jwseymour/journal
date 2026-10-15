import type { LayoutSurface } from '@journal/contract';
import type { CategoriesReader } from '../index/categories-index.js';
import type { MetricFieldsReader } from '../index/metric-fields-index.js';
import type { RefDomain } from './spec.js';

/**
 * The set of real identifiers a layout on one surface is allowed to name,
 * captured from live index state at request time. `resolveLayout` checks
 * every `ref`/`list` option against this; the AI schema (`schema.ts`, a
 * later phase) is built from it. The seam that makes the engine reusable for
 * the public surface — `buildHomeCatalog` would fill the same shape from the
 * published-index instead.
 */
export interface ResourceCatalog {
  surface: LayoutSurface;
  metrics: ReadonlySet<string>;
  /** `"metric.fieldKey"`. */
  fields: ReadonlySet<string>;
  reviewMedia: ReadonlySet<string>;
  listTypes: ReadonlySet<string>;
  subjects: ReadonlySet<string>;
}

export function buildAnalysisCatalog(
  categories: CategoriesReader,
  metricFields: MetricFieldsReader,
): ResourceCatalog {
  return {
    surface: 'analysis',
    metrics: new Set(categories.approvedNames('metric')),
    fields: new Set(metricFields.listAll().map((field) => `${field.metric}.${field.fieldKey}`)),
    reviewMedia: new Set(categories.approvedNames('review_medium')),
    listTypes: new Set(categories.approvedNames('list_type')),
    subjects: new Set(categories.approvedNames('opinion_subject')),
  };
}

/** Whether one identifier is in the catalog for a given option domain. */
export function catalogHas(catalog: ResourceCatalog, domain: RefDomain, identifier: string): boolean {
  switch (domain) {
    case 'metric':
      return catalog.metrics.has(identifier);
    case 'field':
      return catalog.fields.has(identifier);
    case 'medium':
      return catalog.reviewMedia.has(identifier);
    case 'list-type':
      return catalog.listTypes.has(identifier);
    case 'subject':
      return catalog.subjects.has(identifier);
  }
}

const DOMAIN_LABEL: Record<RefDomain, string> = {
  metric: 'metric',
  field: 'metric field',
  medium: 'review medium',
  'list-type': 'list type',
  subject: 'concept subject',
};

export function domainLabel(domain: RefDomain): string {
  return DOMAIN_LABEL[domain];
}
