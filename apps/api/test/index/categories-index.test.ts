import { beforeEach, describe, expect, it } from 'vitest';
import { CategoriesIndex } from '../../src/index/categories-index.js';

const NOW = '2026-07-20T09:00:00Z';

let index: CategoriesIndex;

beforeEach(() => {
  index = new CategoriesIndex(':memory:');
});

describe('seed', () => {
  it('approves every named seed category', () => {
    index.seed('metric', ['exercise', 'alcohol', 'sleep'], NOW);
    expect(index.approvedNames('metric')).toEqual(['alcohol', 'exercise', 'sleep']);
  });

  it('is idempotent — re-seeding does not duplicate or error', () => {
    index.seed('metric', ['exercise'], NOW);
    index.seed('metric', ['exercise'], NOW);
    expect(index.approvedNames('metric')).toEqual(['exercise']);
  });

  it('keeps structure types separate', () => {
    index.seed('metric', ['exercise'], NOW);
    index.seed('review_medium', ['film'], NOW);
    expect(index.approvedNames('metric')).toEqual(['exercise']);
    expect(index.approvedNames('review_medium')).toEqual(['film']);
  });
});

describe('approveDirectly', () => {
  it('adds a category immediately, with no suggestion record', () => {
    index.approveDirectly('list_type', 'quote', NOW);
    expect(index.approvedNames('list_type')).toEqual(['quote']);
    expect(index.listSuggestions()).toEqual([]);
  });

  it('is idempotent', () => {
    index.approveDirectly('metric', 'meditation', NOW);
    index.approveDirectly('metric', 'meditation', NOW);
    expect(index.approvedNames('metric')).toEqual(['meditation']);
  });
});

describe('suggest / listSuggestions / decide', () => {
  it('records a pending suggestion', () => {
    index.suggest({ structureType: 'metric', name: 'meditation', reason: 'mentioned meditating', entryId: 'e1', id: 's1', now: NOW });
    const suggestions = index.listSuggestions();
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({
      id: 's1',
      structureType: 'metric',
      name: 'meditation',
      reason: 'mentioned meditating',
      entryId: 'e1',
      status: 'pending',
      decidedAt: null,
    });
  });

  it('does not suggest a name that is already approved', () => {
    index.approveDirectly('metric', 'meditation', NOW);
    index.suggest({ structureType: 'metric', name: 'meditation', reason: 'x', entryId: 'e1', id: 's1', now: NOW });
    expect(index.listSuggestions()).toEqual([]);
  });

  it('does not duplicate a suggestion already pending for the same name', () => {
    index.suggest({ structureType: 'metric', name: 'meditation', reason: 'first', entryId: 'e1', id: 's1', now: NOW });
    index.suggest({ structureType: 'metric', name: 'meditation', reason: 'second', entryId: 'e2', id: 's2', now: NOW });
    expect(index.listSuggestions()).toHaveLength(1);
  });

  it('filters by structureType and status', () => {
    index.suggest({ structureType: 'metric', name: 'meditation', reason: 'x', entryId: 'e1', id: 's1', now: NOW });
    index.suggest({ structureType: 'review_medium', name: 'podcast', reason: 'x', entryId: 'e2', id: 's2', now: NOW });
    index.decide('s2', 'approved', NOW);

    expect(index.listSuggestions({ structureType: 'metric' }).map((s) => s.id)).toEqual(['s1']);
    expect(index.listSuggestions({ status: 'pending' }).map((s) => s.id)).toEqual(['s1']);
    expect(index.listSuggestions({ status: 'approved' }).map((s) => s.id)).toEqual(['s2']);
  });

  it('approving a suggestion adds it to the approved set', () => {
    index.suggest({ structureType: 'metric', name: 'meditation', reason: 'x', entryId: 'e1', id: 's1', now: NOW });
    index.decide('s1', 'approved', NOW);

    expect(index.approvedNames('metric')).toEqual(['meditation']);
    expect(index.getSuggestion('s1')).toMatchObject({ status: 'approved', decidedAt: NOW });
  });

  it('rejecting a suggestion never adds it to the approved set', () => {
    index.suggest({ structureType: 'metric', name: 'meditation', reason: 'x', entryId: 'e1', id: 's1', now: NOW });
    index.decide('s1', 'rejected', NOW);

    expect(index.approvedNames('metric')).toEqual([]);
    expect(index.getSuggestion('s1')).toMatchObject({ status: 'rejected', decidedAt: NOW });
  });

  it('is a no-op for a suggestion that does not exist', () => {
    expect(() => index.decide('never-existed', 'approved', NOW)).not.toThrow();
  });

  it('is a no-op for a suggestion that is already decided', () => {
    index.suggest({ structureType: 'metric', name: 'meditation', reason: 'x', entryId: 'e1', id: 's1', now: NOW });
    index.decide('s1', 'rejected', NOW);
    index.decide('s1', 'approved', NOW); // must not flip a rejected suggestion to approved after the fact
    expect(index.approvedNames('metric')).toEqual([]);
    expect(index.getSuggestion('s1')?.status).toBe('rejected');
  });

  it('once approved, suggesting the same name again is a no-op', () => {
    index.suggest({ structureType: 'metric', name: 'meditation', reason: 'x', entryId: 'e1', id: 's1', now: NOW });
    index.decide('s1', 'approved', NOW);
    index.suggest({ structureType: 'metric', name: 'meditation', reason: 'again', entryId: 'e2', id: 's2', now: NOW });
    expect(index.listSuggestions()).toHaveLength(1);
  });

  it('returns null for a suggestion that does not exist', () => {
    expect(index.getSuggestion('never-existed')).toBeNull();
  });
});
