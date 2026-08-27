import { beforeEach, describe, expect, it } from 'vitest';
import { TodosIndex, type TodoRecord } from '../../src/index/todos-index.js';

let index: TodosIndex;

beforeEach(() => {
  index = new TodosIndex(':memory:');
});

const record = (overrides: Partial<Omit<TodoRecord, 'entryId'>> = {}): Omit<TodoRecord, 'entryId'> => ({
  id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  text: 'Call the dentist',
  eventTime: '2026-07-20T20:00:00+01:00',
  eventEpochMs: Date.parse('2026-07-20T19:00:00Z'),
  eventTimeExplicit: true,
  extractedAt: '2026-07-20T21:00:00+01:00',
  status: 'open',
  doneEntryId: null,
  resolution: null,
  doneAt: null,
  origin: 'extracted',
  touched: false,
  ...overrides,
});

describe('replaceRaised / list', () => {
  it('stores a record and lists it back', () => {
    index.replaceRaised('e1', [record()]);
    expect(index.list({ limit: 10 })).toEqual([{ entryId: 'e1', ...record() }]);
  });

  it('is empty, not an error, when nothing has been extracted', () => {
    expect(index.list({ limit: 10 })).toEqual([]);
  });

  it('filters by status', () => {
    index.replaceRaised('e1', [record({ id: 'm1', status: 'open' })]);
    index.replaceRaised('e2', [
      record({ id: 'm2', status: 'done', doneEntryId: 'e3', resolution: 'Called and rescheduled.' }),
    ]);
    expect(index.list({ status: 'done', limit: 10 }).map((r) => r.id)).toEqual(['m2']);
  });

  it('replaces only the to-dos raised by this entry, leaving other entries alone', () => {
    index.replaceRaised('e1', [record({ id: 'm1', text: 'First' })]);
    index.replaceRaised('e2', [record({ id: 'm2', text: 'Second' })]);
    index.replaceRaised('e1', [record({ id: 'm3', text: 'First, revised' })]);
    const rows = index.list({ limit: 10 });
    expect(rows.map((r) => r.id).sort()).toEqual(['m2', 'm3']);
  });

  it('does not disturb a completion recorded by another entry when the raising entry is reprocessed', () => {
    index.replaceRaised('e1', [record({ id: 'm1' })]);
    index.completeFromExtraction('m1', { doneEntryId: 'e2', resolution: 'Called.', doneAt: '2026-08-01T00:00:00Z' });

    index.replaceRaised('e1', [record({ id: 'm2', text: 'Something else entirely' })]);

    const rows = index.list({ limit: 10 });
    expect(rows.find((r) => r.id === 'm1')).toMatchObject({
      status: 'done',
      doneEntryId: 'e2',
      resolution: 'Called.',
    });
    expect(rows.find((r) => r.id === 'm2')).toMatchObject({ entryId: 'e1', status: 'open' });
  });
});

describe('completeFromExtraction', () => {
  it('marks an open to-do done, recording which entry and what it said', () => {
    index.replaceRaised('e1', [record({ id: 'm1' })]);
    index.completeFromExtraction('m1', { doneEntryId: 'e2', resolution: 'Called and rescheduled.', doneAt: '2026-08-01T00:00:00Z' });

    const [row] = index.list({ limit: 10 });
    expect(row).toMatchObject({
      status: 'done',
      doneEntryId: 'e2',
      resolution: 'Called and rescheduled.',
      doneAt: '2026-08-01T00:00:00Z',
    });
  });

  it('is a no-op against a to-do that is already done', () => {
    index.replaceRaised('e1', [record({ id: 'm1' })]);
    index.completeFromExtraction('m1', { doneEntryId: 'e2', resolution: 'First.', doneAt: '2026-08-01T00:00:00Z' });
    index.completeFromExtraction('m1', { doneEntryId: 'e3', resolution: 'Second.', doneAt: '2026-09-01T00:00:00Z' });

    const [row] = index.list({ limit: 10 });
    expect(row).toMatchObject({ doneEntryId: 'e2', resolution: 'First.' });
  });

  it('is a no-op for an id that does not exist', () => {
    expect(() =>
      index.completeFromExtraction('never-existed', { doneEntryId: 'e2', resolution: 'x', doneAt: '2026-08-01T00:00:00Z' }),
    ).not.toThrow();
  });

  it('never auto-completes a touched to-do (`requirements.md` §11)', () => {
    index.replaceRaised('e1', [record({ id: 'm1' })]);
    index.validate('m1', 'now');

    index.completeFromExtraction('m1', { doneEntryId: 'e2', resolution: 'x', doneAt: '2026-08-01T00:00:00Z' });

    const [row] = index.list({ limit: 10 });
    expect(row).toMatchObject({ status: 'open', doneEntryId: null, touched: true });
  });
});

