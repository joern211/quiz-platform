import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { SubmissionRecordSchema, type CoreTimer } from '@quiz/shared';
import { applyStateEvent, createStateEvent, type EngineStateSnapshot } from '@quiz/game-sdk';
import { ORDERING_ERROR_CODES, strictOrderingReference, type OrderingConfig, type OrderingItemDef } from '@quiz/shared/ordering';
import { gameErrorCode } from './errors.js';
import { getGameEngineContract } from './engineContract.js';
import { createTimer, endTimer, pauseTimer, resumeTimer, submitOnce } from './runtimePrimitives.js';
import { createWerIstDasState } from '../weristdas/state.js';
import { createNumericRound, parseNumericRoundState } from './numericSubmission.js';
import { createTextCardRound, parseTextCardRoundState } from './textCardSubmission.js';
import type { CoreActionContext } from './actionRules.js';
import {
  closeOrderingRound, compareOrderingSubmission, createOrderingRound, orderingOutcome, orderingRef, orderingScopeOf, orderingStatus,
  parseOrderingRoundState, projectOrderingRound, projectOrderingSolution, submitOrdering, type OrderingRoundState,
} from './orderingSubmission.js';

// Synthetic fixtures: ids and revisions are NOT game presets and carry no value, date or rank.
const item = (itemId: string, over: Partial<OrderingItemDef> = {}): OrderingItemDef => ({ itemId, label: `Eintrag ${itemId}`, help: null, ...over });
const config: OrderingConfig = { schemaVersion: 1, prompt: null, directionHint: null, items: ['aa', 'bb', 'cc', 'dd'].map(id => item(id)) };
const order = (...ids: string[]) => ({ schemaVersion: 1, itemIds: ids });
const REF = strictOrderingReference('rev-1', ['cc', 'aa', 'dd', 'bb']); // correct: cc, aa, dd, bb
const fresh = (over: Partial<{ runIndex: number; roundId: string; referenceRevision: string | null }> = {}) =>
  createOrderingRound({ runIndex: 2, roundId: 'round-7', config, referenceRevision: 'rev-1', ...over });
const timer = createTimer('COUNTDOWN', 1000, 20000); // accepts input until 21000 (exclusive)
const submit = (state: OrderingRoundState, participantId: string, input: unknown, now = 5000, t: CoreTimer = timer) =>
  submitOrdering(state, { scope: orderingScopeOf(state), participantId, input, timer: t, now });
const close = (state: OrderingRoundState, now = 8000) => closeOrderingRound(state, orderingScopeOf(state), now);
const compare = (state: OrderingRoundState, participantId: string, reference: unknown = REF, now = 9000) =>
  compareOrderingSubmission(state, orderingScopeOf(state), { participantId, submissionRef: orderingRef(state, participantId) as string, reference, now });
const err = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as Error).message; } return 'NO_ERROR'; };

