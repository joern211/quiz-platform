import { describe, expect, it } from 'vitest';
import { DICE_CONTRACT, parseDiceProjection, type DiceExpectedContext, type DiceProjection, type DiceScope } from '@quiz/shared/dice';
import { emptyDiceMemo, intakeDiceProjection, type DiceIntakeMemo, type DiceIntakeResult } from './diceIntake';

// Synthetic fixtures: ids are markers, not names. Counters are chosen so that every ordering level can be older ON ITS OWN.
const SCOPE: DiceScope = { runIndex: 1, sequenceId: 'seq-1', rosterRevision: 'roster-1', unit: 'PLAYER' };
const EXPECTED: DiceExpectedContext = { ...SCOPE, recipientId: 'p1', minStateVersion: 1 };
const CONFIG = { diceCount: 5, sides: 6, maxRolls: 3, holdAllowed: true };
interface Stand { state: number; seq: number; turn: number; dv: number; roll: number; id?: string }
interface Over { release?: 'NONE' | 'VALUES'; recipient?: string | null; scope?: typeof SCOPE; status?: string; holder?: string; held?: boolean[]; values?: number[] | null; closed?: boolean }

/** A valid projection of one dice process; `holder` is the player of that turn (default p1). */
function view(stand: Stand, over: Over = {}): DiceProjection {
  const recipient = over.recipient === undefined ? 'p1' : over.recipient;
  const scope = over.scope ?? SCOPE;
  const base = { contract: DICE_CONTRACT, scope: { ...scope }, diceId: stand.id ?? `dice-t${stand.turn}`, recipientId: recipient, stateVersion: stand.state, sequenceVersion: stand.seq, turnNumber: stand.turn, diceVersion: stand.dv, rollCount: stand.roll };
  if (over.release === 'NONE') return { ...base, release: 'NONE' } as DiceProjection;
  const status = over.status ?? (over.closed ? 'CLOSED' : stand.roll === 0 ? 'PREPARED' : stand.roll >= 3 ? 'EXHAUSTED' : 'IN_PROGRESS');
  const holderId = over.holder ?? 'p1';
  const team = scope.unit === 'TEAM';
  const open = status === 'PREPARED' || status === 'IN_PROGRESS';
  const holds = recipient !== null && recipient === holderId;
  const you = recipient === null ? null : { holdsTurn: holds, teamHoldsTurn: team ? holds : null, canRoll: holds && open, canHold: holds && status === 'IN_PROGRESS' };
  return {
    ...base, release: 'VALUES', status, config: { ...CONFIG }, values: over.values === undefined ? (stand.roll === 0 ? null : [1, 2, 3, 4, 5]) : over.values,
    held: over.held ?? [false, false, false, false, false], lastRolled: stand.roll === 0 ? [] : stand.roll === 1 ? [0, 1, 2, 3, 4] : [0, 2], holder: { teamId: team ? 'T1' : null, playerId: holderId }, you,
  } as DiceProjection;
}
const T1 = (over: Partial<Stand> = {}): Stand => ({ state: 5, seq: 2, turn: 1, dv: 1, roll: 1, ...over });
/** Feeds a sequence of observations through the intake like a component would (memo carried over). */
function feed(steps: unknown[], expected = EXPECTED): { results: DiceIntakeResult[]; memo: DiceIntakeMemo | null } {
  let memo: DiceIntakeMemo | null = null;
  const results: DiceIntakeResult[] = [];
  for (const raw of steps) { const result = intakeDiceProjection(memo, expected, raw); results.push(result); memo = result.memo; }
  return { results, memo };
}
const rolls = (result: DiceIntakeResult) => (result.held === null || result.held.release === 'NONE' ? null : result.held.rollCount);
const deepFreeze = <T>(value: T): T => { if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) { Object.freeze(value); for (const inner of Object.values(value)) deepFreeze(inner); } return value; };

describe('N9 dice intake: the fixtures are valid projections', () => {
  it('every builder variant is accepted by the strict client schema (so a rejection below is about the intake, not the fixture)', () => {
    for (const stand of [T1({ roll: 0, dv: 0 }), T1(), T1({ roll: 2, dv: 3 }), T1({ roll: 3, dv: 5 })]) expect(parseDiceProjection(view(stand)).ok).toBe(true);
    expect(parseDiceProjection(view(T1(), { release: 'NONE' })).ok).toBe(true);
    expect(parseDiceProjection(view(T1(), { recipient: null })).ok).toBe(true);
    expect(parseDiceProjection(view(T1(), { closed: true })).ok).toBe(true);
    expect(parseDiceProjection(view(T1(), { scope: { ...SCOPE, unit: 'TEAM' }, recipient: 'p1' })).ok).toBe(true);
  });
});