describe('completeDirect', () => {
  it('marks an untouched, extracted to-do done with no source entry', () => {
    index.replaceRaised('e1', [record({ id: 'm1' })]);
    index.completeDirect('m1', '2026-08-01T00:00:00Z');
    const [row] = index.list({ limit: 10 });
    expect(row).toMatchObject({ status: 'done', doneEntryId: null, resolution: null, doneAt: '2026-08-01T00:00:00Z', touched: true });
  });

  it('marks a touched, extracted to-do done too — the direct toggle works at any time', () => {
    index.replaceRaised('e1', [record({ id: 'm1' })]);
    index.validate('m1', 'now');
    index.completeDirect('m1', '2026-08-01T00:00:00Z');
    expect(index.list({ limit: 10 })[0]).toMatchObject({ status: 'done', touched: true });
  });

  it('marks a user-origin to-do done', () => {
    const created = index.createDirect({ id: 'm1', text: 'Water the plants', now: '2026-07-01T00:00:00Z' });
    index.completeDirect(created.id, '2026-08-01T00:00:00Z');
    expect(index.list({ limit: 10 })[0]).toMatchObject({ status: 'done', doneEntryId: null, resolution: null, touched: true });
  });

  it('is a no-op for an id that does not exist', () => {
    expect(() => index.completeDirect('never-existed', 'now')).not.toThrow();
  });

  it('is a no-op against a to-do already done', () => {
    index.replaceRaised('e1', [record({ id: 'm1' })]);
    index.completeDirect('m1', '2026-08-01T00:00:00Z');
    index.completeDirect('m1', '2026-09-01T00:00:00Z');
    expect(index.list({ limit: 10 })[0]).toMatchObject({ doneAt: '2026-08-01T00:00:00Z' });
  });
});

describe('reopen', () => {
  it('reverts a completion without discarding the to-do', () => {
    index.replaceRaised('e1', [record({ id: 'm1' })]);
    index.completeFromExtraction('m1', { doneEntryId: 'e2', resolution: 'Called.', doneAt: '2026-08-01T00:00:00Z' });

    index.reopen('m1');

    const [row] = index.list({ limit: 10 });
    expect(row).toMatchObject({ status: 'open', doneEntryId: null, resolution: null, doneAt: null });
  });

  it('touches the to-do — a future reprocess must not silently re-complete it the same way', () => {
    index.replaceRaised('e1', [record({ id: 'm1' })]);
    index.completeFromExtraction('m1', { doneEntryId: 'e2', resolution: 'wrong match', doneAt: '2026-08-01T00:00:00Z' });

    index.reopen('m1');

    expect(index.list({ limit: 10 })[0]!.touched).toBe(true);
  });

  it('reopens a to-do that was completed directly, with no entry involved', () => {
    index.replaceRaised('e1', [record({ id: 'm1' })]);
    index.completeDirect('m1', '2026-08-01T00:00:00Z');
    index.reopen('m1');
    expect(index.list({ limit: 10 })[0]).toMatchObject({ status: 'open', doneEntryId: null, resolution: null, doneAt: null });
  });
});

describe('createDirect', () => {
  it('creates a user-origin to-do with no source entry, touched immediately', () => {
    const created = index.createDirect({ id: 'm1', text: 'Water the plants', now: '2026-07-01T00:00:00Z' });
    expect(created).toMatchObject({
      id: 'm1',
      entryId: null,
      text: 'Water the plants',
      status: 'open',
      origin: 'user',
      touched: true,
      eventTimeExplicit: false,
    });
  });

  it('appears in list() and listOpen()', () => {
    index.createDirect({ id: 'm1', text: 'Water the plants', now: '2026-07-01T00:00:00Z' });
    expect(index.list({ limit: 10 }).map((r) => r.id)).toEqual(['m1']);
    expect(index.listOpen().map((r) => r.id)).toEqual(['m1']);
  });
});

