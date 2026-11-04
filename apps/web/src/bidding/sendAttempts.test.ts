import { describe, expect, it } from 'vitest';
import { applyFeedback, dropFieldAttempt, emptyAttemptStore, feedbackSignature, holdsLock, rejectAttempt, startAttempt, type AttemptStore } from './sendAttempts';

const CTX = 'ctx', B1 = 'binding-1', B2 = 'binding-2';
const start = (store: AttemptStore, kind: 'BID' | 'PASS' = 'PASS', bindingKey = B1) => startAttempt(store, { contextKey: CTX, bindingKey, kind, fieldAttemptId: kind === 'BID' ? `${CTX}|${bindingKey}#1` : null });
const must = <T,>(value: T | null): T => { if (value === null) throw new Error('expected a value'); return value; };

describe('N10 send attempts: one state machine for every answer', () => {
  it('a refused field submit is remembered, never sends, and is cleared by the next real attempt', () => {
    const pass = must(start(emptyAttemptStore, 'PASS'));
    expect(startAttempt(pass.store, { contextKey: CTX, bindingKey: B1, kind: 'BID', fieldAttemptId: 'f#1' })).toBeNull(); // blocked: nothing is sent
    const dropped = dropFieldAttempt(pass.store, { contextKey: CTX, bindingKey: B1, fieldAttemptId: 'f#1' });
    expect(dropped.dropped).toEqual({ contextKey: CTX, bindingKey: B1, fieldAttemptId: 'f#1' });
    expect(dropped.current).toBe(pass.store.current); // the pass attempt is untouched
    const released = rejectAttempt(dropped, 'a1', 'x');
    expect(must(start(released, 'BID')).store.dropped).toBeNull();
  });
  it('starts an attempt per press; bid and pass share ONE lock per binding; another binding or context is free', () => {
    const a = must(start(emptyAttemptStore, 'BID'));
    expect(a.attempt).toMatchObject({ id: 'a1', kind: 'BID', outcome: 'SENT', fieldAttemptId: `${CTX}|${B1}#1` });
    expect(holdsLock(a.store, CTX, B1)).toBe(true);
    expect(start(a.store, 'PASS')).toBeNull(); // a pass right after a bid on the same binding
    expect(start(a.store, 'BID')).toBeNull();
    expect(start(a.store, 'PASS', B2)).not.toBeNull(); // another binding
    expect(startAttempt(a.store, { contextKey: 'other', bindingKey: B1, kind: 'PASS' })).not.toBeNull(); // another context
  });
  it('a rejected promise releases exactly ITS attempt; the rejection of an older attempt changes nothing', () => {
    const a1 = must(start(emptyAttemptStore));
    const released = rejectAttempt(a1.store, a1.attempt.id, 'x');
    expect(released.current).toMatchObject({ id: 'a1', outcome: 'REJECTED', message: 'x' });
    expect(holdsLock(released, CTX, B1)).toBe(false);
    const a2 = must(start(released));
    expect(a2.attempt.id).toBe('a2');
    expect(rejectAttempt(a2.store, 'a1', 'late')).toBe(a2.store); // the same object: nothing happened
    expect(holdsLock(a2.store, CTX, B1)).toBe(true);
    expect(rejectAttempt(a2.store, 'unknown', 'x')).toBe(a2.store);
  });
  it('a report is applied ONCE; a repeated old report and an equal object are ignored; a NEW report with identical text is distinguishable by id or attemptId', () => {
    const a1 = must(start(emptyAttemptStore));
    const r1 = { bindingKey: B1, status: 'REJECTED' as const, message: 'M', id: 1 };
    const after1 = applyFeedback(a1.store, r1, CTX);
    expect(after1.current?.outcome).toBe('REJECTED');
    const a2 = must(start(after1));
    expect(applyFeedback(a2.store, { ...r1 }, CTX).current?.outcome).toBe('SENT'); // the SAME report again (new object): consumed, a2 stays in flight
    const after2 = applyFeedback(a2.store, { ...r1, id: 2 }, CTX); // identical text, new id
    expect(after2.current).toMatchObject({ id: 'a2', outcome: 'REJECTED' });
    const a3 = must(start(after2));
    expect(applyFeedback(a3.store, { ...r1, id: 1 }, CTX).current?.outcome).toBe('SENT'); // an OLD report (id 1) after id 2 was seen: still consumed
    expect(applyFeedback(a3.store, { bindingKey: B1, status: 'REJECTED', message: 'M', attemptId: 'a3' }, CTX).current?.outcome).toBe('REJECTED'); // distinguishable by attemptId
  });
  it('a report that names another attempt, binding or context only becomes consumed; settled attempts ignore later reports; PENDING never un-settles', () => {
    const a1 = must(start(emptyAttemptStore));
    const rejected = rejectAttempt(a1.store, 'a1', null);
    const a2 = must(start(rejected));
    const foreignAttempt = applyFeedback(a2.store, { bindingKey: B1, status: 'REJECTED', attemptId: 'a1', id: 5 }, CTX);
    expect(foreignAttempt.current?.outcome).toBe('SENT');
    expect(foreignAttempt.consumed).toContain(feedbackSignature({ bindingKey: B1, status: 'REJECTED', attemptId: 'a1', id: 5 }));
    expect(applyFeedback(a2.store, { bindingKey: B2, status: 'REJECTED', id: 6 }, CTX).current?.outcome).toBe('SENT');
    expect(applyFeedback(a2.store, { bindingKey: B1, status: 'REJECTED', id: 7 }, 'other-context').current?.outcome).toBe('SENT');
    const pending = applyFeedback(a2.store, { bindingKey: B1, status: 'PENDING', id: 8 }, CTX);
    expect(pending.current?.outcome).toBe('PENDING');
    expect(holdsLock(pending, CTX, B1)).toBe(true);
    const accepted = applyFeedback(pending, { bindingKey: B1, status: 'ACCEPTED', id: 9 }, CTX);
    expect(accepted.current?.outcome).toBe('ACCEPTED');
    expect(holdsLock(accepted, CTX, B1)).toBe(true); // accepted: the binding stays locked until a new projection brings a new one
    expect(applyFeedback(accepted, { bindingKey: B1, status: 'REJECTED', id: 10 }, CTX).current?.outcome).toBe('ACCEPTED'); // final for the attempt
    expect(rejectAttempt(accepted, 'a2', 'x')).toBe(accepted);
  });
  it('the consumed list is bounded and the store is immutable', () => {
    let store = must(start(emptyAttemptStore)).store;
    const frozen = JSON.stringify(store);
    for (let i = 0; i < 200; i++) store = applyFeedback(store, { bindingKey: 'x', status: 'PENDING', id: i }, CTX);
    expect(store.consumed.length).toBe(64);
    const a = must(start(emptyAttemptStore));
    expect(JSON.stringify(a.store)).not.toBe(frozen + 'x');
    expect(emptyAttemptStore).toEqual({ seq: 0, current: null, consumed: [], dropped: null });
  });
});