describe('N9 dice intake: binding and the independent minimum', () => {
  it('accepts a valid projection of the expected context and holds an independent copy', () => {
    const source = view(T1());
    const { results } = feed([source]);
    expect(results[0].outcome).toBe('ACCEPTED');
    expect(results[0].held).toEqual(source);
    expect(results[0].held).not.toBe(source);
  });

  it('refuses invalid, foreign and too-old input: nothing is shown, no knowledge moves — also not with a huge counter', () => {
    const good = view(T1());
    const huge = { ...good, stateVersion: 999_999_999, sequenceVersion: 999_999_999, diceVersion: 999_999_999, rollCount: 3, turnNumber: 999_999_999 };
    const invalid: unknown[] = [{ ...good, extra: 1 }, { ...good, turnNumber: 0 }, { ...good, values: [0, 1, 2, 3, 4] }, { ...good, you: { holdsTurn: false, teamHoldsTurn: null, canRoll: true, canHold: false } },
      'x', 42, [], {}, { ...good, contract: 'V0' }, { ...huge, extra: true }, { ...huge, values: [9, 9, 9, 9, 9] }, { ...good, diceVersion: 1_000_000_001 }, { ...good, sequenceVersion: 1_000_000_001 }]; // the LOCAL counters are bounded (1e9); the global stateVersion is a database revision and only has to be a safe integer, as in N8
    for (const bad of invalid) {
      const { results } = feed([good, bad]);
      expect(results[1].outcome, JSON.stringify(bad)).toBe('WITHDRAWN');
      expect(results[1].held).toBeNull();
      expect(results[1].memo).toMatchObject({ seenStateVersion: 5, seenSequenceVersion: 2, seenTurnNumber: 1, seenDiceVersion: 1, seenRollCount: 1 });
    }
    // valid shape, huge counters, but a FOREIGN run / sequence / roster / unit / recipient: not an observation, so it can not poison the context
    const foreign: DiceProjection[] = [
      { ...huge, scope: { ...SCOPE, runIndex: 2 } }, { ...huge, scope: { ...SCOPE, sequenceId: 'seq-2' } }, { ...huge, scope: { ...SCOPE, rosterRevision: 'roster-2' } },
      { ...huge, scope: { ...SCOPE, unit: 'TEAM' } }, { ...huge, recipientId: 'p2' }, { ...huge, recipientId: null },
    ].map(candidate => candidate as DiceProjection);
    for (const packet of foreign) {
      const { results, memo } = feed([good, packet, view({ state: 6, seq: 2, turn: 1, dv: 2, roll: 1 })]);
      expect(results[1].outcome, JSON.stringify(packet.scope) + String(packet.recipientId)).toBe('WITHDRAWN');
      expect(results[2].outcome).toBe('ACCEPTED'); // the legitimate next packet is not locked out by a poisoned counter
      expect(memo!.seenStateVersion).toBe(6);
    }
    // older than the caller's OWN minimum (taken from its own snapshot channel, not from the packet)
    const { results } = feed([view(T1({ state: 3 }))], { ...EXPECTED, minStateVersion: 4 });
    expect(results[0].outcome).toBe('WITHDRAWN');
    expect(feed([view(T1({ state: 4 }))], { ...EXPECTED, minStateVersion: 4 }).results[0].outcome).toBe('ACCEPTED');
  });

  it('a packet made for A is no packet for B: also inside one team, at every release level — with the positive control of the right recipient', () => {
    const TEAM = { ...SCOPE, unit: 'TEAM' as const };
    const forA = view(T1(), { scope: TEAM, recipient: 'A', holder: 'A' });
    const forANone = view(T1(), { scope: TEAM, recipient: 'A', release: 'NONE' });
    const asA: DiceExpectedContext = { ...TEAM, recipientId: 'A', minStateVersion: 1 };
    const asB: DiceExpectedContext = { ...TEAM, recipientId: 'B', minStateVersion: 1 };
    expect(feed([forA], asA).results[0]).toMatchObject({ outcome: 'ACCEPTED' }); // positive control
    expect(feed([forANone], asA).results[0].outcome).toBe('RELEASE_NONE');
    expect(feed([forA], asB).results[0]).toMatchObject({ outcome: 'WITHDRAWN', held: null });
    expect(feed([forANone], asB).results[0]).toMatchObject({ outcome: 'WITHDRAWN', held: null });
    expect(feed([forANone], asB).memo!.seenStateVersion).toBe(-1); // not even the counters of a foreign packet are taken over
    // host / viewer / display packets (recipient null) under a player's expectation, and a player's packet under a viewer's expectation
    expect(feed([view(T1(), { recipient: null })]).results[0].outcome).toBe('WITHDRAWN');
    expect(feed([view(T1())], { ...EXPECTED, recipientId: null }).results[0].outcome).toBe('WITHDRAWN');
    expect(feed([view(T1(), { recipient: null })], { ...EXPECTED, recipientId: null }).results[0].outcome).toBe('ACCEPTED');
  });
});