describe('touching a record directly', () => {
  it('update() edits given fields and sets touched', () => {
    index.replaceRaised('e1', [record({ id: 'm1', text: 'first' })]);
    const updated = index.update('m1', { text: 'corrected' }, 'now');
    expect(updated).toMatchObject({ text: 'corrected', touched: true });
  });

  it('update() returns null for an id that does not exist', () => {
    expect(index.update('never-existed', { text: 'x' }, 'now')).toBeNull();
  });

  it('validate() and untouch() flip the flag with no content change, for an extracted record', () => {
    index.replaceRaised('e1', [record({ id: 'm1' })]);
    index.validate('m1', 'now');
    expect(index.list({ limit: 10 })[0]!.touched).toBe(true);
    index.untouch('m1', 'now');
    expect(index.list({ limit: 10 })[0]!.touched).toBe(false);
  });

  it('untouch() refuses a user-origin record — the load-bearing guard against `clearUntouched` deleting it later', () => {
    const created = index.createDirect({ id: 'm1', text: 'Water the plants', now: '2026-07-01T00:00:00Z' });
    expect(created.touched).toBe(true);

    index.untouch('m1', 'now');

    expect(index.list({ limit: 10 })[0]!.touched).toBe(true);
  });
});

describe('replaceUntouchedRaised / touchedOpenRaisedBy', () => {
  it('protects a touched, still-open to-do raised by this entry', () => {
    index.replaceRaised('e1', [record({ id: 'm1', text: 'keep' }), record({ id: 'm2', text: 'stale' })]);
    index.validate('m1', 'now');

    index.replaceUntouchedRaised('e1', [record({ id: 'm3', text: 'fresh' })]);

    expect(index.list({ limit: 10 }).map((r) => r.id).sort()).toEqual(['m1', 'm3']);
  });

  it('touchedOpenRaisedBy returns only touched, open to-dos raised by this entry', () => {
    index.replaceRaised('e1', [record({ id: 'm1' }), record({ id: 'm2' })]);
    index.validate('m1', 'now');
    expect(index.touchedOpenRaisedBy('e1').map((r) => r.id)).toEqual(['m1']);
  });

  it('a done to-do is never in touchedOpenRaisedBy, touched or not', () => {
    index.replaceRaised('e1', [record({ id: 'm1' })]);
    index.completeFromExtraction('m1', { doneEntryId: 'e2', resolution: 'x', doneAt: '2026-08-01T00:00:00Z' });
    expect(index.touchedOpenRaisedBy('e1')).toEqual([]);
  });

  it('never touches or deletes a user-origin (null-entryId) row', () => {
    index.createDirect({ id: 'u1', text: 'user todo', now: '2026-07-01T00:00:00Z' });
    index.replaceUntouchedRaised('e1', [record({ id: 'm1' })]);
    const rows = index.list({ limit: 10 });
    expect(rows.map((r) => r.id).sort()).toEqual(['m1', 'u1']);
    expect(rows.find((r) => r.id === 'u1')).toMatchObject({ origin: 'user', touched: true });
  });
});

