import { describe, expect, it } from 'vitest';
import { TURN_SEQUENCE_CONTRACT, parseTurnSequenceProjection, type TurnSequenceExpectedContext, type TurnSequenceProjection, type TurnSequenceRelease } from '@quiz/shared/turnSequence';
import { emptyTurnMemo, intakeTurnSequence, type TurnIntakeMemo, type TurnIntakeResult } from './turnIntake';

// Synthetic fixtures: ids are markers, not names. Counters are chosen so that every ordering level can be older ON ITS OWN.
const SCOPE = { runIndex: 1, sequenceId: 'seq-1', rosterRevision: 'roster-1', unit: 'PLAYER' as const };
const EXPECTED: TurnSequenceExpectedContext = { ...SCOPE, recipientId: 'p1', minStateVersion: 1 };
interface Stand { state: number; seq: number; turn: number; ent: number }
const projection = (stand: Stand, over: { release?: TurnSequenceRelease; holder?: string | null; status?: 'READY' | 'ACTIVE' | 'HELD' | 'NO_ELIGIBLE' | 'CLOSED'; scope?: typeof SCOPE; canAct?: boolean; recipient?: string | null } = {}): TurnSequenceProjection => {
  const recipient = over.recipient === undefined ? 'p1' : over.recipient; // who the packet was made for (null = host / viewer / display)
  const release = over.release ?? 'CURRENT';
  const base = { contract: TURN_SEQUENCE_CONTRACT, scope: { ...(over.scope ?? SCOPE) }, recipientId: recipient, stateVersion: stand.state, sequenceVersion: stand.seq, turnNumber: stand.turn, entitlementRevision: stand.ent };
  if (release === 'NONE') return { ...base, release };
  const holder = over.holder === undefined ? 'p1' : over.holder;
  const status = over.status ?? (holder === null ? 'NO_ELIGIBLE' : 'ACTIVE');
  const team = ((over.scope ?? SCOPE).unit as string) === 'TEAM'; // a team-unit projection names the team of the holder and says whether the recipient's team holds the turn
  const current = holder === null ? null : { teamId: team ? 'T1' : null, playerId: holder };
  const you = recipient === null ? null : { holdsTurn: holder === recipient, teamHoldsTurn: team ? holder === recipient : null, canAct: (over.canAct ?? true) && holder === recipient && status === 'ACTIVE' };
  const shape = { ...base, release, status, current, you };
  return release === 'ORDER' ? { ...shape, release, order: { actorIds: ['p1', 'p2'], position: holder === null ? null : 0, cycle: 0 } } as TurnSequenceProjection : shape as TurnSequenceProjection;
};
/** Feeds a sequence of observations through the intake like a card would (memo carried over). */
function feed(steps: Array<unknown | { expected: TurnSequenceExpectedContext; raw: unknown }>, expected = EXPECTED): { results: TurnIntakeResult[]; memo: TurnIntakeMemo | null } {
  let memo: TurnIntakeMemo | null = null;
  const results: TurnIntakeResult[] = [];
  for (const step of steps) {
    const wrapped = typeof step === 'object' && step !== null && 'expected' in step && 'raw' in step ? step as { expected: TurnSequenceExpectedContext; raw: unknown } : { expected, raw: step };
    const result = intakeTurnSequence(memo, wrapped.expected, wrapped.raw);
    results.push(result); memo = result.memo;
  }
  return { results, memo };
}
const holderOf = (result: TurnIntakeResult) => (result.held === null || result.held.release === 'NONE' ? null : result.held.current?.playerId ?? null);

