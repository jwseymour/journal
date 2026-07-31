import { beforeEach, describe, expect, it } from 'vitest';
import { MetricFieldsIndex } from '../../src/index/metric-fields-index.js';

const NOW = '2026-07-20T09:00:00Z';

let index: MetricFieldsIndex;

beforeEach(() => {
  index = new MetricFieldsIndex(':memory:');
});

const field = (overrides: Partial<Parameters<MetricFieldsIndex['define']>[0]> = {}) => ({
  id: 'f1',
  metric: 'exercise',
  fieldKey: 'distance_km',
  label: 'Distance',
  fieldType: 'numeric' as const,
  unit: 'km',
  scoreMin: null,
  scoreMax: null,
  description: 'How far, in km.',
  now: NOW,
  ...overrides,
});

describe('define / listForMetric / listAll', () => {
  it('defines a field immediately, with no suggestion record', () => {
    index.define(field());
    expect(index.listForMetric('exercise')).toMatchObject([{ fieldKey: 'distance_km', label: 'Distance', unit: 'km' }]);
    expect(index.listSuggestions()).toEqual([]);
  });

  it('is idempotent for the same (metric, fieldKey)', () => {
    index.define(field());
    index.define(field({ id: 'f2', label: 'Distance again' }));
    expect(index.listForMetric('exercise')).toHaveLength(1);
  });

  it('keeps metrics separate', () => {
    index.define(field());
    index.define(field({ id: 'f2', metric: 'alcohol', fieldKey: 'units', label: 'Units', unit: 'units' }));
    expect(index.listForMetric('exercise').map((f) => f.fieldKey)).toEqual(['distance_km']);
    expect(index.listForMetric('alcohol').map((f) => f.fieldKey)).toEqual(['units']);
  });

  it('listAll returns every field across every metric', () => {
    index.define(field());
    index.define(field({ id: 'f2', metric: 'alcohol', fieldKey: 'units', label: 'Units' }));
    expect(index.listAll().map((f) => f.fieldKey)).toEqual(['units', 'distance_km']);
  });

  it('is empty when nothing has been defined', () => {
    expect(index.listForMetric('exercise')).toEqual([]);
    expect(index.listAll()).toEqual([]);
  });
});

describe('remove', () => {
  it('discards a field definition', () => {
    index.define(field());
    index.remove('f1');
    expect(index.listForMetric('exercise')).toEqual([]);
  });

  it('is a no-op for an id that does not exist', () => {
    expect(() => index.remove('never-existed')).not.toThrow();
  });
});

describe('suggest / listSuggestions / decide', () => {
  const suggestion = (overrides: Partial<Parameters<MetricFieldsIndex['suggest']>[0]> = {}) => ({
    id: 's1',
    metric: 'exercise',
    fieldKey: 'pace_min_per_km',
    label: 'Pace',
    fieldType: 'numeric' as const,
    unit: 'min/km',
    scoreMin: null,
    scoreMax: null,
    description: 'How fast, in minutes per km.',
    reason: 'pace mentioned repeatedly',
    entryId: 'e1',
    now: NOW,
    ...overrides,
  });

  it('records a pending suggestion', () => {
    index.suggest(suggestion());
    const suggestions = index.listSuggestions();
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({
      id: 's1',
      metric: 'exercise',
      fieldKey: 'pace_min_per_km',
      reason: 'pace mentioned repeatedly',
      entryId: 'e1',
      status: 'pending',
      decidedAt: null,
    });
  });

  it('does not suggest a field that is already defined', () => {
    index.define(field({ fieldKey: 'pace_min_per_km' }));
    index.suggest(suggestion());
    expect(index.listSuggestions()).toEqual([]);
  });

  it('does not duplicate a suggestion already pending for the same (metric, fieldKey)', () => {
    index.suggest(suggestion());
    index.suggest(suggestion({ id: 's2', reason: 'again' }));
    expect(index.listSuggestions()).toHaveLength(1);
  });

  it('filters by metric and status', () => {
    index.suggest(suggestion());
    index.suggest(suggestion({ id: 's2', metric: 'alcohol', fieldKey: 'units' }));
    index.decide('s2', 'approved', NOW);

    expect(index.listSuggestions({ metric: 'exercise' }).map((s) => s.id)).toEqual(['s1']);
    expect(index.listSuggestions({ status: 'pending' }).map((s) => s.id)).toEqual(['s1']);
    expect(index.listSuggestions({ status: 'approved' }).map((s) => s.id)).toEqual(['s2']);
  });

  it('approving a suggestion defines the field', () => {
    index.suggest(suggestion());
    index.decide('s1', 'approved', NOW);

    expect(index.listForMetric('exercise')).toMatchObject([{ fieldKey: 'pace_min_per_km' }]);
    expect(index.getSuggestion('s1')).toMatchObject({ status: 'approved', decidedAt: NOW });
  });

  it('rejecting a suggestion never defines the field', () => {
    index.suggest(suggestion());
    index.decide('s1', 'rejected', NOW);

    expect(index.listForMetric('exercise')).toEqual([]);
    expect(index.getSuggestion('s1')).toMatchObject({ status: 'rejected', decidedAt: NOW });
  });

  it('is a no-op for a suggestion that does not exist', () => {
    expect(() => index.decide('never-existed', 'approved', NOW)).not.toThrow();
  });

  it('is a no-op for a suggestion that is already decided', () => {
    index.suggest(suggestion());
    index.decide('s1', 'rejected', NOW);
    index.decide('s1', 'approved', NOW);
    expect(index.listForMetric('exercise')).toEqual([]);
    expect(index.getSuggestion('s1')?.status).toBe('rejected');
  });

  it('once approved, suggesting the same field again is a no-op', () => {
    index.suggest(suggestion());
    index.decide('s1', 'approved', NOW);
    index.suggest(suggestion({ id: 's2', reason: 'again' }));
    expect(index.listSuggestions()).toHaveLength(1);
  });

  it('returns null for a suggestion that does not exist', () => {
    expect(index.getSuggestion('never-existed')).toBeNull();
  });
});