describe('N3 atomic submission', () => {
  it('accepts one complete order bound to owner, run, round, config and reference revision; nothing else changes', () => {
    const s0 = fresh();
    const s1 = submit(s0, 'p1', order('dd', 'cc', 'bb', 'aa'));
    expect(s1.records).toHaveLength(1);
    expect(s1.records[0]).toMatchObject({ participantId: 'p1', submittedAtMs: 5000, comparison: null, comparedAtMs: null });
    expect(s1.records[0].order.itemIds).toEqual(['dd', 'cc', 'bb', 'aa']);
    expect(s0.records).toEqual([]); // the previous state is untouched
    expect(orderingStatus(s1, 'p1')).toBe('SUBMITTED');
    expect(orderingStatus(s1, 'nobody')).toBeNull();
    expect(s1.referenceRevision).toBe('rev-1');
    expect(JSON.stringify(s1)).not.toMatch(/"groups"/); // the reference itself is not part of the state
  });
  it('accepts the unchanged start order as a valid submission', () => {
    const s = submit(fresh(), 'p1', order('aa', 'bb', 'cc', 'dd'));
    expect(s.records[0].order.itemIds).toEqual(['aa', 'bb', 'cc', 'dd']);
  });
  it('is all-or-nothing: an invalid list leaves no partial order, no slot burnt and an unchanged state', () => {
    const s1 = submit(fresh(), 'p1', order('aa', 'bb', 'cc', 'dd'));
    const before = JSON.stringify(s1);
    for (const bad of [order('aa', 'bb', 'cc'), order('aa', 'bb', 'cc', 'dd', 'ee'), order('aa', 'aa', 'cc', 'dd'), order('aa', 'bb', 'cc', 'zz'),
      order(), { ...order('aa', 'bb', 'cc', 'dd'), extra: 1 }, { schemaVersion: 2, itemIds: ['aa', 'bb', 'cc', 'dd'] }, null, 'aa,bb,cc,dd']) {
      let thrown: unknown;
      try { submit(s1, 'p2', bad); } catch (e) { thrown = e; }
      expect((thrown as Error).message).toBe('ORDERING_INVALID');
      expect((thrown as { issues: unknown[] }).issues.length).toBeGreaterThan(0);
      expect(gameErrorCode(thrown)).toBe('ORDERING_INVALID');
    }
    expect(JSON.stringify(s1)).toBe(before);
    expect(submit(s1, 'p2', order('dd', 'cc', 'bb', 'aa')).records.map(r => r.participantId)).toEqual(['p1', 'p2']);
  });
  it('error issues carry configured item ids only — never submitted strings', () => {
    try { submit(fresh(), 'p1', order('aa', 'GEHEIME-ID', 'cc', '__proto__')); } catch (e) {
      const text = JSON.stringify([(e as Error).message, (e as { issues: unknown }).issues]);
      expect(text).toContain('bb');
      expect(text).not.toMatch(/GEHEIME|__proto__/);
    }
  });
  it('never lets a second ordinary submission replace an accepted order', () => {
    const s1 = submit(fresh(), 'p1', order('aa', 'bb', 'cc', 'dd'));
    expect(err(() => submit(s1, 'p1', order('dd', 'cc', 'bb', 'aa'), 5100))).toBe('ALREADY_ANSWERED');
    expect(s1.records[0].order.itemIds).toEqual(['aa', 'bb', 'cc', 'dd']);
    expect(err(() => submit(s1, 'p1', order('aa', 'bb', 'cc', 'dd'), 5100))).toBe('ALREADY_ANSWERED'); // also the identical one
  });
  it('rejects a wrong scope instead of re-attaching: other run, other round, changed or re-shuffled set, other reference revision', () => {
    const s = fresh();
    const scope = orderingScopeOf(s);
    const go = (over: Partial<typeof scope>) => err(() => submitOrdering(s, { scope: { ...scope, ...over }, participantId: 'p', input: order('aa', 'bb', 'cc', 'dd'), timer, now: 5000 }));
    expect(go({ runIndex: 3 })).toBe('STALE_ROUND');
    expect(go({ roundId: 'round-8' })).toBe('STALE_ROUND');
    expect(go({ configKey: JSON.stringify([1, ['bb', 'aa', 'cc', 'dd']]) })).toBe('ORDERING_CONFIG_STALE'); // re-shuffled start order
    expect(go({ configKey: JSON.stringify([1, ['aa', 'bb', 'cc', 'ee']]) })).toBe('ORDERING_CONFIG_STALE'); // changed item set
    expect(go({ referenceRevision: 'rev-2' })).toBe('ORDERING_REFERENCE_STALE');
    expect(go({ referenceRevision: null })).toBe('ORDERING_REFERENCE_STALE');
    expect(go({})).toBe('NO_ERROR');
    // a pure label change is the same scope (labels are not identity)
    const relabeled = createOrderingRound({ runIndex: 2, roundId: 'round-7', referenceRevision: 'rev-1', config: { ...config, items: config.items.map(i => ({ ...i, label: 'Neu' })) } });
    expect(orderingScopeOf(relabeled)).toEqual(scope);
  });
  it('allows an order up to the last open millisecond; deadline, pause and expiry reject; time is validated', () => {
    expect(submit(fresh(), 'p1', order('aa', 'bb', 'cc', 'dd'), 20999).records).toHaveLength(1);
    expect(err(() => submit(fresh(), 'p1', order('aa', 'bb', 'cc', 'dd'), 21000))).toBe('TIME_EXPIRED');
    expect(err(() => submit(fresh(), 'p1', order('aa', 'bb', 'cc', 'dd'), 99000))).toBe('TIME_EXPIRED');
    const paused = pauseTimer(timer, 6000);
    expect(err(() => submit(fresh(), 'p1', order('aa', 'bb', 'cc', 'dd'), 6500, paused))).toBe('TIME_EXPIRED');
    const resumed = resumeTimer(paused, 7000);
    expect(submit(fresh(), 'p1', order('aa', 'bb', 'cc', 'dd'), 7100, resumed).records).toHaveLength(1);
    expect(err(() => submit(fresh(), 'p1', order('aa', 'bb', 'cc', 'dd'), 6500, endTimer(timer, 6000)))).toBe('TIME_EXPIRED');
    for (const now of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) expect(err(() => submit(fresh(), 'p1', order('aa', 'bb', 'cc', 'dd'), now)), String(now)).toBe('INVALID_TIME');
  });
});