describe('N8 turn intake: binding and the independent minimum', () => {
  it('accepts a valid projection of the expected context and holds an independent copy', () => {
    const source = projection({ state: 5, seq: 3, turn: 2, ent: 1 });
    const { results } = feed([source]);
    expect(results[0].outcome).toBe('ACCEPTED');
    expect(results[0].held).toEqual(source);
    expect(results[0].held).not.toBe(source);
  });
  it('shows nothing for invalid, foreign or too-old input and keeps the previous knowledge untouched', () => {
    const good = projection({ state: 5, seq: 3, turn: 2, ent: 1 });
    const invalid = [{ ...good, extra: 1 }, { ...good, turnNumber: -1 }, { ...good, current: { teamId: 'T', playerId: 'p1' } }, 'x', 42, [], {}, { ...good, contract: 'V0' }];
    for (const bad of invalid) {
      const { results } = feed([good, bad]);
      expect(results[1].outcome, JSON.stringify(bad)).toBe('WITHDRAWN');
      expect(results[1].held).toBeNull();
      expect(results[1].memo.seenStateVersion).toBe(5); // knowledge stays
    }
    for (const scope of [{ ...SCOPE, runIndex: 2 }, { ...SCOPE, sequenceId: 'seq-2' }, { ...SCOPE, rosterRevision: 'roster-2' }, { ...SCOPE, unit: 'TEAM' as const }]) {
      const foreign = projection({ state: 999, seq: 999, turn: 999, ent: 999 }, { scope: scope as never });
      const { results } = feed([good, foreign]);
      expect(results[1].outcome).toBe('WITHDRAWN');
      expect(results[1].memo).toMatchObject({ seenStateVersion: 5, seenSequenceVersion: 3, seenTurnNumber: 2, seenEntitlement: 1 }); // a foreign huge number poisons nothing
    }
    const below = feed([projection({ state: 0, seq: 9, turn: 9, ent: 9 })], { ...EXPECTED, minStateVersion: 1 });
    expect(below.results[0].outcome).toBe('WITHDRAWN');
    expect(below.memo!.seenStateVersion).toBe(-1); // below the independent minimum: not an observation at all
  });
  it('takes the minimum from the caller, never from the packet: a stale snapshot cannot vouch for itself', () => {
    const accepted = feed([projection({ state: 6, seq: 3, turn: 2, ent: 1 })], { ...EXPECTED, minStateVersion: 6 });
    expect(accepted.results[0].outcome).toBe('ACCEPTED');
    const raised = feed([projection({ state: 6, seq: 3, turn: 2, ent: 1 })], { ...EXPECTED, minStateVersion: 7 });
    expect(raised.results[0].outcome).toBe('WITHDRAWN');
  });
});