describe('update suggestions', () => {
  it('propose, then approve, applies the proposed text and stays touched', () => {
    index.replaceRaised('e1', [record({ id: 'm1', text: 'original' })]);
    index.validate('m1', 'now');
    index.proposeUpdate({
      id: 's1',
      recordId: 'm1',
      entryId: 'e1',
      text: 'reprocessed text',
      eventTime: record().eventTime,
      eventEpochMs: record().eventEpochMs,
      eventTimeExplicit: true,
      reason: 'reason',
      now: 'now',
    });
    index.decideUpdate('s1', 'approved', 'now');
    expect(index.list({ limit: 10 })[0]).toMatchObject({ text: 'reprocessed text', touched: true });
  });

  it('propose, then reject, leaves the record unchanged', () => {
    index.replaceRaised('e1', [record({ id: 'm1', text: 'original' })]);
    index.validate('m1', 'now');
    index.proposeUpdate({
      id: 's1',
      recordId: 'm1',
      entryId: 'e1',
      text: 'reprocessed text',
      eventTime: record().eventTime,
      eventEpochMs: record().eventEpochMs,
      eventTimeExplicit: true,
      reason: 'reason',
      now: 'now',
    });
    index.decideUpdate('s1', 'rejected', 'now');
    expect(index.list({ limit: 10 })[0]).toMatchObject({ text: 'original' });
    expect(index.listUpdateSuggestions({ status: 'rejected' })).toHaveLength(1);
  });

  it('a second proposal while one is pending is a no-op', () => {
    index.replaceRaised('e1', [record({ id: 'm1' })]);
    index.validate('m1', 'now');
    index.proposeUpdate({
      id: 's1',
      recordId: 'm1',
      entryId: 'e1',
      text: 'first proposal',
      eventTime: record().eventTime,
      eventEpochMs: record().eventEpochMs,
      eventTimeExplicit: true,
      reason: 'reason',
      now: 'now',
    });
    index.proposeUpdate({
      id: 's2',
      recordId: 'm1',
      entryId: 'e1',
      text: 'second proposal',
      eventTime: record().eventTime,
      eventEpochMs: record().eventEpochMs,
      eventTimeExplicit: true,
      reason: 'reason',
      now: 'now',
    });
    expect(index.listUpdateSuggestions({ status: 'pending' }).map((s) => s.text)).toEqual(['first proposal']);
  });
});

describe('completion suggestions', () => {
  it('propose, then approve, marks the record done without disturbing touched', () => {
    index.replaceRaised('e1', [record({ id: 'm1' })]);
    index.validate('m1', 'now');
    index.proposeCompletion({
      id: 's1',
      recordId: 'm1',
      entryId: 'e2',
      resolution: 'Called and rescheduled.',
      reason: 'Reprocessing found this entry marks it done.',
      now: 'now',
    });

    index.decideCompletion('s1', 'approved', '2026-08-01T00:00:00Z');

    const [row] = index.list({ limit: 10 });
    expect(row).toMatchObject({
      status: 'done',
      doneEntryId: 'e2',
      resolution: 'Called and rescheduled.',
      doneAt: '2026-08-01T00:00:00Z',
      touched: true,
    });
  });

  it('propose, then reject, leaves the record open and untouched by the suggestion', () => {
    index.replaceRaised('e1', [record({ id: 'm1' })]);
    index.validate('m1', 'now');
    index.proposeCompletion({
      id: 's1',
      recordId: 'm1',
      entryId: 'e2',
      resolution: 'x',
      reason: 'reason',
      now: 'now',
    });

    index.decideCompletion('s1', 'rejected', 'now');

    expect(index.list({ limit: 10 })[0]).toMatchObject({ status: 'open', doneEntryId: null });
    expect(index.listCompletionSuggestions({ status: 'rejected' })).toHaveLength(1);
  });

  it('a second proposal while one is pending is a no-op', () => {
    index.replaceRaised('e1', [record({ id: 'm1' })]);
    index.validate('m1', 'now');
    index.proposeCompletion({ id: 's1', recordId: 'm1', entryId: 'e2', resolution: 'first', reason: 'r', now: 'now' });
    index.proposeCompletion({ id: 's2', recordId: 'm1', entryId: 'e3', resolution: 'second', reason: 'r', now: 'now' });
    expect(index.listCompletionSuggestions({ status: 'pending' }).map((s) => s.resolution)).toEqual(['first']);
  });
});