describe('N3 lock: the round closes, not just the existing records', () => {
  it('after closing, nobody can submit — also a participant without a record, while the external timer still runs', () => {
    const s1 = submit(fresh(), 'p1', order('aa', 'bb', 'cc', 'dd'));
    const closed = close(s1);
    expect(timer.status).toBe('RUNNING');
    expect(err(() => submit(closed, 'p2', order('aa', 'bb', 'cc', 'dd'), 8100))).toBe('ORDERING_ROUND_CLOSED');
    expect(err(() => submit(closed, 'p1', order('aa', 'bb', 'cc', 'dd'), 8100))).toBe('ORDERING_ROUND_CLOSED');
    expect(closed.records).toHaveLength(1);
  });
  it('locking an empty round closes the acceptance path as well', () => {
    const closed = close(fresh(), 3000);
    expect(closed).toMatchObject({ status: 'CLOSED', closedAtMs: 3000, records: [] });
    expect(err(() => submit(closed, 'first', order('aa', 'bb', 'cc', 'dd'), 3100))).toBe('ORDERING_ROUND_CLOSED');
  });
  it('closing is idempotent and does not move the close time', () => {
    const s1 = submit(fresh(), 'p1', order('aa', 'bb', 'cc', 'dd'));
    const c1 = close(s1, 8000), c2 = closeOrderingRound(c1, orderingScopeOf(c1), 15000);
    expect(c2).toEqual(c1);
    expect(c2.closedAtMs).toBe(8000);
    expect(JSON.stringify(c2)).toBe(JSON.stringify(c1));
  });
  it('refuses a close time before an accepted submission and a wrong scope; derives status from the round', () => {
    const s1 = submit(fresh(), 'p1', order('aa', 'bb', 'cc', 'dd'), 5000);
    expect(err(() => close(s1, 4000))).toBe('INVALID_TIME');
    expect(err(() => closeOrderingRound(s1, { ...orderingScopeOf(s1), roundId: 'other' }, 6000))).toBe('STALE_ROUND');
    expect(err(() => closeOrderingRound(s1, orderingScopeOf(s1), -5))).toBe('INVALID_TIME');
    expect(orderingStatus(s1, 'p1')).toBe('SUBMITTED');
    const closed = close(s1);
    expect(orderingStatus(closed, 'p1')).toBe('LOCKED');
    expect(orderingStatus(compare(closed, 'p1').state, 'p1')).toBe('COMPARED');
    expect(Object.keys(closed.records[0]).sort()).toEqual(['comparedAtMs', 'comparison', 'order', 'participantId', 'submittedAtMs']); // no stored status field to contradict
  });
});