describe('N8 turn intake: a separate protection per ordering level, also through an empty intermediate state', () => {
  const base: Stand = { state: 10, seq: 10, turn: 5, ent: 2 };
  it('current turn → null → OLD turn: the old view never restores a holder or an action', () => {
    const { results } = feed([projection({ state: 10, seq: 10, turn: 9, ent: 2 }), null, projection({ state: 9, seq: 9, turn: 8, ent: 2 })]);
    expect(holderOf(results[0])).toBe('p1');
    expect(results[1].held).toBeNull();
    expect(results[2]).toMatchObject({ outcome: 'STALE', held: null });
    expect(results[2].memo).toMatchObject({ seenStateVersion: 10, seenSequenceVersion: 10, seenTurnNumber: 9 });
  });
  it('each level alone is enough to make a packet stale: snapshot version, sequence version, turn identity, entitlement revision', () => {
    for (const [name, older] of [
      ['stateVersion', { ...base, state: 9 }], ['sequenceVersion', { ...base, seq: 9 }], ['turnNumber', { ...base, turn: 4 }], ['entitlement', { ...base, ent: 1 }],
    ] as const) {
      const { results } = feed([projection(base), null, projection(older)]);
      expect(results[2].outcome, name).toBe('STALE');
      expect(results[2].held, name).toBeNull(); // after the empty view nothing comes back
      const direct = feed([projection(base), projection(older)]);
      expect(direct.results[1].outcome, name).toBe('STALE');
      expect(direct.results[1].held, name).toEqual(projection(base)); // and a still-shown newer view is not replaced by the older one
    }
  });
  it('a newer LOCK is not undone by an older "active" view (ACTIVE v11 → HELD v12 → late ACTIVE v11)', () => {
    const active = projection({ state: 11, seq: 11, turn: 9, ent: 1 });
    const held = projection({ state: 12, seq: 12, turn: 9, ent: 2 }, { status: 'HELD' });
    const { results } = feed([active, held, active, null, active]);
    expect(results.map(r => r.outcome)).toEqual(['ACCEPTED', 'ACCEPTED', 'STALE', 'WITHDRAWN', 'STALE']);
    expect(results[1].held).toMatchObject({ status: 'HELD', you: { canAct: false } });
    expect(results[2].held).toMatchObject({ status: 'HELD' }); // the late older packet changed nothing
    expect(results[4].held).toBeNull(); // not even after a withdrawal in between
  });
  it('the SAME player in a later turn: feedback of his earlier turn cannot re-enable him (A turn 1 → B turn 2 → A turn 3 → late A turn 1)', () => {
    const a1 = projection({ state: 3, seq: 3, turn: 1, ent: 1 });
    const b2 = projection({ state: 4, seq: 4, turn: 2, ent: 1 }, { holder: 'p2' });
    const a3 = projection({ state: 5, seq: 5, turn: 3, ent: 1 });
    const { results } = feed([a1, b2, a3, a1]);
    expect(results.map(holderOf)).toEqual(['p1', 'p2', 'p1', 'p1']);
    expect(results[3].outcome).toBe('STALE');
    expect(results[3].held).toMatchObject({ turnNumber: 3, sequenceVersion: 5 }); // still turn 3's view, not turn 1's binding
  });
  it('a newer valid view WITHOUT a visible holder (none released, nobody suitable, closed) still raises every knowledge level', () => {
    for (const newer of [projection({ state: 20, seq: 20, turn: 6, ent: 3 }, { release: 'NONE' }), projection({ state: 20, seq: 20, turn: 6, ent: 3 }, { holder: null }),
      projection({ state: 20, seq: 20, turn: 6, ent: 3 }, { holder: null, status: 'CLOSED' })]) {
      const { results } = feed([projection(base), newer, projection(base)]);
      expect(results[1].memo).toMatchObject({ seenStateVersion: 20, seenSequenceVersion: 20, seenTurnNumber: 6, seenEntitlement: 3 });
      expect(results[2].outcome).toBe('STALE');
      expect(holderOf(results[2])).toBeNull();
    }
    const none = feed([projection(base), projection({ state: 20, seq: 20, turn: 6, ent: 3 }, { release: 'NONE' })]);
    expect(none.results[1]).toMatchObject({ outcome: 'RELEASE_NONE', held: null });
  });
  it('a packet that is older only in one level but newer in the others is rejected; a fully newer packet is accepted again', () => {
    const { results } = feed([projection(base), projection({ ...base, state: 20, seq: 9 }), projection({ state: 20, seq: 20, turn: 6, ent: 3 })]);
    expect(results.map(r => r.outcome)).toEqual(['ACCEPTED', 'STALE', 'ACCEPTED']);
  });
  it('at the very same stand a re-delivery with the same or a narrower release is accepted, a WIDER one is not', () => {
    const stand = { state: 7, seq: 7, turn: 4, ent: 1 };
    const none = projection(stand, { release: 'NONE' });
    expect(feed([none, projection(stand, { release: 'CURRENT' })]).results[1].outcome).toBe('STALE'); // a withdrawal at this stand is final for this stand
    expect(feed([none, projection(stand, { release: 'ORDER' })]).results[1].outcome).toBe('STALE');
    expect(feed([projection(stand, { release: 'ORDER' }), projection(stand, { release: 'CURRENT' })]).results[1].outcome).toBe('ACCEPTED');
    expect(feed([projection(stand, { release: 'CURRENT' }), projection(stand, { release: 'CURRENT' })]).results[1].outcome).toBe('ACCEPTED'); // duplicate delivery
    expect(feed([projection(stand, { release: 'CURRENT' }), none]).results[1]).toMatchObject({ outcome: 'RELEASE_NONE', held: null });
  });
  it('withdrawal by null, undefined and invalid data keeps all four levels, and the next valid older packet is still stale', () => {
    for (const gone of [null, undefined, { broken: true }, 'x']) {
      const { results } = feed([projection(base), gone, projection({ ...base, turn: 4 })]);
      expect(results[1].held).toBeNull();
      expect(results[1].memo).toMatchObject({ seenStateVersion: 10, seenSequenceVersion: 10, seenTurnNumber: 5, seenEntitlement: 2 });
      expect(results[2].outcome).toBe('STALE');
    }
  });
});

