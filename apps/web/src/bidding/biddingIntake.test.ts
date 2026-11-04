import { describe, expect, it } from 'vitest';
import { biddingContextKey, type BiddingExpectedContext, type BiddingProjection } from '@quiz/shared/bidding';
import { emptyBiddingMemo, intakeBiddingProjection, type BiddingIntakeMemo } from './biddingIntake';

import { expectedFor, neutral, standing, type Stand } from './biddingTestFixtures';

const A: Stand = { sv: 5, bv: 3, qv: 2, turn: 3 };
const feed = (expected: BiddingExpectedContext, packets: unknown[], start: BiddingIntakeMemo | null = null) => {
  let memo = start; const outcomes: string[] = []; let held: BiddingProjection | null = null;
  for (const packet of packets) { const r = intakeBiddingProjection(memo, expected, packet); memo = r.memo; held = r.held; outcomes.push(r.outcome); }
  return { memo: memo as BiddingIntakeMemo, held, outcomes };
};

describe('N10 intake: binding and withdrawal', () => {
  it('accepts a valid packet of the expected context and recipient, and shows it', () => {
    const r = intakeBiddingProjection(null, expectedFor('b1'), standing(A));
    expect(r.outcome).toBe('ACCEPTED');
    expect(r.held).toMatchObject({ release: 'STANDING', biddingVersion: 3 });
    expect(r.memo).toMatchObject({ seenStateVersion: 5, seenBiddingVersion: 3, seenSequenceVersion: 2, seenTurnNumber: 3, seenRelease: 'STANDING' });
  });
  it('null, undefined, malformed, foreign-scope and foreign-recipient packets show nothing and move NO knowledge (no poisoning)', () => {
    const base = feed(expectedFor('b1'), [standing(A)]);
    const huge = { ...standing(A), biddingVersion: 2 ** 60, stateVersion: 2 ** 60 };
    for (const bad of [null, undefined, {}, 'x', 42, huge, { ...standing(A), extra: 1 }, standing(A, { scope: { biddingId: 'other' } }), standing(A, { recipient: 'b2', youTeam: 'T2' }), standing(A, { recipient: null })]) {
      const r = intakeBiddingProjection(base.memo, expectedFor('b1'), bad);
      expect(r.held).toBeNull();
      expect(r.outcome).toBe('WITHDRAWN');
      expect({ ...r.memo, held: null }).toEqual({ ...base.memo, held: null });
    }
  });
  it('every identity level on its own: run, round, bidding, sequence, roster, roles revision and the recipient each make a packet foreign', () => {
    for (const scope of [{ runIndex: 2 }, { roundId: 'round-2' }, { biddingId: 'bidding-2' }, { sequenceId: 'seq-2' }, { rosterRevision: 'roster-2' }, { rolesRevision: 'roles-2' }]) {
      expect(intakeBiddingProjection(null, expectedFor('b1'), standing(A, { scope })).held).toBeNull();
      expect(intakeBiddingProjection(null, expectedFor('p1'), neutral(5, { scope })).held).toBeNull();
    }
    expect(intakeBiddingProjection(null, expectedFor('b1'), standing(A, { recipient: 'p1', youTeam: null })).held).toBeNull(); // A's packet under B's expectation
    expect(intakeBiddingProjection(null, expectedFor('b1'), neutral(5, { recipient: 'p1' })).held).toBeNull(); // also the neutral packet, also inside one team
    expect(intakeBiddingProjection(null, expectedFor('b1', 6), standing(A)).held).toBeNull(); // older than the caller's own snapshot channel
  });
  it('another context starts with empty knowledge (no archive): a packet of the OLD bidding is foreign afterwards and shows nothing', () => {
    const first = feed(expectedFor('b1'), [standing({ sv: 90, bv: 40, qv: 30, turn: 40 })]);
    const nextCtx = { biddingId: 'bidding-2' };
    const second = intakeBiddingProjection(first.memo, expectedFor('b1', 0, nextCtx), standing({ sv: 1, bv: 1, qv: 1, turn: 1 }, { scope: nextCtx }));
    expect(second.held).not.toBeNull();
    expect(second.memo.seenStateVersion).toBe(1); // fresh knowledge
    const late = intakeBiddingProjection(second.memo, expectedFor('b1', 0, nextCtx), standing({ sv: 91, bv: 41, qv: 31, turn: 41 }));
    expect(late.held).toBeNull(); // the old bidding's late packet
    expect(late.memo.seenStateVersion).toBe(1);
  });
});