describe('N9 dice intake: the required chains', () => {
  it('new roll → null → older roll: nothing comes back, and the knowledge of the newer roll survives the withdrawal', () => {
    const rollTwo = view(T1({ state: 8, seq: 2, dv: 3, roll: 2 }));
    const olderRoll = view(T1({ state: 6, seq: 2, dv: 2, roll: 1 }));
    for (const gap of [null, undefined, 'junk', { nonsense: true }, view(T1({ state: 9 }), { recipient: 'p2' })]) {
      const { results, memo } = feed([rollTwo, gap, olderRoll]);
      expect(rolls(results[0])).toBe(2);
      expect(results[1]).toMatchObject({ outcome: 'WITHDRAWN', held: null });
      expect(results[2]).toMatchObject({ outcome: 'STALE', held: null }); // the older roll is not shown, no action is revived
      expect(memo).toMatchObject({ seenStateVersion: 8, seenDiceVersion: 3, seenRollCount: 2 });
    }
  });

  it('closed / locked → invalid → old active view: the old actionable view is not revived', () => {
    const active = view(T1({ state: 7, dv: 2, roll: 1 }));
    const closed = view(T1({ state: 9, dv: 4, roll: 2 }), { closed: true });
    const { results } = feed([closed, { ...closed, values: 'x' }, active]);
    expect(results[0].held).toMatchObject({ status: 'CLOSED', you: { canRoll: false, canHold: false } });
    expect(results[1].held).toBeNull();
    expect(results[2]).toMatchObject({ outcome: 'STALE', held: null });
    // the same for a sequence-level lock: a newer N8 version without any dice change also stays the newest knowledge
    const locked = view(T1({ state: 9, seq: 6, dv: 2, roll: 1 }), { status: 'IN_PROGRESS', holder: 'p2' }); // the turn changed hands in view of this recipient
    const oldActive = view(T1({ state: 7, seq: 5, dv: 2, roll: 1 }));
    expect(feed([locked, 'broken', oldActive]).results[2]).toMatchObject({ outcome: 'STALE', held: null });
  });

  it('A turn 1 → B turn 2 → A turn 3 → a late packet of A\'s turn 1: refused, whatever the local dice counters or the snapshot version say', () => {
    const turn1 = view({ state: 5, seq: 2, turn: 1, dv: 1, roll: 1 });
    const turn2 = view({ state: 7, seq: 3, turn: 2, dv: 0, roll: 0 }, { holder: 'p2' });
    const turn3 = view({ state: 9, seq: 4, turn: 3, dv: 0, roll: 0 });
    const { results, memo } = feed([turn1, turn2, turn3, turn1]);
    expect(results.map(r => r.outcome)).toEqual(['ACCEPTED', 'ACCEPTED', 'ACCEPTED', 'STALE']);
    expect(results[3].held).toMatchObject({ turnNumber: 3, status: 'PREPARED', values: null }); // still turn 3 — the turn-1 dice are not back
    expect(memo).toMatchObject({ seenTurnNumber: 3, seenDiceId: 'dice-t3' });
    // a per-process comparison would accept it (its dice version 1 is "newer" than turn 3's 0): the turn level refuses it on its own
    expect(turn1.release === 'VALUES' && turn1.diceVersion).toBeGreaterThan(0);
    // ... and even with the snapshot and sequence versions made look fresh, the old TURN is still old
    const fresh = view({ state: 12, seq: 9, turn: 1, dv: 1, roll: 1 });
    expect(feed([turn1, turn2, turn3, fresh]).results[3].outcome).toBe('STALE');
    // turn 3 is the SAME player again: the action offered for turn 1 can never be offered again
    expect(feed([turn1, turn3, turn1]).results[2].held).toMatchObject({ turnNumber: 3 });
  });

  it('same turn, new N8 BASIS stand (sequence version up, no new turn): the same dice and remaining rolls stay; the older action binding is stale', () => {
    const before = view({ state: 6, seq: 3, turn: 2, dv: 2, roll: 1 });
    const after = view({ state: 7, seq: 4, turn: 2, dv: 2, roll: 1 });
    const { results, memo } = feed([before, after, before]);
    expect(results.map(r => r.outcome)).toEqual(['ACCEPTED', 'ACCEPTED', 'STALE']);
    const shown = results[1].held as Extract<DiceProjection, { release: 'VALUES' }>;
    expect(shown).toMatchObject({ values: [1, 2, 3, 4, 5], rollCount: 1, diceVersion: 2, sequenceVersion: 4, turnNumber: 2 });
    expect(results[2].held).toEqual(results[1].held); // the late packet with the old binding did not replace the current one
    expect(memo).toMatchObject({ seenSequenceVersion: 4, seenDiceVersion: 2, seenRollCount: 1 });
    // after a withdrawal the old binding can not come back either
    expect(feed([before, after, null, before]).results[3]).toMatchObject({ outcome: 'STALE', held: null });
  });
});