describe('N8 turn intake: contexts', () => {
  it('another run, sequence, roster revision, unit or recipient starts with empty knowledge (one slot, no archive)', () => {
    const high = projection({ state: 50, seq: 50, turn: 30, ent: 4 });
    for (const next of [{ ...EXPECTED, runIndex: 2 }, { ...EXPECTED, sequenceId: 'seq-2' }, { ...EXPECTED, rosterRevision: 'roster-2' }, { ...EXPECTED, unit: 'TEAM' as const }, { ...EXPECTED, recipientId: 'p2' }, { ...EXPECTED, recipientId: null }]) {
      const low = projection({ state: 2, seq: 1, turn: 1, ent: 1 }, { scope: { runIndex: next.runIndex, sequenceId: next.sequenceId, rosterRevision: next.rosterRevision, unit: next.unit } as never, recipient: next.recipientId });
      const { results, memo } = feed([{ expected: EXPECTED, raw: high }, { expected: next, raw: low }, { expected: EXPECTED, raw: projection({ state: 2, seq: 1, turn: 1, ent: 1 }) }]);
      expect(results[1].outcome, JSON.stringify(next)).toBe('ACCEPTED'); // low version in a NEW context is fine
      expect(results[1].memo.seenStateVersion).toBe(2);
      expect(results[2].outcome).toBe('ACCEPTED'); // back: no archive of the old context's knowledge (a documented single-slot consequence)
      expect(memo!.seenStateVersion).toBe(2);
    }
  });
  it('a valid projection with an implausibly high version blocks later regular packets until the context changes (a contract question of the server, as in N6)', () => {
    const poisoned = feed([projection({ state: 900_000_000, seq: 1, turn: 1, ent: 1 }), projection({ state: 12, seq: 2, turn: 2, ent: 1 })]);
    expect(poisoned.results[1].outcome).toBe('STALE');
    expect(feed([projection({ state: 900_000_000, seq: 1, turn: 1, ent: 1 }), { expected: { ...EXPECTED, sequenceId: 'seq-9' }, raw: projection({ state: 12, seq: 2, turn: 2, ent: 1 }, { scope: { ...SCOPE, sequenceId: 'seq-9' } }) }]).results[1].outcome).toBe('ACCEPTED');
  });
  it('starts empty and never throws on arbitrary input', () => {
    expect(emptyTurnMemo('k')).toEqual({ key: 'k', seenStateVersion: -1, seenSequenceVersion: -1, seenTurnNumber: -1, seenEntitlement: -1, seenRelease: null, held: null });
    for (const raw of [undefined, null, 0, '', [], {}, { release: 'CURRENT' }, Symbol.iterator.toString(), () => 1]) expect(() => intakeTurnSequence(null, EXPECTED, raw)).not.toThrow();
  });
});

// ── PR #38 review N8-01: the recipient-specific part is bound to the recipient the UI expects ────────────────────────────