describe('N3 comparison takeover: server-side, bound to one accepted order and the pinned reference', () => {
  const closedWith = (...entries: Array<[string, string[]]>) => close(entries.reduce((s, [id, ids]) => submit(s, id, order(...ids), 5000), fresh()));
  it('compares only after the round is closed', () => {
    const open = submit(fresh(), 'p1', order('cc', 'aa', 'dd', 'bb'));
    expect(err(() => compare(open, 'p1'))).toBe('ORDERING_NOT_CLOSED');
  });
  it('stores facts computed from the reference, never a client verdict, and never touches the order', () => {
    const closed = closedWith(['p1', ['cc', 'aa', 'dd', 'bb']], ['p2', ['dd', 'cc', 'bb', 'aa']], ['p3', ['cc', 'aa', 'bb', 'dd']]);
    const r1 = compare(closed, 'p1'), r2 = compare(r1.state, 'p2'), r3 = compare(r2.state, 'p3');
    expect(r1).toMatchObject({ applied: true, changed: true });
    const byId = Object.fromEntries(r3.state.records.map(r => [r.participantId, r]));
    expect(byId.p1.comparison).toMatchObject({ matchedPositions: 4, complete: true, referenceRevision: 'rev-1', contract: 'ORDERING_POSITION_MATCH_V1' });
    expect(byId.p2.comparison).toMatchObject({ matchedPositions: 0, complete: false }); // checked with 0 matches
    expect(byId.p3.comparison).toMatchObject({ matchedPositions: 2, complete: false });
    expect(byId.p1.comparedAtMs).toBe(9000);
    for (const record of r3.state.records) expect(record.order).toEqual(closed.records.find(c => c.participantId === record.participantId)?.order);
    expect(closed.records.every(r => r.comparison === null)).toBe(true); // the input state is untouched
  });
  it('tells "no submission", "not checked" and "checked with 0 matching positions" apart', () => {
    const closed = closedWith(['p1', ['dd', 'cc', 'bb', 'aa']], ['p2', ['cc', 'aa', 'dd', 'bb']]);
    expect(orderingOutcome(closed, 'nobody')).toEqual({ kind: 'NO_SUBMISSION' });
    expect(orderingOutcome(closed, 'p1')).toEqual({ kind: 'NOT_CHECKED' });
    const checked = compare(closed, 'p1').state;
    const zero = orderingOutcome(checked, 'p1');
    expect(zero.kind).toBe('CHECKED');
    expect(zero.kind === 'CHECKED' && zero.comparison.matchedPositions).toBe(0);
    expect(orderingOutcome(checked, 'p2')).toEqual({ kind: 'NOT_CHECKED' }); // another participant is not affected
  });
  it('without a configured reference nothing is called right or wrong: the call is refused', () => {
    const noRef = createOrderingRound({ runIndex: 2, roundId: 'round-7', config, referenceRevision: null });
    const closed = close(submit(noRef, 'p1', order('cc', 'aa', 'dd', 'bb')));
    expect(err(() => compare(closed, 'p1'))).toBe('ORDERING_REFERENCE_MISSING');
    expect(orderingOutcome(closed, 'p1')).toEqual({ kind: 'NOT_CHECKED' });
    const pinned = closedWith(['p1', ['cc', 'aa', 'dd', 'bb']]);
    expect(err(() => compare(pinned, 'p1', null))).toBe('ORDERING_REFERENCE_MISSING');
    const call = (reference: unknown) => compareOrderingSubmission(pinned, orderingScopeOf(pinned), { participantId: 'p1', submissionRef: orderingRef(pinned, 'p1') as string, reference, now: 9000 });
    expect(err(() => call(undefined))).toBe('ORDERING_REFERENCE_MISSING');
  });
  it('rejects a wrong reference revision, an invalid reference, another item set and a stale or foreign submission reference', () => {
    const closed = closedWith(['p1', ['cc', 'aa', 'dd', 'bb']], ['p2', ['aa', 'bb', 'cc', 'dd']]);
    expect(err(() => compare(closed, 'p1', strictOrderingReference('rev-2', ['cc', 'aa', 'dd', 'bb'])))).toBe('ORDERING_REFERENCE_STALE');
    expect(err(() => compare(closed, 'p1', strictOrderingReference('rev-1', ['cc', 'aa', 'dd'])))).toBe('ORDERING_REFERENCE_INVALID');
    expect(err(() => compare(closed, 'p1', strictOrderingReference('rev-1', ['cc', 'aa', 'dd', 'zz'])))).toBe('ORDERING_REFERENCE_INVALID');
    expect(err(() => compare(closed, 'p1', { ...(REF as object), extra: 1 }))).toBe('ORDERING_REFERENCE_INVALID');
    const scope = orderingScopeOf(closed);
    const go = (participantId: string, submissionRef: string) => err(() => compareOrderingSubmission(closed, scope, { participantId, submissionRef, reference: REF, now: 9000 }));
    expect(go('p1', orderingRef(closed, 'p2') as string)).toBe('ORDERING_STALE_SUBMISSION'); // another owner's order
    expect(go('p1', '1|old-round|p1|5000')).toBe('ORDERING_STALE_SUBMISSION'); // an older run/round
    expect(go('p1', `${orderingRef(closed, 'p1')}x`)).toBe('ORDERING_STALE_SUBMISSION');
    expect(go('ghost', orderingRef(closed, 'p1') as string)).toBe('ORDERING_NOT_FOUND');
    expect(err(() => compareOrderingSubmission(closed, { ...scope, runIndex: 9 }, { participantId: 'p1', submissionRef: orderingRef(closed, 'p1') as string, reference: REF, now: 9000 }))).toBe('STALE_ROUND');
    expect(err(() => compareOrderingSubmission(closed, scope, { participantId: 'p1', submissionRef: orderingRef(closed, 'p1') as string, reference: REF, now: 7000 }))).toBe('INVALID_TIME'); // before the close
    expect(closed.records.every(r => r.comparison === null)).toBe(true);
  });
  it('repeating the identical takeover is idempotent: applied/changed false, no new time, identical state', () => {
    const once = compare(closedWith(['p1', ['cc', 'aa', 'dd', 'bb']]), 'p1');
    const again = compare(once.state, 'p1', REF, 99999);
    expect(again).toMatchObject({ applied: false, changed: false });
    expect(again.state.records[0].comparedAtMs).toBe(9000);
    expect(JSON.stringify(again.state)).toBe(JSON.stringify(once.state));
  });
  it('does not silently overwrite a differing result: the same revision with other groups is refused', () => {
    const once = compare(closedWith(['p1', ['cc', 'aa', 'dd', 'bb']]), 'p1');
    const different = strictOrderingReference('rev-1', ['aa', 'cc', 'dd', 'bb']); // same revision label, different content: 2 of 4 would match
    expect(err(() => compare(once.state, 'p1', different))).toBe('ORDERING_ALREADY_COMPARED');
    expect(once.state.records[0].comparison?.matchedPositions).toBe(4);
    // a different reference that happens to give the identical facts is the same takeover, not a conflict
    expect(compare(once.state, 'p1', { schemaVersion: 1, revision: 'rev-1', groups: [['cc', 'aa', 'dd', 'bb']] })).toMatchObject({ applied: false, changed: false });
  });
  it('writes no points, ranks or winners and calls neither clock nor randomness', () => {
    const now = vi.spyOn(Date, 'now'), random = vi.spyOn(Math, 'random');
    try {
      const s = compare(closedWith(['p1', ['cc', 'aa', 'dd', 'bb']], ['p2', ['dd', 'cc', 'bb', 'aa']]), 'p1').state;
      expect(Object.keys(s).sort()).toEqual(['closedAtMs', 'config', 'kind', 'records', 'referenceRevision', 'roundId', 'runIndex', 'schemaVersion', 'status']);
      expect(JSON.stringify(s)).not.toMatch(/score|points|winner|rank|isCorrect/i);
      expect(now).not.toHaveBeenCalled();
      expect(random).not.toHaveBeenCalled();
    } finally { now.mockRestore(); random.mockRestore(); }
  });
  it('shares no object between input, old state, new state and the outcome', () => {
    const closed = closedWith(['p1', ['cc', 'aa', 'dd', 'bb']]);
    const { state } = compare(closed, 'p1');
    expect(state.records[0]).not.toBe(closed.records[0]);
    expect(state.records[0].order).not.toBe(closed.records[0].order);
    const outcome = orderingOutcome(state, 'p1');
    if (outcome.kind !== 'CHECKED') throw new Error('checked');
    outcome.comparison.positions[0].matches = false;
    expect(orderingOutcome(state, 'p1')).toMatchObject({ kind: 'CHECKED', comparison: { matchedPositions: 4 } });
    expect(state.records[0].comparison?.positions[0].matches).toBe(true);
  });
});