describe('N10 intake: version knowledge per ordering level, multi-step chains', () => {
  it('current standing → null → OLDER standing: the withdrawal keeps the knowledge, the older view is refused (each level on its own)', () => {
    const e = expectedFor('b1');
    for (const older of [{ ...A, sv: A.sv - 1 }, { ...A, bv: A.bv - 1 }, { ...A, qv: A.qv - 1 }, { ...A, turn: A.turn - 1 }]) {
      const r = feed(e, [standing(A), null, standing(older)]);
      expect(r.outcomes).toEqual(['ACCEPTED', 'WITHDRAWN', 'STALE']);
      expect(r.held).toBeNull();
      expect(r.memo).toMatchObject({ seenStateVersion: 5, seenBiddingVersion: 3, seenSequenceVersion: 2, seenTurnNumber: 3 });
    }
    expect(feed(e, [standing(A), null, standing({ sv: 6, bv: 3, qv: 2, turn: 3 })]).held).not.toBeNull(); // positive control: a newer one is accepted
  });
  it('a refused older packet while a view is shown keeps showing the current view (it neither restores nor erases)', () => {
    const r = feed(expectedFor('b1'), [standing(A), standing({ ...A, bv: 1, sv: 5 })]);
    expect(r.outcomes).toEqual(['ACCEPTED', 'STALE']);
    expect(r.held).toMatchObject({ biddingVersion: 3 });
  });
  it('closed → invalid → an old "may bid" view: refused; the closed knowledge survives the withdrawal', () => {
    const e = expectedFor('b1');
    const open = standing({ sv: 5, bv: 4, qv: 2, turn: 4 }); // may bid
    const closed = standing({ sv: 6, bv: 5, qv: 3, turn: 5 }, { phase: 'CLOSED', leader: { teamId: 'T2', units: 8 }, onTurn: null, passed: ['T1', 'T3'] });
    const r = feed(e, [closed, { garbage: true }, open]);
    expect(r.outcomes).toEqual(['ACCEPTED', 'WITHDRAWN', 'STALE']);
    expect(r.held).toBeNull();
    expect(r.memo.seenBiddingVersion).toBe(5);
  });
  it('neutral view → withdrawal → a late RELEASED bidder packet of an older snapshot: refused (neutral is a version observation too)', () => {
    const e = expectedFor('b1');
    const r = feed(e, [neutral(9, { recipient: 'b1', performer: false }), null, standing({ sv: 8, bv: 7, qv: 4, turn: 7 })]);
    expect(r.outcomes).toEqual(['NEUTRAL', 'WITHDRAWN', 'STALE']);
    expect(r.held).toBeNull();
    expect(r.memo.seenStateVersion).toBe(9);
    // and a later standing of a newer snapshot is accepted again (a role that has changed is a new bidding in a new context, not this one)
    expect(feed(e, [neutral(9, { recipient: 'b1' }), standing({ sv: 10, bv: 8, qv: 4, turn: 8 })]).outcomes).toEqual(['NEUTRAL', 'ACCEPTED']);
  });
  it('at the SAME stand a narrower release is accepted, a WIDER one is not: a withdrawal at that stand is not undone by its own earlier packet', () => {
    const e = expectedFor('b1');
    expect(feed(e, [standing(A), neutral(5, { recipient: 'b1', performer: false })]).outcomes).toEqual(['ACCEPTED', 'NEUTRAL']);
    expect(feed(e, [neutral(5, { recipient: 'b1', performer: false }), standing(A)]).outcomes).toEqual(['NEUTRAL', 'STALE']);
    expect(feed(e, [standing(A), standing(A)]).outcomes).toEqual(['ACCEPTED', 'ACCEPTED']); // an equal re-delivery
  });
  it('A in an old turn → B → A in a new turn → A\'s late packet of the old turn: the turn number refuses it, whatever the local counters say', () => {
    const e = expectedFor('b1');
    const t1 = standing({ sv: 5, bv: 1, qv: 1, turn: 1 });
    const t2 = standing({ sv: 6, bv: 2, qv: 2, turn: 2 }, { onTurn: 'T2' }); // B's turn
    const t3 = standing({ sv: 7, bv: 3, qv: 3, turn: 3 });
    const r = feed(e, [t1, t2, t3, t1]);
    expect(r.outcomes).toEqual(['ACCEPTED', 'ACCEPTED', 'ACCEPTED', 'STALE']);
    expect(r.held).toMatchObject({ turnNumber: 3, you: { canBid: true } });
  });
  it('a newer eligibility basis WITHOUT any new bid raises the sequence version only: the older stand is refused afterwards', () => {
    const e = expectedFor('b1');
    const before = standing({ sv: 5, bv: 3, qv: 2, turn: 3 });
    const basis = standing({ sv: 6, bv: 3, qv: 3, turn: 3 }); // same bidding version, same turn, newer sequence version
    const r = feed(e, [before, basis, before]);
    expect(r.outcomes).toEqual(['ACCEPTED', 'ACCEPTED', 'STALE']);
    expect(r.held).toMatchObject({ sequenceVersion: 3 });
  });
  it('an invalid or foreign packet with a huge counter never moves the knowledge: the next honest packet still works', () => {
    const r = feed(expectedFor('b1'), [standing(A), { ...standing(A), biddingVersion: 2 ** 60 }, standing({ ...A, sv: 6 })]);
    expect(r.outcomes).toEqual(['ACCEPTED', 'WITHDRAWN', 'ACCEPTED']);
  });
  it('a neutral packet raises only the snapshot version and carries no bidding counter at all', () => {
    const r = intakeBiddingProjection(emptyBiddingMemo(biddingContextKey(expectedFor('p1'))), expectedFor('p1'), neutral(7));
    expect(r.memo).toMatchObject({ seenStateVersion: 7, seenBiddingVersion: -1, seenSequenceVersion: -1, seenTurnNumber: -1 });
    expect(Object.keys(neutral(7)).sort()).toEqual(['contract', 'phase', 'recipientId', 'release', 'scope', 'stateVersion', 'you']);
  });
  it('is pure: no input mutation, deterministic', () => {
    const memo = feed(expectedFor('b1'), [standing(A)]).memo;
    const frozen = JSON.stringify(memo);
    const packet = standing({ ...A, sv: 6 });
    const copy = JSON.stringify(packet);
    const a = intakeBiddingProjection(memo, expectedFor('b1'), packet), b = intakeBiddingProjection(memo, expectedFor('b1'), packet);
    expect(a).toEqual(b);
    expect(JSON.stringify(memo)).toBe(frozen);
    expect(JSON.stringify(packet)).toBe(copy);
  });
});