describe('N8 turn intake: recipient binding (N8-01)', () => {
  const as = (recipient: string | null, minStateVersion = 1): TurnSequenceExpectedContext => ({ ...EXPECTED, recipientId: recipient, minStateVersion });
  const stand = { state: 5, seq: 3, turn: 2, ent: 1 };
  it('Alice → Bob while Alice\'s packet is still there: Bob gets neither Alice\'s "you" nor her action; his knowledge starts empty', () => {
    const alice = projection(stand, { holder: 'alice', recipient: 'alice' });
    const { results } = feed([{ expected: as('alice'), raw: alice }, { expected: as('bob'), raw: alice }]);
    expect(results[0]).toMatchObject({ outcome: 'ACCEPTED' });
    expect(results[0].held).toMatchObject({ you: { holdsTurn: true, canAct: true } });
    expect(results[1].outcome).toBe('WITHDRAWN');
    expect(results[1].held).toBeNull();
    expect(results[1].memo).toMatchObject({ seenStateVersion: -1, seenSequenceVersion: -1, seenTurnNumber: -1, seenEntitlement: -1 }); // a foreign packet raises no knowledge for Bob
  });
  it('a late Alice packet after Bob\'s own valid projection never becomes Bob\'s state: his knowledge is unchanged and his own next packet is shown again', () => {
    const bob = projection({ ...stand, state: 6, seq: 4, turn: 3 }, { holder: 'bob', recipient: 'bob' });
    const lateAlice = projection({ state: 99, seq: 99, turn: 99, ent: 9 }, { holder: 'alice', recipient: 'alice' }); // even a huge version poisons nothing
    const { results } = feed([{ expected: as('bob'), raw: bob }, { expected: as('bob'), raw: lateAlice }, { expected: as('bob'), raw: bob }]);
    expect(results[0].held).toMatchObject({ you: { holdsTurn: true, canAct: true }, turnNumber: 3 });
    expect(results[1].held).toBeNull(); // fail-closed: no foreign eigenzuständigkeit shown
    expect(results[1].memo).toMatchObject({ seenStateVersion: 6, seenSequenceVersion: 4, seenTurnNumber: 3 }); // Bob's knowledge was not touched (not lowered, not raised)
    expect(results[2].outcome).toBe('ACCEPTED'); // the same valid Bob packet is usable again, without a reset
    expect(results[2].held).toMatchObject({ you: { holdsTurn: true }, turnNumber: 3 });
  });
  it('two members of the SAME team stay separate recipients: advising is not responsibility, and neither accepts the other\'s packet', () => {
    const team = (recipient: string, holdsTurn: boolean): TurnSequenceProjection => ({
      contract: TURN_SEQUENCE_CONTRACT, scope: { ...SCOPE, unit: 'TEAM' }, recipientId: recipient, stateVersion: 7, sequenceVersion: 4, turnNumber: 3, entitlementRevision: 1, release: 'CURRENT', status: 'ACTIVE',
      current: { teamId: 'T1', playerId: 'carol' }, you: { holdsTurn, teamHoldsTurn: true, canAct: holdsTurn },
    });
    const teamCtx = (recipient: string): TurnSequenceExpectedContext => ({ ...EXPECTED, unit: 'TEAM', recipientId: recipient });
    const carol = team('carol', true), dan = team('dan', false);
    expect(intakeTurnSequence(null, teamCtx('carol'), carol).held).toMatchObject({ you: { holdsTurn: true, canAct: true } });
    expect(intakeTurnSequence(null, teamCtx('dan'), dan).held).toMatchObject({ you: { holdsTurn: false, teamHoldsTurn: true, canAct: false } });
    expect(intakeTurnSequence(null, teamCtx('dan'), carol).held).toBeNull(); // Dan never sees Carol's "you may act"
    expect(intakeTurnSequence(null, teamCtx('carol'), dan).held).toBeNull();
  });
  it('viewer / display / host (recipient null) never receive a packet that carries somebody\'s "you"; a playing host is a PLAYER with his own id', () => {
    const alice = projection(stand, { holder: 'alice', recipient: 'alice' });
    const viewerPacket = projection(stand, { holder: 'alice', recipient: null });
    expect(intakeTurnSequence(null, as(null), alice).held).toBeNull();
    const own = intakeTurnSequence(null, as(null), viewerPacket).held;
    expect(own).toMatchObject({ recipientId: null, you: null });
    expect(intakeTurnSequence(null, as('alice'), viewerPacket).held).toBeNull(); // and a viewer packet is no packet for Alice
    const host = projection(stand, { holder: 'host-1', recipient: 'host-1' });
    expect(intakeTurnSequence(null, as('host-1'), host).held).toMatchObject({ you: { holdsTurn: true } });
    expect(intakeTurnSequence(null, as(null), host).held).toBeNull();
  });
  it('a NONE (withdrawal) packet is bound to its recipient too: another recipient\'s withdrawal raises no knowledge and hides nothing of ours', () => {
    const mine = projection(stand, { recipient: 'bob', holder: 'bob' });
    const hers = projection({ ...stand, state: 20, seq: 20 }, { recipient: 'alice', release: 'NONE' });
    const { results } = feed([{ expected: as('bob'), raw: mine }, { expected: as('bob'), raw: hers }]);
    expect(results[1].memo).toMatchObject({ seenStateVersion: 5 }); // Alice's version 20 did not move Bob's knowledge
  });
  it('the same valid projection of the same recipient is kept without any reset (equal packet, new object)', () => {
    const p = projection(stand, { holder: 'bob', recipient: 'bob' });
    const { results } = feed([{ expected: as('bob'), raw: p }, { expected: as('bob'), raw: JSON.parse(JSON.stringify(p)) }, { expected: as('bob'), raw: p }]);
    expect(results.map(r => r.outcome)).toEqual(['ACCEPTED', 'ACCEPTED', 'ACCEPTED']);
    expect(results[2].memo).toMatchObject({ seenStateVersion: 5, seenTurnNumber: 2 });
  });
  it('the contract: recipientId is required, null is allowed, and a "you" without a recipient is invalid', () => {
    const p = projection(stand, { holder: 'bob', recipient: 'bob' });
    const parse = (mutate: (d: Record<string, unknown>) => void) => { const d = JSON.parse(JSON.stringify(p)) as Record<string, unknown>; mutate(d); return parseTurnSequenceProjection(d).ok; };
    expect(parse(() => undefined)).toBe(true);
    expect(parse(d => { delete d.recipientId; })).toBe(false);
    expect(parse(d => { d.recipientId = ''; })).toBe(false);
    expect(parse(d => { d.recipientId = 7; })).toBe(false);
    expect(parse(d => { d.recipientId = null; })).toBe(false); // "you" present but nobody is the recipient
    expect(parse(d => { d.recipientId = null; d.you = null; })).toBe(true);
  });
});