describe('N3 serialization, corruption and SDK replay', () => {
  const reachable = () => {
    const s1 = submit(submit(fresh(), 'p1', order('cc', 'aa', 'dd', 'bb')), 'p2', order('dd', 'cc', 'bb', 'aa'), 5100);
    const s2 = close(s1);
    const s3 = compare(compare(s2, 'p1').state, 'p2').state;
    return { s1, s2, s3 };
  };
  it('roundtrips open, closed and compared states through JSON unchanged', () => {
    const { s1, s2, s3 } = reachable();
    for (const s of [fresh(), s1, s2, s3]) {
      const decoded = JSON.parse(JSON.stringify(s));
      expect(decoded).toEqual(s);
      expect(parseOrderingRoundState(decoded)).toEqual(s);
    }
  });
  it('rejects corrupt, foreign, legacy or tampered stored data in a controlled way — and does not repair by re-shuffling', () => {
    const { s3 } = reachable();
    const g = JSON.parse(JSON.stringify(s3));
    const rec = (patch: object, index = 0) => ({ ...g, records: g.records.map((r: object, i: number) => (i === index ? { ...r, ...patch } : r)) });
    const cmp = (patch: object) => rec({ comparison: { ...g.records[0].comparison, ...patch } });
    const bad: unknown[] = [null, undefined, 'x', [], {}, { ...g, kind: 'TEXT_CARD_ROUND' }, { ...g, schemaVersion: 2 }, { ...g, runIndex: 0 }, { ...g, extra: 1 },
      { ...g, status: 'OPEN' }, { ...g, closedAtMs: null }, { ...g, records: [g.records[0], g.records[0]] },
      rec({ order: { schemaVersion: 1, itemIds: ['cc', 'aa', 'dd', 'dd'] } }), // not a permutation
      rec({ order: { schemaVersion: 1, itemIds: ['cc', 'aa', 'dd'] } }), // partial
      rec({ order: { schemaVersion: 1, itemIds: ['cc', 'aa', 'dd', 'zz'] } }), // foreign id
      rec({ order: { schemaVersion: 1, itemIds: [] } }),
      rec({ order: { schemaVersion: 1, itemIds: 'cc,aa,dd,bb' } }),
      rec({ participantId: 7 }), rec({ submittedAtMs: -1 }), rec({ extra: true }), rec({ submittedAtMs: 9999 }), // accepted after the close
      rec({ comparison: null }), rec({ comparedAtMs: null }), rec({ comparedAtMs: 7999 }), // half-set or before the close
      cmp({ matchedPositions: 2 }), cmp({ complete: false }), cmp({ referenceRevision: 'rev-2' }), cmp({ itemCount: 3 }), cmp({ contract: 'OTHER' }),
      cmp({ positions: [...g.records[0].comparison.positions].reverse() }),
      { ...g, referenceRevision: null }, // a comparison without a pinned reference
      { ...g, status: 'OPEN', closedAtMs: null }, // compared before close
      { ...g, config: { ...g.config, items: [g.config.items[0]] } },
      { ...g, records: [{ participantId: 'p1', value: 'A', status: 'SUBMITTED', roundId: 'r', submittedAtMs: 1, judgedAtMs: null, decision: null }] }, // legacy string record
    ];
    for (const raw of bad) {
      expect(err(() => parseOrderingRoundState(raw)), JSON.stringify(raw)?.slice(0, 90)).toBe('ORDERING_STATE_INVALID');
      expect(err(() => submitOrdering(raw, { scope: orderingScopeOf(s3), participantId: 'z', input: order('aa', 'bb', 'cc', 'dd'), timer, now: 5000 }))).toBe('ORDERING_STATE_INVALID');
      expect(err(() => orderingOutcome(raw, 'p1'))).toBe('ORDERING_STATE_INVALID');
    }
    expect(err(() => createOrderingRound({ runIndex: 1, roundId: 'r', referenceRevision: 'x', config: { ...config, items: [item('aa'), item('aa')] } }))).toBe('ORDERING_CONFIG_INVALID');
    expect(err(() => createOrderingRound({ runIndex: 0, roundId: 'r', referenceRevision: 'x', config }))).toBe('ORDERING_STATE_INVALID');
    expect(err(() => createOrderingRound({ runIndex: 1, roundId: 'r', referenceRevision: 'bad rev!', config }))).toBe('ORDERING_STATE_INVALID');
    expect(parseOrderingRoundState(g)).toEqual(s3); // the untampered state still loads identically
  });
  it('never lets a raw Zod error escape: random garbage ends in a controlled code', () => {
    const garbage: unknown[] = [0, 1, true, Symbol('x'), () => 1, new Date(), { kind: 'ORDERING_ROUND' }, { kind: 'ORDERING_ROUND', records: 'x' }, JSON.parse('{"__proto__":{"kind":"ORDERING_ROUND"}}')];
    for (const raw of garbage) {
      const message = err(() => parseOrderingRoundState(raw));
      expect(message).toBe('ORDERING_STATE_INVALID');
    }
  });
  const snapshot = (state: Record<string, unknown>, stateVersion = 0): EngineStateSnapshot => ({ roomId: 'room-1', runIndex: 2, gameSlug: 'future-ordering', engineVersion: 1, stateVersion, state });
  it('replays through the existing SDK state events to an identical state, without clock, randomness or re-comparing', () => {
    const s0 = fresh(), s1 = submit(s0, 'a', order('bb', 'aa', 'cc', 'dd')), s2 = close(s1);
    const s3 = compare(s2, 'a').state;
    const base = snapshot({ phase: 'INPUT_OPEN', ordering: s0, scores: { a: 0 } });
    const e1 = createStateEvent(base, { phase: 'INPUT_OPEN', ordering: s1, scores: { a: 0 } }, { eventId: randomUUID(), type: 'ORDER_SUBMITTED', commandId: 'c1', actorId: 'a', occurredAtMs: 5000 });
    const mid = snapshot({ phase: 'INPUT_OPEN', ordering: s1, scores: { a: 0 } }, 1);
    const e2 = createStateEvent(mid, { phase: 'REVEAL', ordering: s3, scores: { a: 0 } }, { eventId: randomUUID(), type: 'ORDER_COMPARED', commandId: 'c2', actorId: 'host', occurredAtMs: 9000 });
    const now = vi.spyOn(Date, 'now'), random = vi.spyOn(Math, 'random');
    try {
      const wire = JSON.parse(JSON.stringify([e1, e2]));
      const replayed = applyStateEvent(applyStateEvent(base, wire[0]), wire[1]);
      expect(applyStateEvent(applyStateEvent(base, wire[0]), wire[1])).toEqual(replayed);
      expect(replayed.stateVersion).toBe(2);
      expect(parseOrderingRoundState(replayed.state.ordering)).toEqual(s3);
      expect(replayed.state.scores).toEqual({ a: 0 }); // replay writes no points
      expect(now).not.toHaveBeenCalled();
      expect(random).not.toHaveBeenCalled();
    } finally { now.mockRestore(); random.mockRestore(); }
    expect(e1.changes.map(c => c.key)).toEqual(['ordering']);
  });
  it('refuses events of another run or version; a tampered reconstructed permutation is caught on read', () => {
    const base = snapshot({ ordering: fresh() });
    const withOrder = submit(fresh(), 'a', order('aa', 'bb', 'cc', 'dd'));
    const e = createStateEvent(base, { ordering: withOrder }, { eventId: randomUUID(), type: 'X', commandId: null, actorId: null, occurredAtMs: 1 });
    expect(() => applyStateEvent({ ...base, runIndex: 3 }, e)).toThrow('EVENT_SCOPE_MISMATCH');
    expect(() => applyStateEvent({ ...base, gameSlug: 'other' }, e)).toThrow('EVENT_SCOPE_MISMATCH');
    expect(() => applyStateEvent({ ...base, stateVersion: 5 }, e)).toThrow('EVENT_VERSION_CONFLICT');
    const tampered = { ...e, changes: [{ key: 'ordering', value: { ...withOrder, records: [{ ...withOrder.records[0], order: { schemaVersion: 1, itemIds: ['aa', 'aa', 'cc', 'dd'] } }] } }] };
    expect(err(() => parseOrderingRoundState(applyStateEvent(base, tampered).state.ordering))).toBe('ORDERING_STATE_INVALID');
  });
});