describe('N9 dice intake: every ordering level protects on its own', () => {
  const NEWEST: Stand = { state: 10, seq: 5, turn: 3, dv: 4, roll: 2 };
  const OLDER: Array<[string, Partial<Stand>]> = [
    ['snapshot version', { state: 9 }], ['sequence version', { seq: 4 }], ['turn number', { turn: 2 }], ['dice version (same turn)', { dv: 3 }], ['roll number (same turn)', { roll: 1 }],
  ];
  it.each(OLDER)('a packet older ONLY in the %s is stale, although every other level is newer or equal', (_name, older) => {
    const newerElsewhere = { state: 11, seq: 6, turn: 4, dv: 5, roll: 3 };
    const packet: Stand = { ...NEWEST, ...older };
    // the other levels equal ...
    expect(feed([view(NEWEST), view(packet)]).results[1].outcome).toBe('STALE');
    // ... or higher than the seen ones; the process-local levels only count inside one turn, so they are not "higher" in a higher turn
    const key = Object.keys(older)[0] as keyof Stand;
    const lifted: Stand = { ...newerElsewhere, ...older };
    if (key === 'dv' || key === 'roll') lifted.turn = NEWEST.turn; // inside the same turn the local counters are compared
    if (key === 'dv' || key === 'roll') { lifted.dv = key === 'dv' ? older.dv! : 9; lifted.roll = key === 'roll' ? older.roll! : 3; }
    expect(feed([view(NEWEST), view(lifted, { values: [1, 2, 3, 4, 5] })]).results[1].outcome, key).toBe('STALE');
  });

  const NEWER: Array<[string, Partial<Stand>]> = [
    ['snapshot version', { state: 11 }], ['sequence version', { seq: 6 }], ['turn number', { turn: 4, dv: 0, roll: 0 }], ['dice version', { dv: 5 }], ['roll number', { roll: 3, dv: 5 }],
  ];
  it.each(NEWER)('a packet newer in the %s is accepted and raises exactly that knowledge', (_name, newer) => {
    const { results, memo } = feed([view(NEWEST), view({ ...NEWEST, ...newer })]);
    expect(results[1].outcome).toBe('ACCEPTED');
    expect(memo).toMatchObject({ seenStateVersion: newer.state ?? 10, seenSequenceVersion: newer.seq ?? 5, seenTurnNumber: newer.turn ?? 3 });
  });

  it('a higher turn is a NEW process: its restarted dice counters are accepted; inside the same turn another process id is foreign and moves nothing', () => {
    const turn3 = view({ state: 10, seq: 5, turn: 3, dv: 4, roll: 2 });
    const turn4 = view({ state: 11, seq: 6, turn: 4, dv: 0, roll: 0 });
    expect(feed([turn3, turn4]).results.map(r => r.outcome)).toEqual(['ACCEPTED', 'ACCEPTED']);
    expect(feed([turn3, turn4]).memo).toMatchObject({ seenDiceId: 'dice-t4', seenDiceVersion: 0, seenRollCount: 0 });
    const impostor = view({ state: 12, seq: 7, turn: 3, dv: 9, roll: 3, id: 'dice-other' }); // same turn 3, another process, "higher" everywhere
    const { results, memo } = feed([turn3, impostor]);
    expect(results[1]).toMatchObject({ outcome: 'STALE' });
    expect(results[1].held).toEqual(results[0].held);
    expect(memo).toMatchObject({ seenStateVersion: 10, seenDiceId: 'dice-t3', seenDiceVersion: 4 });
  });
});