describe('removeEntry', () => {
  it('removes only the to-dos this entry raised', () => {
    index.replaceRaised('e1', [record({ id: 'm1' })]);
    index.replaceRaised('e2', [record({ id: 'm2' })]);
    index.removeEntry('e1');
    expect(index.list({ limit: 10 }).map((r) => r.id)).toEqual(['m2']);
  });

  it('reopens a to-do this entry had marked done, rather than leaving a dangling reference', () => {
    index.replaceRaised('e1', [record({ id: 'm1' })]);
    index.completeFromExtraction('m1', { doneEntryId: 'e2', resolution: 'Called.', doneAt: '2026-08-01T00:00:00Z' });

    index.removeEntry('e2');

    const [row] = index.list({ limit: 10 });
    expect(row).toMatchObject({ id: 'm1', status: 'open', doneEntryId: null, resolution: null });
  });

  it('never matches a user-origin (null-entryId) row', () => {
    index.createDirect({ id: 'u1', text: 'user todo', now: '2026-07-01T00:00:00Z' });
    index.removeEntry('e1');
    expect(index.list({ limit: 10 }).map((r) => r.id)).toEqual(['u1']);
  });
});

describe('remove', () => {
  it('discards a single record entirely, extracted or user-origin', () => {
    index.replaceRaised('e1', [record({ id: 'm1' })]);
    index.createDirect({ id: 'm2', text: 'user todo', now: '2026-07-01T00:00:00Z' });
    index.remove('m1');
    index.remove('m2');
    expect(index.list({ limit: 10 })).toEqual([]);
  });

  it('is a no-op for an id that does not exist', () => {
    expect(() => index.remove('never-existed')).not.toThrow();
  });
});

describe('listOpen', () => {
  it('returns only open to-dos, oldest first, including user-origin ones', () => {
    index.replaceRaised('e1', [record({ id: 'newer', eventEpochMs: Date.parse('2026-07-20T00:00:00Z') })]);
    index.replaceRaised('e2', [record({ id: 'older', eventEpochMs: Date.parse('2026-01-01T00:00:00Z') })]);
    index.replaceRaised('e3', [record({ id: 'done', status: 'done', doneEntryId: 'e4', resolution: 'x' })]);
    index.createDirect({ id: 'user', text: 'user todo', now: '2026-03-01T00:00:00Z' });
    expect(index.listOpen().map((r) => r.id)).toEqual(['older', 'user', 'newer']);
  });

  it('is empty when nothing is open', () => {
    expect(index.listOpen()).toEqual([]);
  });
});

describe('summarize / stats / clear', () => {
  it('counts open and done separately', () => {
    index.replaceRaised('e1', [record({ id: 'm1', status: 'open' })]);
    index.replaceRaised('e2', [record({ id: 'm2', status: 'done', doneEntryId: 'e3', resolution: 'x' })]);
    expect(index.summarize()).toEqual({ openCount: 1, doneCount: 1 });
    expect(index.stats()).toEqual({ todoCount: 2, openCount: 1, doneCount: 1 });
  });

  it('is all zero when nothing has been extracted', () => {
    expect(index.summarize()).toEqual({ openCount: 0, doneCount: 0 });
    expect(index.stats()).toEqual({ todoCount: 0, openCount: 0, doneCount: 0 });
  });

  it('clear wipes everything, including user-origin rows', () => {
    index.replaceRaised('e1', [record({ id: 'm1' })]);
    index.createDirect({ id: 'm2', text: 'user todo', now: '2026-07-01T00:00:00Z' });
    index.clear();
    expect(index.stats()).toEqual({ todoCount: 0, openCount: 0, doneCount: 0 });
  });

  it('clearUntouched wipes untouched rows but leaves a touched extracted one and every user-origin row in place', () => {
    index.replaceRaised('e1', [record({ id: 'm1' })]);
    index.replaceRaised('e2', [record({ id: 'm2' })]);
    index.validate('m1', 'now');
    index.createDirect({ id: 'm3', text: 'user todo', now: '2026-07-01T00:00:00Z' });

    index.clearUntouched();

    expect(index.list({ limit: 10 }).map((r) => r.id).sort()).toEqual(['m1', 'm3']);
  });

  it('clearUntouched still leaves a user-origin row in place even after an attempted untouch() — proves the guard closes the loophole end-to-end', () => {
    index.createDirect({ id: 'u1', text: 'user todo', now: '2026-07-01T00:00:00Z' });
    index.untouch('u1', 'now');

    index.clearUntouched();

    expect(index.list({ limit: 10 }).map((r) => r.id)).toEqual(['u1']);
  });
});