describe('N3 legacy, N1 and N2 compatibility', () => {
  it('keeps string/null submissions readable and refuses order objects in the legacy contract', () => {
    const legacy = { participantId: 'p', roundId: 'r', value: 'A', status: 'SUBMITTED', submittedAtMs: 1, judgedAtMs: null, decision: null };
    expect(SubmissionRecordSchema.parse(legacy)).toEqual(legacy);
    expect(SubmissionRecordSchema.parse({ ...legacy, value: null }).value).toBeNull();
    const record = submit(fresh(), 'a', order('aa', 'bb', 'cc', 'dd')).records[0];
    expect(SubmissionRecordSchema.safeParse(record).success).toBe(false);
    expect(SubmissionRecordSchema.safeParse({ ...legacy, value: record.order }).success).toBe(false);
    expect(SubmissionRecordSchema.safeParse({ ...legacy, value: record.order.itemIds }).success).toBe(false);
    expect(() => submitOnce({ participantId: 'p', roundId: 'r', value: record.order as never, timer, now: 5000 })).toThrow();
    expect(submitOnce({ participantId: 'p', roundId: 'r', value: '7', timer, now: 5000 }).value).toBe('7');
    // a legacy string is not a valid ordering either
    expect(err(() => submit(fresh(), 'a', 'aa,bb,cc,dd'))).toBe('ORDERING_INVALID');
  });
  it('N1, N2 and N3 states are mutually unreadable; N1 and N2 still work', () => {
    const numeric = createNumericRound({ runIndex: 1, roundId: 'r', config: { schemaVersion: 1, scale: 0, min: { units: 0, scale: 0 }, max: { units: 10, scale: 0 }, unit: null, boundsDisclosure: 'PUBLIC' } });
    const textCard = createTextCardRound({ runIndex: 1, roundId: 'r', config: { schemaVersion: 1, fields: [{ fieldId: 'alpha', label: 'A', help: null, required: true }], maxCodePointsPerField: 10, maxTotalCodePoints: 10 } });
    expect(err(() => parseOrderingRoundState(numeric))).toBe('ORDERING_STATE_INVALID');
    expect(err(() => parseOrderingRoundState(textCard))).toBe('ORDERING_STATE_INVALID');
    expect(err(() => parseNumericRoundState(fresh()))).toBe('NUMERIC_STATE_INVALID');
    expect(err(() => parseTextCardRoundState(fresh()))).toBe('TEXT_CARD_STATE_INVALID');
    expect(parseNumericRoundState(numeric)).toEqual(numeric);
    expect(parseTextCardRoundState(textCard)).toEqual(textCard);
  });
  it('gives the three real engines no ordering entry point and no order as a choice or judge answer', () => {
    const context: CoreActionContext = { gameSlug: 'wer-ist-das', roomStatus: 'RUNNING', state: createWerIstDasState(1, { alice: 'Alice' }),
      informationRole: 'PLAYER', participantId: 'alice', active: true, permissions: new Set(['BUZZER_CONTROL']), now: 100 };
    for (const slug of ['wissensduell', 'jeopardy', 'wer-ist-das']) {
      const contract = getGameEngineContract(slug)!;
      for (const action of ['orderSubmit', 'ordering:submit', 'sort.update', 'sort.lock', 'sort:lock']) {
        expect(contract.validateCommand({ ...context, gameSlug: slug }, { action, payload: order('aa', 'bb', 'cc', 'dd') }), `${slug}/${action}`).toMatchObject({ success: false });
      }
    }
    expect(getGameEngineContract('wer-ist-das')!.validateCommand({ ...context, buzzerController: true }, { action: 'judge', payload: { result: order('aa', 'bb', 'cc', 'dd') } })).toMatchObject({ success: false });
  });
  it('exposes every ordering error code on the wire with its own code, and unknown ones stay INTERNAL_ERROR', () => {
    for (const code of ORDERING_ERROR_CODES) expect(gameErrorCode(new Error(code)), code).toBe(code);
    expect(gameErrorCode(new Error('ORDERING_SOMETHING_ELSE'))).toBe('INTERNAL_ERROR');
  });
});