describe('N9 dice intake: release, withdrawal and context', () => {
  it('release NONE raises the knowledge and shows nothing; at the very same stand a wider release is refused, a narrower or equal one accepted', () => {
    const none = view(T1({ state: 8, seq: 3, dv: 2, roll: 1 }), { release: 'NONE' });
    const values = view(T1({ state: 8, seq: 3, dv: 2, roll: 1 }));
    const older = view(T1({ state: 7, seq: 3, dv: 1, roll: 1 }));
    const a = feed([none, older]);
    expect(a.results[0]).toMatchObject({ outcome: 'RELEASE_NONE', held: null });
    expect(a.results[1].outcome).toBe('STALE');
    expect(feed([none, values]).results[1]).toMatchObject({ outcome: 'STALE', held: null }); // a withdrawal at this exact stand cannot be undone by an earlier packet
    expect(feed([values, none]).results.map(r => r.outcome)).toEqual(['ACCEPTED', 'RELEASE_NONE']);
    expect(feed([values, none, values]).results[2]).toMatchObject({ outcome: 'STALE', held: null });
    expect(feed([values, values]).results[1].outcome).toBe('ACCEPTED'); // an equal re-delivery is fine
    expect(feed([none, view(T1({ state: 9, seq: 3, dv: 3, roll: 2 }))]).results[1].outcome).toBe('ACCEPTED'); // a NEWER stand with values is shown again
  });

  it('null, undefined, invalid and foreign input withdraw everything shown but keep every number of knowledge', () => {
    const good = view(T1({ state: 8, seq: 3, turn: 2, dv: 2, roll: 1 }));
    for (const gap of [null, undefined, 'x', 7, [], {}, view(T1(), { recipient: 'p9' })]) {
      const { results, memo } = feed([good, gap]);
      expect(results[1]).toMatchObject({ outcome: 'WITHDRAWN', held: null });
      expect(memo).toMatchObject({ seenStateVersion: 8, seenSequenceVersion: 3, seenTurnNumber: 2, seenDiceVersion: 2, seenRollCount: 1, held: null });
    }
    expect(feed([null]).memo).toMatchObject({ seenStateVersion: -1, seenTurnNumber: -1, seenDiceId: null }); // nothing observed, nothing invented
  });

  it('another run, sequence, roster revision, unit or recipient is another context: it starts empty — knowledge of one context never fences or leaks into the other', () => {
    const run1 = view(T1({ state: 20, seq: 9, turn: 5, dv: 7, roll: 2 }));
    const run2 = { ...SCOPE, runIndex: 2 };
    const memo1 = intakeDiceProjection(null, EXPECTED, run1).memo;
    const run2Expected: DiceExpectedContext = { ...run2, recipientId: 'p1', minStateVersion: 1 };
    const result = intakeDiceProjection(memo1, run2Expected, view(T1({ state: 3, seq: 1, turn: 1, dv: 1, roll: 1 }), { scope: run2 })); // low counters of run 2 are NOT stale against run 1
    expect(result.outcome).toBe('ACCEPTED');
    expect(result.memo.key).not.toBe(memo1.key);
    expect(result.memo.seenStateVersion).toBe(3);
    for (const expected of [{ ...EXPECTED, sequenceId: 'seq-2' }, { ...EXPECTED, rosterRevision: 'roster-2' }, { ...EXPECTED, unit: 'TEAM' as const }, { ...EXPECTED, recipientId: 'p2' }]) {
      expect(intakeDiceProjection(memo1, expected, null).memo).toMatchObject({ seenStateVersion: -1, seenTurnNumber: -1 });
      expect(intakeDiceProjection(memo1, expected, null).memo.key).not.toBe(memo1.key);
    }
    // the same context with another minStateVersion is the same context (the minimum is not part of the key)
    expect(intakeDiceProjection(memo1, { ...EXPECTED, minStateVersion: 12 }, null).memo.seenStateVersion).toBe(20);
    expect(emptyDiceMemo('k')).toMatchObject({ seenStateVersion: -1, seenRelease: null, held: null });
  });

  it('is pure: it mutates no input (frozen input is enough) and never returns the input object', () => {
    const packet = deepFreeze(view(T1()));
    const memo = deepFreeze(intakeDiceProjection(null, EXPECTED, view(T1({ state: 4, dv: 0, roll: 0 }))).memo);
    const expected = deepFreeze({ ...EXPECTED });
    const result = intakeDiceProjection(memo, expected, packet);
    expect(result.held).toEqual(packet);
    expect(result.held).not.toBe(packet);
    expect(memo.seenStateVersion).toBe(4); // the previous memo is untouched
  });
});