describe('N3 visibility (domain projection only — no socket, rejoin or recovery is proven here)', () => {
  const state = () => {
    const s = submit(submit(fresh(), 'alice', order('cc', 'aa', 'dd', 'bb')), 'bob', order('dd', 'cc', 'bb', 'aa'), 5100);
    return compare(close(s), 'alice').state; // alice compared, bob only locked
  };
  const roles = {
    alice: { role: 'PLAYER', participantId: 'alice', teamId: 't1' }, partnerOfAlice: { role: 'PLAYER', participantId: 'carol', teamId: 't1' },
    bob: { role: 'PLAYER', participantId: 'bob', teamId: 't2' }, outsider: { role: 'PLAYER', participantId: 'zed', teamId: null },
    host: { role: 'HOST' }, blindHost: { role: 'HOST', blindHost: true }, playingHostAsHost: { role: 'HOST', participantId: 'alice', teamId: 't1' },
    viewer: { role: 'VIEWER' }, display: { role: 'DISPLAY' },
  } as const;
  const project = (r: keyof typeof roles, revealed: boolean) => projectOrderingRound({ ...roles[r] }, state(), { revealed });
  it('shows an order only to its owner until the explicit reveal', () => {
    expect(project('alice', false).records.map(r => r.participantId)).toEqual(['alice']);
    expect(project('bob', false).records.map(r => r.participantId)).toEqual(['bob']);
    for (const r of ['partnerOfAlice', 'outsider', 'host', 'blindHost', 'playingHostAsHost', 'viewer', 'display'] as const) expect(project(r, false).records, r).toEqual([]);
    for (const r of Object.keys(roles) as Array<keyof typeof roles>) expect(project(r, true).records.map(x => x.participantId), r).toEqual(['alice', 'bob']);
  });
  it('is no correctness oracle before the reveal — not even for the owner', () => {
    for (const r of ['alice', 'bob'] as const) {
      const projection = project(r, false);
      const text = JSON.stringify(projection);
      expect(projection.records[0].comparison, r).toBeNull();
      expect(projection.records[0].status, r).toBe('LOCKED'); // alice was compared, but COMPARED is clamped
      expect(text).not.toMatch(/matchedPositions|matches|complete|referenceRevision|rev-1|groups|contract|comparedAtMs/);
    }
    expect(project('alice', true).records[0]).toMatchObject({ status: 'COMPARED', comparison: { matchedPositions: 4, complete: true } });
    expect(project('alice', true).records[1]).toMatchObject({ participantId: 'bob', status: 'LOCKED', comparison: null }); // not checked stays visible as such
  });
  it('exposes only the public config: no reference, no revision, no private keys', () => {
    for (const r of Object.keys(roles) as Array<keyof typeof roles>) {
      const p = project(r, false);
      expect(Object.keys(p).sort()).toEqual(['config', 'records', 'status']);
      expect(Object.keys(p.config).sort()).toEqual(['directionHint', 'items', 'prompt', 'schemaVersion']);
      expect(JSON.stringify(p)).not.toMatch(/rev-1|referenceRevision|solution|sortValue/);
    }
  });
  it('allows a reveal only for a closed round', () => {
    const open = submit(fresh(), 'alice', order('aa', 'bb', 'cc', 'dd'));
    expect(err(() => projectOrderingRound({ role: 'VIEWER' }, open, { revealed: true }))).toBe('ORDERING_NOT_CLOSED');
    expect(projectOrderingRound({ role: 'PLAYER', participantId: 'alice' }, open, { revealed: false }).records[0].status).toBe('SUBMITTED');
  });
  it('hands out the correct order only after an explicit reveal and to every audience alike', () => {
    for (const r of Object.keys(roles) as Array<keyof typeof roles>) {
      expect(projectOrderingSolution({ ...roles[r] }, config, REF, { revealed: false }), `${r} before`).toBeNull();
      expect(projectOrderingSolution({ ...roles[r] }, config, REF, { revealed: true }), `${r} after`).toEqual({ revision: 'rev-1', groups: [['cc'], ['aa'], ['dd'], ['bb']] });
    }
    expect(err(() => projectOrderingSolution({ role: 'VIEWER' }, config, strictOrderingReference('rev-1', ['aa']), { revealed: true }))).toBe('ORDERING_REFERENCE_INVALID');
    const out = projectOrderingSolution({ role: 'VIEWER' }, config, REF, { revealed: true });
    out?.groups[0].push('zz');
    expect(projectOrderingSolution({ role: 'VIEWER' }, config, REF, { revealed: true })?.groups[0]).toEqual(['cc']); // a copy
  });
  it('shares no object between the state and the projection', () => {
    const s = state();
    const p = projectOrderingRound({ role: 'PLAYER', participantId: 'alice' }, s, { revealed: true });
    p.records[0].order.itemIds.reverse();
    p.config.items[0].label = 'verändert';
    expect(s.records[0].order.itemIds).toEqual(['cc', 'aa', 'dd', 'bb']);
    expect(s.config.items[0].label).toBe('Eintrag aa');
  });
});
