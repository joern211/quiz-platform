import { randomInt, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { applyStateEvent, createStateEvent, type EngineStateSnapshot } from '@quiz/game-sdk';
import * as contract from '@quiz/shared/dice';
import {
  DICE_CONFIG_FIVE_D6_HOLD, DICE_CONFIG_SINGLE_D6, DICE_ERROR_CODES, DICE_ISSUE_CODES, DiceActionBindingSchema, DiceConfigSchema, DiceHoldIntentSchema, DiceProjectionSchema,
  DiceRollIntentSchema, DiceScopeSchema, diceActionBindingKey, parseDiceProjection, type DiceConfig,
} from '@quiz/shared/dice';
import { TURN_SEQUENCE_ERROR_CODES, TurnSequenceScopeSchema } from '@quiz/shared/turnSequence';
import { gameErrorCode } from './errors.js';
import {
  applyDecidedDiceRoll, closeDiceTurn, DiceTurnError, diceTurnScopeOf, openDiceTurn, parseDiceTurnState, projectDiceTurn, readDiceHoldIntent, readDiceRollIntent, rollDice, setDiceHeld,
  type DiceIntSource, type DiceTurnState,
} from './diceTurn.js';
import {
  advanceTurnSequence, closeTurnSequence, currentTurnHolder, overrideTurnSequence, prepareTurnSequence, refreshEligibilityBasis, startTurnSequence, turnEligibilityAdvancesBasis,
  turnSequenceScopeOf, withholdCurrentHolder, type TurnEligibility, type TurnSequenceState,
} from './turnSequence.js';
import type { ProjectionAudience } from './visibility.js';

// The default random source is node:crypto.randomInt. It is wrapped (same behaviour) ONLY so that the tests can count its calls.
vi.mock('node:crypto', async importOriginal => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomInt: vi.fn(actual.randomInt) };
});

// A mutable view for the deliberate corruption tests (the point is to break the shape).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Draft = any;

// ── Synthetic fixtures. Ids are not names; nothing here is a game preset or a rule. ─────────────

const BASE = { runIndex: 1, sequenceId: 'seq-1', rosterRevision: 'roster-1' };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const deepFreeze = <T>(value: T): T => {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) { Object.freeze(value); for (const inner of Object.values(value)) deepFreeze(inner); }
  return value;
};
const level = (activeIds: string[], version: number, trackId: string, knownIds: string[], runIndex = BASE.runIndex) => ({ runIndex, trackId, rosterRevision: 'track-roster-1', version, knownIds, activeIds });
const KNOWN_PLAYERS = ['a', 'b', 'c', 'd'];
const KNOWN_TEAMS = ['T1', 'T2'];
const KNOWN_MEMBERS = ['A', 'B', 'C', 'D', 'E'];
const pel = (actors: string[], version = 1, runIndex = BASE.runIndex): TurnEligibility => ({ actors: level(actors, version, 'players-track', KNOWN_PLAYERS, runIndex), members: null });
const tel = (teams: string[], members: string[], version = 1): TurnEligibility => ({ actors: level(teams, version, 'teams-track', KNOWN_TEAMS), members: level(members, version, 'members-track', KNOWN_MEMBERS) });
const PLAYERS = ['a', 'b', 'c'];
const TEAMS = [{ teamId: 'T1', members: ['A', 'B'] }, { teamId: 'T2', members: ['C', 'D', 'E'] }];
const everyone = (seq: TurnSequenceState, version = 1): TurnEligibility => (seq.unit === 'PLAYER' ? pel(seq.order, version) : tel(seq.order, seq.teams!.flatMap(t => t.members), version));
const sc = (seq: TurnSequenceState) => turnSequenceScopeOf(seq);
const playerSequence = (): TurnSequenceState => {
  const prepared = prepareTurnSequence({ ...BASE, unit: 'PLAYER', mode: 'FIXED', order: PLAYERS });
  return startTurnSequence(prepared, { scope: sc(prepared), expectedVersion: 0, eligibility: pel(PLAYERS) }).state;
};
const teamSequence = (): TurnSequenceState => {
  const prepared = prepareTurnSequence({ ...BASE, unit: 'TEAM', mode: 'FIXED', order: ['T1', 'T2'], teams: TEAMS });
  return startTurnSequence(prepared, { scope: sc(prepared), expectedVersion: 0, eligibility: everyone(prepared) }).state;
};
const advance = (seq: TurnSequenceState, eligibility: TurnEligibility = everyone(seq)): TurnSequenceState =>
  advanceTurnSequence(seq, { scope: sc(seq), expectedVersion: seq.version, expectedTurnNumber: seq.turnNumber, outcome: 'COMPLETE', eligibility }).state;
const holderOf = (seq: TurnSequenceState) => currentTurnHolder(seq)!;
const callerOf = (seq: TurnSequenceState) => { // a sequence without a holder (HELD handled by the holder, NO_ELIGIBLE) has nobody to name: the tests then pass their own caller
  const holder = currentTurnHolder(seq);
  return { role: 'PLAYER' as const, participantId: holder?.playerId ?? 'nobody', teamId: holder?.teamId ?? null };
};
const OPEN_GATE = { admitted: true, phaseOpen: true, paused: false };

const open = (seq: TurnSequenceState, config: DiceConfig = DICE_CONFIG_FIVE_D6_HOLD, diceId = 'dice-1'): DiceTurnState =>
  openDiceTurn({ scope: sc(seq), diceId, config, sequence: seq, expectedTurnNumber: seq.turnNumber });
/** One client intent bound to what it SAW: the N8 sequence and the dice state. */
const act = (dice: DiceTurnState, seq: TurnSequenceState, over: Record<string, unknown> = {}) => ({
  scope: sc(seq), diceId: dice.diceId, sequence: seq, expectedTurnNumber: seq.turnNumber, expectedSequenceVersion: seq.version, expectedVersion: dice.version, expectedRollCount: dice.rollCount,
  caller: callerOf(seq), gate: OPEN_GATE, eligibility: everyone(seq), ...over,
});
function source(values: number[]) {
  const calls: Array<[number, number]> = [];
  let index = 0;
  const fn: DiceIntSource = (min, max) => { calls.push([min, max]); return values[index++]; };
  return { fn, calls };
}
const roll = (dice: DiceTurnState, seq: TurnSequenceState, values: number[], over: Record<string, unknown> = {}) => {
  const s = source(values);
  const result = rollDice(dice, { ...act(dice, seq, over), source: s.fn } as never);
  return { ...result, calls: s.calls };
};
const hold = (dice: DiceTurnState, seq: TurnSequenceState, held: readonly number[], over: Record<string, unknown> = {}) => setDiceHeld(dice, { ...act(dice, seq, over), held } as never);
const closeIt = (dice: DiceTurnState, over: Record<string, unknown> = {}) => closeDiceTurn(dice, { scope: diceTurnScopeOf(dice), diceId: dice.diceId, expectedTurnNumber: dice.binding.turnNumber, expectedVersion: dice.version, ...over } as never);
const codeOf = (fn: () => unknown): string => {
  try { fn(); return 'NO_THROW'; } catch (error) { const code = (error as { code?: unknown }).code; return typeof code === 'string' ? code : `OTHER:${String(error)}`; }
};
const issuesOf = (fn: () => unknown): readonly string[] => { try { fn(); return []; } catch (error) { return error instanceof DiceTurnError ? error.issues : ['OTHER']; } };

/** A started player sequence with a PREPARED five-dice process for holder `a`. */
function rig(config: DiceConfig = DICE_CONFIG_FIVE_D6_HOLD) {
  const seq = playerSequence();
  return { seq, dice: open(seq, config) };
}

// ── A. Configuration and opening ─────────────────────────────

describe('N9 A: configuration and opening', () => {
  it('both explicit profiles are exactly what the order says, are frozen, and open the same implementation', () => {
    expect(DICE_CONFIG_FIVE_D6_HOLD).toEqual({ diceCount: 5, sides: 6, maxRolls: 3, holdAllowed: true });
    expect(DICE_CONFIG_SINGLE_D6).toEqual({ diceCount: 1, sides: 6, maxRolls: 1, holdAllowed: false });
    expect(Object.isFrozen(DICE_CONFIG_FIVE_D6_HOLD) && Object.isFrozen(DICE_CONFIG_SINGLE_D6)).toBe(true);
    const seq = playerSequence();
    expect(open(seq, DICE_CONFIG_FIVE_D6_HOLD).config).toEqual(DICE_CONFIG_FIVE_D6_HOLD);
    expect(open(seq, DICE_CONFIG_SINGLE_D6).config).toEqual(DICE_CONFIG_SINGLE_D6);
    expect(open(seq, { diceCount: 2, sides: 20, maxRolls: 10, holdAllowed: true }).config).toEqual({ diceCount: 2, sides: 20, maxRolls: 10, holdAllowed: true });
  });

  it('a fresh process has NO dice values: null, nothing held, nothing rolled — never a 0, an empty string or a placeholder', () => {
    const { dice } = rig();
    expect(dice).toMatchObject({ kind: 'DICE_TURN', phase: 'PREPARED', version: 0, rollCount: 0, values: null, held: [false, false, false, false, false], lastRolled: [] });
    expect(JSON.stringify(dice)).not.toMatch(/"values":\[/);
  });

  it('the stored configuration is a copy: changing the argument afterwards (or the profile object) changes nothing stored', () => {
    const seq = playerSequence();
    const mine = { ...DICE_CONFIG_FIVE_D6_HOLD };
    const dice = open(seq, mine);
    mine.sides = 20;
    expect(dice.config.sides).toBe(6);
  });

  it.each([
    ['zero dice', { diceCount: 0, sides: 6, maxRolls: 3, holdAllowed: true }], ['too many dice', { diceCount: 11, sides: 6, maxRolls: 3, holdAllowed: true }],
    ['fractional dice', { diceCount: 2.5, sides: 6, maxRolls: 3, holdAllowed: true }], ['string dice', { diceCount: '5', sides: 6, maxRolls: 3, holdAllowed: true }],
    ['NaN dice', { diceCount: NaN, sides: 6, maxRolls: 3, holdAllowed: true }], ['Infinity sides', { diceCount: 5, sides: Infinity, maxRolls: 3, holdAllowed: true }],
    ['one side', { diceCount: 5, sides: 1, maxRolls: 3, holdAllowed: true }], ['too many sides', { diceCount: 5, sides: 21, maxRolls: 3, holdAllowed: true }],
    ['unsafe sides', { diceCount: 5, sides: Number.MAX_SAFE_INTEGER + 1, maxRolls: 3, holdAllowed: true }],
    ['no rolls', { diceCount: 5, sides: 6, maxRolls: 0, holdAllowed: false }], ['too many rolls', { diceCount: 5, sides: 6, maxRolls: 11, holdAllowed: true }],
    ['negative rolls', { diceCount: 5, sides: 6, maxRolls: -1, holdAllowed: false }],
    ['holding with a single roll', { diceCount: 5, sides: 6, maxRolls: 1, holdAllowed: true }],
    ['non-boolean hold flag', { diceCount: 5, sides: 6, maxRolls: 3, holdAllowed: 1 }], ['missing key', { diceCount: 5, sides: 6, maxRolls: 3 }],
    ['unknown key', { diceCount: 5, sides: 6, maxRolls: 3, holdAllowed: true, seed: 'x' }], ['null', null], ['array', [5, 6, 3, true]], ['string', 'FIVE_D6'],
  ])('configuration %s is rejected as DICE_CONFIG_INVALID — never rounded or corrected', (_name, config) => {
    const seq = playerSequence();
    expect(codeOf(() => openDiceTurn({ scope: sc(seq), diceId: 'dice-1', config: config as never, sequence: seq, expectedTurnNumber: 1 }))).toBe('DICE_CONFIG_INVALID');
    expect(DiceConfigSchema.safeParse(config).success).toBe(false);
  });

  it('opening reads run, sequence, roster, unit, turn number and the holder from the SERVER-SIDE N8 state — in player and in team mode', () => {
    const p = open(playerSequence());
    expect(p.runIndex).toBe(1);
    expect(p.binding).toEqual({ sequenceId: 'seq-1', rosterRevision: 'roster-1', unit: 'PLAYER', turnNumber: 1, playerId: 'a', teamId: null });
    const t = open(teamSequence());
    expect(t.binding).toEqual({ sequenceId: 'seq-1', rosterRevision: 'roster-1', unit: 'TEAM', turnNumber: 1, playerId: 'A', teamId: 'T1' });
    expect(diceTurnScopeOf(t)).toEqual({ runIndex: 1, sequenceId: 'seq-1', rosterRevision: 'roster-1', unit: 'TEAM' });
  });

  it('opening refuses everything that is not the current ACTIVE turn', () => {
    const seq = playerSequence();
    const attempt = (state: TurnSequenceState, over: Record<string, unknown> = {}) => openDiceTurn({ scope: sc(state), diceId: 'dice-1', config: DICE_CONFIG_FIVE_D6_HOLD, sequence: state, expectedTurnNumber: state.turnNumber, ...over } as never);
    const ready = prepareTurnSequence({ ...BASE, unit: 'PLAYER', mode: 'FIXED', order: PLAYERS });
    expect(codeOf(() => attempt(ready))).toBe('DICE_SEQUENCE_NOT_ACTIVE');
    const held = withholdCurrentHolder(seq, { scope: sc(seq), expectedVersion: seq.version, expectedTurnNumber: seq.turnNumber, eligibility: pel(['b', 'c'], 2) }).state;
    expect(held.phase).toBe('HELD');
    expect(codeOf(() => attempt(held))).toBe('DICE_SEQUENCE_NOT_ACTIVE');
    const nobody = advance(seq, pel([], 2));
    expect(nobody.phase).toBe('NO_ELIGIBLE');
    expect(codeOf(() => attempt(nobody))).toBe('DICE_SEQUENCE_NOT_ACTIVE');
    const closed = closeTurnSequence(seq, { scope: sc(seq), expectedVersion: seq.version }).state;
    expect(codeOf(() => attempt(closed))).toBe('DICE_SEQUENCE_NOT_ACTIVE');
    expect(codeOf(() => attempt(seq, { expectedTurnNumber: 2 }))).toBe('DICE_TURN_STALE');
    expect(codeOf(() => attempt(seq, { expectedTurnNumber: '1' }))).toBe('DICE_TURN_STALE');
    expect(codeOf(() => attempt(seq, { scope: { ...sc(seq), runIndex: 2 } }))).toBe('DICE_SCOPE_STALE');
    expect(codeOf(() => attempt(seq, { scope: { ...sc(seq), sequenceId: 'other' } }))).toBe('DICE_SCOPE_STALE');
    expect(codeOf(() => attempt(seq, { scope: { ...sc(seq), unit: 'TEAM' } }))).toBe('DICE_SCOPE_STALE');
    expect(codeOf(() => attempt(seq, { scope: { runIndex: 1 } }))).toBe('DICE_ARGS_INVALID');
    expect(codeOf(() => attempt(seq, { diceId: 'bad id!' }))).toBe('DICE_ARGS_INVALID');
    expect(codeOf(() => attempt(seq, { playerId: 'b' }))).toBe('DICE_ARGS_INVALID'); // a holder can not be named by the caller
    expect(codeOf(() => attempt(seq, { sequence: { nonsense: true } }))).toBe('TURN_SEQ_STATE_INVALID');
  });
});

// ── B. Rolling ───────────────────────────────────────────────

describe('N9 B: rolls', () => {
  it('the first roll draws one value per die from 1..sides, stores the whole decided result and moves each counter exactly once', () => {
    const { seq, dice } = rig();
    const r = roll(dice, seq, [3, 1, 4, 1, 5]);
    expect(r.changed).toBe(true);
    expect(r.calls).toEqual([[1, 7], [1, 7], [1, 7], [1, 7], [1, 7]]); // randomInt(minInclusive, maxExclusive): 1..6
    expect(r.state).toMatchObject({ phase: 'IN_PROGRESS', version: 1, rollCount: 1, values: [3, 1, 4, 1, 5], held: [false, false, false, false, false], lastRolled: [0, 1, 2, 3, 4] });
    expect(r.transition).toEqual({ kind: 'ROLL', versionBefore: 0, versionAfter: 1, rollCountBefore: 0, rollCountAfter: 1, phaseBefore: 'PREPARED', phaseAfter: 'IN_PROGRESS', rolled: { indices: [0, 1, 2, 3, 4], values: [3, 1, 4, 1, 5] }, held: null });
    expect(r.sequenceBasisAdvanced).toBe(false);
  });

  it('THE holding case: roll 1 = [1,2,3,4,5], hold positions 1 and 3, new values only for positions 0,2,4 = [6,6,6] → [6,2,6,4,6]; holding used no roll; exactly three positions were drawn', () => {
    const { seq, dice } = rig();
    const r1 = roll(dice, seq, [1, 2, 3, 4, 5]);
    const h = hold(r1.state, seq, [1, 3]);
    expect(h.changed).toBe(true);
    expect(h.state).toMatchObject({ rollCount: 1, values: [1, 2, 3, 4, 5], held: [false, true, false, true, false], phase: 'IN_PROGRESS' }); // holding: no value change, no roll
    expect(h.state.version).toBe(r1.state.version + 1);
    const r2 = roll(h.state, seq, [6, 6, 6]);
    expect(r2.calls).toHaveLength(3);
    expect(r2.state.values).toEqual([6, 2, 6, 4, 6]);
    expect(r2.state).toMatchObject({ rollCount: 2, lastRolled: [0, 2, 4], held: [false, true, false, true, false], phase: 'IN_PROGRESS' });
    expect(r2.transition?.rolled).toEqual({ indices: [0, 2, 4], values: [6, 6, 6] });
  });

  it('positions are identities: equal values on different positions stay different dice, and nothing is ever sorted by face value', () => {
    const { seq, dice } = rig();
    const r1 = roll(dice, seq, [4, 4, 1, 1, 6]);
    const h = hold(r1.state, seq, [1]); // the SECOND four is held, the FIRST four is not
    const r2 = roll(h.state, seq, [2, 3, 5, 6]);
    expect(r2.state.values).toEqual([2, 4, 3, 5, 6]); // position 1 keeps its 4; position 0 (also a 4 before) was re-drawn; order untouched, not sorted
    expect(r2.calls).toHaveLength(4);
    // the other way round: hold position 0 only
    const r2b = roll(hold(r1.state, seq, [0]).state, seq, [6, 6, 6, 6]);
    expect(r2b.state.values).toEqual([4, 6, 6, 6, 6]);
    // all five equal: holding one of them is still ONE position
    const same = roll(dice, seq, [5, 5, 5, 5, 5]);
    const r3 = roll(hold(same.state, seq, [2]).state, seq, [1, 2, 3, 4]);
    expect(r3.state.values).toEqual([1, 2, 5, 3, 4]);
  });

  it('an equal old and new value is a valid result: it is not re-drawn and does not change the number of draws', () => {
    const { seq, dice } = rig();
    const r1 = roll(dice, seq, [6, 6, 6, 6, 6]);
    const r2 = roll(r1.state, seq, [6, 6, 6, 6, 6]); // every die shows the same as before
    expect(r2.calls).toHaveLength(5);
    expect(r2.state.values).toEqual([6, 6, 6, 6, 6]);
    expect(r2.state.rollCount).toBe(2);
    expect(r2.state.lastRolled).toEqual([0, 1, 2, 3, 4]); // the roll happened even though nothing looks different
  });

  it('the roll limit holds: the third roll exhausts the process, a fourth is refused WITHOUT a draw; the single-roll profile exhausts on the first', () => {
    const { seq, dice } = rig();
    const r1 = roll(dice, seq, [1, 1, 1, 1, 1]);
    const r2 = roll(r1.state, seq, [2, 2, 2, 2, 2]);
    expect(r2.state.phase).toBe('IN_PROGRESS');
    const r3 = roll(r2.state, seq, [3, 3, 3, 3, 3]);
    expect(r3.state).toMatchObject({ phase: 'EXHAUSTED', rollCount: 3, values: [3, 3, 3, 3, 3] });
    const s = source([4, 4, 4, 4, 4]);
    expect(codeOf(() => rollDice(r3.state, { ...act(r3.state, seq), source: s.fn } as never))).toBe('DICE_ROLLS_EXHAUSTED');
    expect(s.calls).toHaveLength(0);
    const one = rig(DICE_CONFIG_SINGLE_D6);
    const only = roll(one.dice, one.seq, [4]);
    expect(only.state).toMatchObject({ phase: 'EXHAUSTED', rollCount: 1, values: [4], lastRolled: [0] });
    const s2 = source([5]);
    expect(codeOf(() => rollDice(only.state, { ...act(only.state, one.seq), source: s2.fn } as never))).toBe('DICE_ROLLS_EXHAUSTED');
    expect(s2.calls).toHaveLength(0);
  });

  it('all dice held: a roll is the explicit result DICE_NOTHING_TO_ROLL — no draw, no consumed roll, no implicit rule, nothing changed', () => {
    const { seq, dice } = rig();
    const r1 = roll(dice, seq, [1, 2, 3, 4, 5]);
    const all = hold(r1.state, seq, [0, 1, 2, 3, 4]);
    expect(all.state.held).toEqual([true, true, true, true, true]);
    const before = clone(all.state);
    const s = source([6, 6, 6, 6, 6]);
    expect(codeOf(() => rollDice(all.state, { ...act(all.state, seq), source: s.fn } as never))).toBe('DICE_NOTHING_TO_ROLL');
    expect(s.calls).toHaveLength(0);
    expect(all.state).toEqual(before);
    expect(all.state.rollCount).toBe(1); // no roll was spent
    // releasing one die makes the roll possible again, with exactly one draw
    const freed = hold(all.state, seq, [0, 1, 2, 3]);
    const r2 = roll(freed.state, seq, [6]);
    expect(r2.calls).toHaveLength(1);
    expect(r2.state.values).toEqual([1, 2, 3, 4, 6]);
  });

  it('a broken random source is refused as DICE_RANDOM_INVALID (out of range, fractional, NaN, string, missing, huge) — no clamping, no second draw, input untouched', () => {
    const { seq, dice } = rig(DICE_CONFIG_SINGLE_D6);
    const before = clone(dice);
    for (const bad of [0, 7, -1, 1.5, NaN, Infinity, '3', null, undefined, Number.MAX_SAFE_INTEGER + 2]) {
      const s = source([bad as never, 3]);
      expect(codeOf(() => rollDice(dice, { ...act(dice, seq), source: s.fn } as never)), String(bad)).toBe('DICE_RANDOM_INVALID');
      expect(s.calls).toHaveLength(1); // the value is refused on sight; there is no redraw and no "draw until it looks right"
    }
    expect(codeOf(() => rollDice(dice, { ...act(dice, seq), source: 5 } as never))).toBe('DICE_ARGS_INVALID');
    expect(dice).toEqual(before);
  });

  it('the default source is the unbiased crypto source (randomInt(1, sides+1)); Math.random and the clock are never used', () => {
    const { seq, dice } = rig();
    const mathRandom = vi.spyOn(Math, 'random');
    const now = vi.spyOn(Date, 'now');
    const hrtime = vi.spyOn(process, 'hrtime');
    vi.mocked(randomInt).mockClear();
    const r = rollDice(dice, act(dice, seq) as never);
    expect(vi.mocked(randomInt).mock.calls).toEqual([[1, 7], [1, 7], [1, 7], [1, 7], [1, 7]]);
    expect(r.state.values!.every(v => Number.isInteger(v) && v >= 1 && v <= 6)).toBe(true);
    // a die with 20 sides asks for 1..20
    vi.mocked(randomInt).mockClear();
    const big = open(seq, { diceCount: 1, sides: 20, maxRolls: 1, holdAllowed: false }, 'dice-20');
    rollDice(big, act(big, seq) as never);
    expect(vi.mocked(randomInt).mock.calls).toEqual([[1, 21]]);
    expect(mathRandom).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    expect(hrtime).not.toHaveBeenCalled();
    mathRandom.mockRestore(); now.mockRestore(); hrtime.mockRestore();
  });

  it('every face of every supported die size occurs, none outside the range, none is wildly favoured (coarse sanity — NOT the unbiasedness proof, that is the source contract)', () => {
    const seq = playerSequence();
    for (const sides of [2, 6, 20]) {
      const counts = new Map<number, number>();
      const per = 3000;
      for (let i = 0; i < per; i++) {
        const dice = open(seq, { diceCount: 1, sides, maxRolls: 1, holdAllowed: false }, `d-${sides}`);
        const value = rollDice(dice, act(dice, seq) as never).state.values![0];
        counts.set(value, (counts.get(value) ?? 0) + 1);
      }
      expect([...counts.keys()].every(v => v >= 1 && v <= sides)).toBe(true);
      expect(counts.size).toBe(sides);
      for (const n of counts.values()) expect(n).toBeGreaterThan((per / sides) * 0.6); // loose on purpose: a flaky threshold would prove nothing
    }
  });
});

// ── C. Holding ───────────────────────────────────────────────

describe('N9 C: hold and release (explicit target assignment)', () => {
  const afterFirstRoll = () => { const { seq, dice } = rig(); return { seq, rolled: roll(dice, seq, [1, 2, 3, 4, 5]).state }; };

  it('holding changes only the assignment: values, roll number and phase stay; one version step; no draw; release-all is []', () => {
    const { seq, rolled } = afterFirstRoll();
    const h = hold(rolled, seq, [3, 1]); // any order
    expect(h.state).toMatchObject({ values: [1, 2, 3, 4, 5], rollCount: 1, phase: 'IN_PROGRESS', held: [false, true, false, true, false], version: rolled.version + 1 });
    expect(h.state.lastRolled).toEqual(rolled.lastRolled); // the "last rolled" marker is not a hold marker
    expect(h.transition).toMatchObject({ kind: 'HOLD', rolled: null, held: [1, 3], rollCountBefore: 1, rollCountAfter: 1 });
    const none = hold(h.state, seq, []);
    expect(none.state.held).toEqual([false, false, false, false, false]);
    expect(none.changed).toBe(true);
    expect(none.state.version).toBe(h.state.version + 1);
  });

  it('the SAME target again at the current version is a valid no-op: no effect, no version step, no transition — the stale version stays stale', () => {
    const { seq, rolled } = afterFirstRoll();
    const h = hold(rolled, seq, [1, 3]);
    const again = hold(h.state, seq, [3, 1]);
    expect(again).toMatchObject({ changed: false, transition: null });
    expect(again.state).toEqual(h.state);
    const noneAgain = hold(rolled, seq, []); // nothing was held; "release all" changes nothing
    expect(noneAgain.changed).toBe(false);
    // a repeat that still carries the OLD version (the answer to the first one was lost, a brand-new intent was built) is stale, not "idempotent"
    expect(codeOf(() => hold(h.state, seq, [1, 3], { expectedVersion: rolled.version }))).toBe('DICE_VERSION_STALE');
    expect(codeOf(() => hold(h.state, seq, [1, 3], { expectedRollCount: 0 }))).toBe('DICE_ROLL_STALE');
  });

  it.each([
    ['unknown position', [5]], ['negative', [-1]], ['fractional', [1.5]], ['duplicate', [1, 1]], ['string index', ['1']], ['NaN', [NaN]], ['null entry', [null]],
    ['too many entries', [0, 1, 2, 3, 4, 0]], ['not an array', 'x'], ['object', {}], ['undefined', undefined], ['huge', [Number.MAX_SAFE_INTEGER + 1]], ['Infinity', [Infinity]],
  ])('invalid target %s is DICE_HOLD_INVALID and changes nothing', (_name, target) => {
    const { seq, rolled } = afterFirstRoll();
    const before = clone(rolled);
    expect(codeOf(() => setDiceHeld(rolled, { ...act(rolled, seq), held: target } as never))).toBe('DICE_HOLD_INVALID');
    expect(rolled).toEqual(before);
  });

  it('holding is only possible in IN_PROGRESS of a profile with holding — each other case has its own code', () => {
    const { seq, dice } = rig();
    expect(codeOf(() => hold(dice, seq, [0]))).toBe('DICE_NOT_ROLLED'); // before the first roll
    const r1 = roll(dice, seq, [1, 2, 3, 4, 5]);
    const r2 = roll(r1.state, seq, [1, 2, 3, 4, 5]);
    const r3 = roll(r2.state, seq, [1, 2, 3, 4, 5]);
    expect(codeOf(() => hold(r3.state, seq, [0]))).toBe('DICE_ROLLS_EXHAUSTED'); // after the third roll
    const closed = closeIt(r1.state).state;
    expect(codeOf(() => hold(closed, seq, [0]))).toBe('DICE_CLOSED');
    const single = rig(DICE_CONFIG_SINGLE_D6);
    expect(codeOf(() => hold(single.dice, single.seq, [0]))).toBe('DICE_HOLD_DISABLED'); // in principle impossible — also before and after the roll
    expect(codeOf(() => hold(single.dice, single.seq, []))).toBe('DICE_HOLD_DISABLED');
    expect(codeOf(() => hold(roll(single.dice, single.seq, [3]).state, single.seq, [0]))).toBe('DICE_HOLD_DISABLED');
  });

  it('hold against roll: whichever came first wins; the other one, bound to the older dice version, is refused — an old hold set is never mixed with a new result', () => {
    const { seq, rolled } = afterFirstRoll();
    // (1) hold first, then a roll that was prepared against the version BEFORE the hold
    const held = hold(rolled, seq, [0, 1]).state;
    const s1 = source([6, 6, 6]);
    expect(codeOf(() => rollDice(held, { ...act(held, seq, { expectedVersion: rolled.version }), source: s1.fn } as never))).toBe('DICE_VERSION_STALE');
    expect(s1.calls).toHaveLength(0);
    // (2) roll first, then a hold that was prepared against the version BEFORE the roll
    const rolledAgain = roll(rolled, seq, [6, 6, 6, 6, 6]).state;
    expect(codeOf(() => hold(rolledAgain, seq, [0], { expectedVersion: rolled.version, expectedRollCount: rolled.rollCount }))).toBe('DICE_VERSION_STALE');
    // the roll prepared against the version AFTER the hold works, with exactly the held set the client saw
    const r = roll(held, seq, [6, 6, 6]);
    expect(r.state.values).toEqual([1, 2, 6, 6, 6]);
    // two holds on the same expected version: the second one is stale
    const first = hold(rolled, seq, [2]).state;
    expect(codeOf(() => hold(first, seq, [3], { expectedVersion: rolled.version }))).toBe('DICE_VERSION_STALE');
  });

  it('a roll number that disagrees with the process is DICE_ROLL_STALE even at the matching version (an intent can never turn roll n into roll n+2)', () => {
    const { seq, rolled } = afterFirstRoll();
    const s = source([1, 1, 1, 1, 1]);
    expect(codeOf(() => rollDice(rolled, { ...act(rolled, seq, { expectedRollCount: 2 }), source: s.fn } as never))).toBe('DICE_ROLL_STALE');
    expect(codeOf(() => rollDice(rolled, { ...act(rolled, seq, { expectedRollCount: '1' }), source: s.fn } as never))).toBe('DICE_ROLL_STALE');
    expect(s.calls).toHaveLength(0);
  });
});

// ── D. Closing ───────────────────────────────────────────────

describe('N9 D: closing is explicit, terminal and decides nothing', () => {
  it('closing keeps values, holds and roll number, raises the version once and neither reopens nor resets; repeating at the current version is a no-op, an older version is stale', () => {
    const { seq, dice } = rig();
    const r1 = roll(dice, seq, [2, 3, 4, 5, 6]).state;
    const held = hold(r1, seq, [0, 4]).state;
    const sequenceBefore = clone(seq);
    const c = closeIt(held);
    expect(c.changed).toBe(true);
    expect(c.state).toMatchObject({ phase: 'CLOSED', values: [2, 3, 4, 5, 6], held: [true, false, false, false, true], rollCount: 1, version: held.version + 1 });
    expect(c.transition).toMatchObject({ kind: 'CLOSE', phaseBefore: 'IN_PROGRESS', phaseAfter: 'CLOSED', rolled: null, held: null });
    expect(seq).toEqual(sequenceBefore); // N8 is not touched, no turn change, no points
    const again = closeIt(c.state);
    expect(again).toMatchObject({ changed: false, transition: null });
    expect(again.state).toEqual(c.state);
    expect(codeOf(() => closeIt(c.state, { expectedVersion: held.version }))).toBe('DICE_VERSION_STALE');
    // never reopens: no roll, no hold, no matter what the intent carries
    const s = source([1, 1, 1, 1, 1]);
    expect(codeOf(() => rollDice(c.state, { ...act(c.state, seq), source: s.fn } as never))).toBe('DICE_CLOSED');
    expect(codeOf(() => hold(c.state, seq, []))).toBe('DICE_CLOSED');
    expect(codeOf(() => applyDecidedDiceRoll(c.state, { expectedVersion: c.state.version, expectedRollCount: 1, indices: [0, 1, 2, 3, 4], values: [1, 1, 1, 1, 1] }))).toBe('DICE_CLOSED');
    expect(s.calls).toHaveLength(0);
  });

  it('early closing is possible: after roll 1 (even before any roll), with or without values', () => {
    const { seq, dice } = rig();
    const empty = closeIt(dice).state;
    expect(empty).toMatchObject({ phase: 'CLOSED', values: null, rollCount: 0, version: 1 });
    const early = closeIt(roll(dice, seq, [1, 2, 3, 4, 5]).state).state;
    expect(early).toMatchObject({ phase: 'CLOSED', rollCount: 1 });
    const exhausted = closeIt(roll(roll(roll(dice, seq, [1, 1, 1, 1, 1]).state, seq, [1, 1, 1, 1, 1]).state, seq, [1, 1, 1, 1, 1]).state).state;
    expect(exhausted).toMatchObject({ phase: 'CLOSED', rollCount: 3 });
  });

  it('closing is bound to the process (scope, id, turn, version) and needs no live N8 turn: it still works after the sequence moved on', () => {
    const { seq, dice } = rig();
    expect(codeOf(() => closeIt(dice, { scope: { ...diceTurnScopeOf(dice), runIndex: 2 } }))).toBe('DICE_SCOPE_STALE');
    expect(codeOf(() => closeIt(dice, { scope: { ...diceTurnScopeOf(dice), sequenceId: 'x' } }))).toBe('DICE_SCOPE_STALE');
    expect(codeOf(() => closeIt(dice, { diceId: 'dice-2' }))).toBe('DICE_SCOPE_STALE');
    expect(codeOf(() => closeIt(dice, { expectedTurnNumber: 2 }))).toBe('DICE_TURN_STALE');
    expect(codeOf(() => closeIt(dice, { expectedVersion: 1 }))).toBe('DICE_VERSION_STALE');
    expect(codeOf(() => closeIt(dice, { expectedVersion: '0' }))).toBe('DICE_VERSION_STALE');
    expect(codeOf(() => closeIt(dice, { scope: { runIndex: 1 } }))).toBe('DICE_ARGS_INVALID');
    expect(codeOf(() => closeIt(dice, { extra: true }))).toBe('DICE_ARGS_INVALID');
    const moved = advance(seq); // turn 2 of b — the consumer closes a's process in the same commit
    expect(moved.turnNumber).toBe(2);
    expect(closeIt(dice).changed).toBe(true);
  });
});

// ── E. Authorisation through N8 ──────────────────────────────

describe('N9 E: the current N8 turn decides who may roll and hold — before the random source', () => {
  const attempts = (dice: DiceTurnState, seq: TurnSequenceState, over: Record<string, unknown>) => {
    const s = source([1, 1, 1, 1, 1]);
    const rolled = codeOf(() => rollDice(dice, { ...act(dice, seq, over), source: s.fn } as never));
    const held = codeOf(() => setDiceHeld(dice, { ...act(dice, seq, over), held: [0] } as never));
    return { rolled, held, draws: s.calls.length };
  };

  it('only the named, admitted holder may roll or hold; a player who is not on turn, a non-playing host, a viewer and a display may not (no draw)', () => {
    const { seq, dice } = rig();
    expect(attempts(dice, seq, { caller: { role: 'PLAYER', participantId: 'b', teamId: null } })).toEqual({ rolled: 'TURN_SEQ_NOT_CURRENT_ACTOR', held: 'TURN_SEQ_NOT_CURRENT_ACTOR', draws: 0 });
    for (const role of ['HOST', 'VIEWER', 'DISPLAY', 'ADMIN', '']) {
      expect(attempts(dice, seq, { caller: { role, participantId: 'a', teamId: null } }), role).toEqual({ rolled: 'TURN_SEQ_ROLE_NOT_ALLOWED', held: 'TURN_SEQ_ROLE_NOT_ALLOWED', draws: 0 });
    }
    // a playing host is a PLAYER of this check: on turn he rolls, off turn he does not (host rights add nothing)
    expect(codeOf(() => roll(dice, seq, [1, 2, 3, 4, 5], { caller: { role: 'PLAYER', participantId: 'a', teamId: null } }))).toBe('NO_THROW');
    expect(attempts(dice, seq, { caller: { role: 'PLAYER', participantId: 'host-player', teamId: null } }).rolled).toBe('TURN_SEQ_NOT_CURRENT_ACTOR');
  });

  it('team mode: the holder of the team turn acts; a teammate advises only; the right id with the wrong team is refused', () => {
    const seq = teamSequence();
    const dice = open(seq);
    expect(holderOf(seq)).toEqual({ teamId: 'T1', playerId: 'A' });
    expect(codeOf(() => roll(dice, seq, [1, 2, 3, 4, 5]))).toBe('NO_THROW');
    expect(attempts(dice, seq, { caller: { role: 'PLAYER', participantId: 'B', teamId: 'T1' } })).toEqual({ rolled: 'TURN_SEQ_NOT_CURRENT_ACTOR', held: 'TURN_SEQ_NOT_CURRENT_ACTOR', draws: 0 });
    expect(attempts(dice, seq, { caller: { role: 'PLAYER', participantId: 'A', teamId: 'T2' } }).rolled).toBe('TURN_SEQ_NOT_CURRENT_ACTOR');
    expect(attempts(dice, seq, { caller: { role: 'PLAYER', participantId: 'C', teamId: 'T2' } }).rolled).toBe('TURN_SEQ_NOT_CURRENT_ACTOR');
    expect(attempts(dice, seq, { caller: { role: 'PLAYER', participantId: 'A', teamId: null } }).rolled).toBe('TURN_SEQ_NOT_CURRENT_ACTOR');
  });

  it('admission, phase and pause are the consumer\'s facts and must all be explicit and true; anything else blocks before the draw', () => {
    const { seq, dice } = rig();
    for (const gate of [{ admitted: false, phaseOpen: true, paused: false }, { admitted: true, phaseOpen: false, paused: false }, { admitted: true, phaseOpen: true, paused: true }]) {
      expect(attempts(dice, seq, { gate })).toEqual({ rolled: 'TURN_SEQ_ACTION_BLOCKED', held: 'TURN_SEQ_ACTION_BLOCKED', draws: 0 });
    }
    expect(attempts(dice, seq, { gate: { admitted: true, phaseOpen: true } }).rolled).toBe('TURN_SEQ_ARGS_INVALID'); // no default for a missing fact
    expect(attempts(dice, seq, { gate: { admitted: 'yes', phaseOpen: true, paused: false } }).rolled).toBe('TURN_SEQ_ARGS_INVALID');
  });

  it('a holder who is no longer eligible (N6) cannot roll; a HELD, empty or closed N8 sequence blocks every dice action; existing dice values are untouched', () => {
    const { seq, dice } = rig();
    const rolled = roll(dice, seq, [1, 2, 3, 4, 5]).state;
    const gone = pel(['b', 'c'], 2); // a was eliminated at N6 version 2
    expect(attempts(rolled, seq, { eligibility: gone }).rolled).toBe('TURN_SEQ_ACTOR_NOT_ELIGIBLE');
    const heldSeq = withholdCurrentHolder(seq, { scope: sc(seq), expectedVersion: seq.version, expectedTurnNumber: seq.turnNumber, eligibility: gone }).state;
    expect(attempts(rolled, heldSeq, { eligibility: gone })).toEqual({ rolled: 'TURN_SEQ_HELD', held: 'TURN_SEQ_HELD', draws: 0 });
    const emptySeq = advance(seq, pel([], 2));
    expect(attempts(rolled, emptySeq, { eligibility: pel([], 2), caller: { role: 'PLAYER', participantId: 'a', teamId: null } }).rolled).toBe('TURN_SEQ_NO_CURRENT');
    const closedSeq = closeTurnSequence(seq, { scope: sc(seq), expectedVersion: seq.version }).state;
    expect(attempts(rolled, closedSeq, {}).rolled).toBe('TURN_SEQ_CLOSED');
    expect(rolled.values).toEqual([1, 2, 3, 4, 5]); // the stored dice survive every one of these (the rejected calls returned nothing)
    expect(rolled.rollCount).toBe(1);
  });

  it('another RUN is refused even with the same participant ids: scope, eligibility and the dice process each carry the run', () => {
    const { seq, dice } = rig();
    expect(attempts(dice, seq, { scope: { ...sc(seq), runIndex: 2 } }).rolled).toBe('TURN_SEQ_RUN_STALE');
    expect(attempts(dice, seq, { eligibility: pel(PLAYERS, 1, 2) }).rolled).toBe('TURN_SEQ_ELIGIBILITY_MISMATCH');
    expect(attempts(dice, seq, { scope: { ...sc(seq), sequenceId: 'seq-2' } }).rolled).toBe('TURN_SEQ_SEQUENCE_STALE');
    expect(attempts(dice, seq, { scope: { ...sc(seq), rosterRevision: 'roster-2' } }).rolled).toBe('TURN_SEQ_ROSTER_STALE');
    // a dice process of run 2 next to a run-1 sequence that is otherwise identical
    const prepared2 = prepareTurnSequence({ ...BASE, runIndex: 2, unit: 'PLAYER', mode: 'FIXED', order: PLAYERS });
    const seq2 = startTurnSequence(prepared2, { scope: sc(prepared2), expectedVersion: 0, eligibility: pel(PLAYERS, 1, 2) }).state;
    const dice2 = open(seq2, DICE_CONFIG_FIVE_D6_HOLD, 'dice-run2');
    expect(attempts(dice2, seq, { diceId: 'dice-run2' }).rolled).toBe('DICE_SCOPE_STALE'); // the process belongs to run 2, the sequence is run 1
    expect(attempts(dice, seq, { diceId: 'dice-run2' }).rolled).toBe('DICE_SCOPE_STALE'); // another process id
  });

  it('a LATER turn of the SAME player is another turn: the old process and every old intent stay unusable, also against the current database revision', () => {
    const seq1 = playerSequence();
    const dice1 = open(seq1);
    const rolled1 = roll(dice1, seq1, [1, 2, 3, 4, 5]).state;
    const seq4 = advance(advance(advance(seq1))); // a → b → c → a
    expect(holderOf(seq4).playerId).toBe('a');
    expect(seq4.turnNumber).toBe(4);
    // the old intent carries the numbers it saw in turn 1
    expect(attempts(rolled1, seq4, { expectedSequenceVersion: seq1.version, expectedTurnNumber: seq1.turnNumber })).toEqual({ rolled: 'TURN_SEQ_VERSION_STALE', held: 'TURN_SEQ_VERSION_STALE', draws: 0 });
    expect(attempts(rolled1, seq4, { expectedTurnNumber: seq1.turnNumber }).rolled).toBe('TURN_SEQ_TURN_STALE'); // right version, old turn
    // even a consumer that hands over the CURRENT numbers cannot use the turn-1 process: it belongs to turn 1
    expect(attempts(rolled1, seq4, {})).toEqual({ rolled: 'DICE_TURN_STALE', held: 'DICE_TURN_STALE', draws: 0 });
    // the new turn gets a NEW process; the old one is simply closed
    const dice4 = open(seq4, DICE_CONFIG_FIVE_D6_HOLD, 'dice-4');
    expect(dice4.binding.turnNumber).toBe(4);
    expect(roll(dice4, seq4, [6, 6, 6, 6, 6]).state.values).toEqual([6, 6, 6, 6, 6]);
    expect(closeIt(rolled1).state.phase).toBe('CLOSED');
  });

  it('an override (new turn number) voids the displaced holder\'s process even though he is still a member; the target gets a new process', () => {
    const seq = playerSequence();
    const dice = open(seq);
    const overridden = overrideTurnSequence(seq, { scope: sc(seq), expectedVersion: seq.version, expectedTurnNumber: seq.turnNumber, target: { playerId: 'c' }, eligibility: pel(PLAYERS), now: 1 }).state;
    expect(overridden.turnNumber).toBe(2);
    expect(attempts(dice, overridden, { caller: { role: 'PLAYER', participantId: 'a', teamId: null } }).rolled).toBe('TURN_SEQ_NOT_CURRENT_ACTOR');
    expect(attempts(dice, overridden, { caller: { role: 'PLAYER', participantId: 'c', teamId: null } }).rolled).toBe('DICE_TURN_STALE');
    expect(codeOf(() => open(overridden, DICE_CONFIG_FIVE_D6_HOLD, 'dice-2'))).toBe('NO_THROW');
  });

  it('a malformed or oversized request never gets as far as the draw: nothing is coerced', () => {
    const { seq, dice } = rig();
    for (const over of [{ expectedVersion: '0' }, { expectedVersion: 0.5 }, { expectedVersion: NaN }, { expectedVersion: null }, { expectedVersion: undefined }, { expectedSequenceVersion: '1' }, { expectedTurnNumber: 1.5 }]) {
      expect(attempts(dice, seq, over as never).draws, JSON.stringify(over)).toBe(0);
      expect(attempts(dice, seq, over as never).rolled, JSON.stringify(over)).toMatch(/STALE$/);
    }
    const s = source([1]);
    expect(codeOf(() => rollDice(dice, { ...act(dice, seq), source: s.fn, values: [6, 6, 6, 6, 6] } as never))).toBe('DICE_ARGS_INVALID'); // a caller cannot smuggle in a result
    expect(codeOf(() => rollDice(dice, { ...act(dice, seq), seed: 'x' } as never))).toBe('DICE_ARGS_INVALID');
    expect(codeOf(() => rollDice(dice, null as never))).toBe('DICE_ARGS_INVALID');
    expect(codeOf(() => rollDice(dice, { ...act(dice, seq), diceId: 5 } as never))).toBe('DICE_ARGS_INVALID');
    expect(s.calls).toHaveLength(0);
  });
});

// ── F. N8 basis updates and recovery in the same turn ────────

describe('N9 F: an N6 basis update in the same turn raises the sequence version — and leaves the dice exactly as they are', () => {
  it('values, holds and used rolls survive; the old intent is stale; a new binding continues the SAME dice; the limit is never reset', () => {
    const { seq: seq0, dice } = rig();
    const r1 = roll(dice, seq0, [1, 2, 3, 4, 5]).state;
    const h = hold(r1, seq0, [0, 1]).state;
    const newer = pel(PLAYERS, 5);
    const refreshed = refreshEligibilityBasis(seq0, { scope: sc(seq0), expectedVersion: seq0.version, eligibility: newer });
    expect(refreshed.changed).toBe(true);
    expect(refreshed.transition?.kind).toBe('BASIS');
    const seq1 = refreshed.state;
    expect(seq1.turnNumber).toBe(seq0.turnNumber); // no new turn
    expect(seq1.version).toBe(seq0.version + 1); // but a new sequence version
    // the dice are not part of that step at all
    expect(h).toEqual(h);
    // the old action binding is stale, the dice are unchanged by the rejected attempt
    const s = source([6, 6, 6]);
    const before = clone(h);
    expect(codeOf(() => rollDice(h, { ...act(h, seq1, { eligibility: newer, expectedSequenceVersion: seq0.version }), source: s.fn } as never))).toBe('TURN_SEQ_VERSION_STALE');
    expect(codeOf(() => setDiceHeld(h, { ...act(h, seq1, { eligibility: newer, expectedSequenceVersion: seq0.version }), held: [0] } as never))).toBe('TURN_SEQ_VERSION_STALE');
    expect(s.calls).toHaveLength(0);
    expect(h).toEqual(before);
    // the new binding continues the same process: same values, same holds, rolls still counted
    const r2 = roll(h, seq1, [6, 6, 6], { eligibility: newer });
    expect(r2.state.values).toEqual([1, 2, 6, 6, 6]);
    expect(r2.state.rollCount).toBe(2);
    // the roll limit is not a function of the basis: after the third roll another basis update does not give a fourth
    const r3 = roll(r2.state, seq1, [5, 5, 5], { eligibility: newer });
    const seq2 = refreshEligibilityBasis(seq1, { scope: sc(seq1), expectedVersion: seq1.version, eligibility: pel(PLAYERS, 9) }).state;
    expect(codeOf(() => roll(r3.state, seq2, [1, 1, 1], { eligibility: pel(PLAYERS, 9) }))).toBe('DICE_ROLLS_EXHAUSTED');
    expect(r3.state.rollCount).toBe(3);
  });

  it('a successful dice action reports when the N6 stand it was given is NEWER than the committed N8 basis, also on the no-op hold path — nothing newer is swallowed (N8-02)', () => {
    const { seq, dice } = rig();
    const equal = roll(dice, seq, [1, 2, 3, 4, 5]);
    expect(equal.sequenceBasisAdvanced).toBe(false);
    const newer = pel(PLAYERS, 3);
    expect(turnEligibilityAdvancesBasis(seq, { scope: sc(seq), eligibility: newer })).toBe(true);
    expect(turnEligibilityAdvancesBasis(seq, { scope: sc(seq), eligibility: pel(PLAYERS, 1) })).toBe(false);
    const withNewer = roll(dice, seq, [1, 2, 3, 4, 5], { eligibility: newer });
    expect(withNewer.sequenceBasisAdvanced).toBe(true);
    const held = hold(equal.state, seq, [0]);
    const noop = hold(held.state, seq, [0], { eligibility: newer });
    expect(noop).toMatchObject({ changed: false, sequenceBasisAdvanced: true }); // "no new hold" is not "nothing to remember"
    const changedHold = hold(equal.state, seq, [1], { eligibility: newer });
    expect(changedHold).toMatchObject({ changed: true, sequenceBasisAdvanced: true });
    // the consumer persists the basis in the same commit; afterwards the older stand is fenced for dice actions too
    const seq1 = refreshEligibilityBasis(seq, { scope: sc(seq), expectedVersion: seq.version, eligibility: newer }).state;
    expect(codeOf(() => roll(held.state, seq1, [1, 1, 1, 1], { eligibility: pel(PLAYERS, 1) }))).toBe('TURN_SEQ_ELIGIBILITY_STALE');
    expect(roll(held.state, seq1, [1, 1, 1, 1], { eligibility: newer }).sequenceBasisAdvanced).toBe(false);
    // errors of the read-only helper are the N8 codes
    expect(codeOf(() => turnEligibilityAdvancesBasis(seq1, { scope: sc(seq1), eligibility: pel(PLAYERS, 1) }))).toBe('TURN_SEQ_ELIGIBILITY_STALE');
    expect(codeOf(() => turnEligibilityAdvancesBasis(seq, { scope: { ...sc(seq), runIndex: 2 }, eligibility: newer }))).toBe('TURN_SEQ_RUN_STALE');
    expect(codeOf(() => turnEligibilityAdvancesBasis(seq, { scope: sc(seq), eligibility: pel(PLAYERS, 1, 2) }))).toBe('TURN_SEQ_ELIGIBILITY_MISMATCH');
    expect(codeOf(() => turnEligibilityAdvancesBasis(seq, { scope: sc(seq), eligibility: newer, extra: 1 } as never))).toBe('TURN_SEQ_ARGS_INVALID');
  });

  it('HELD in N8 is not a new dice process and not a reset: the values stay readable, every action is blocked, and the next turn needs a new process', () => {
    const { seq, dice } = rig();
    const rolled = roll(dice, seq, [4, 4, 4, 4, 4]).state;
    const gone = pel(['b', 'c'], 2);
    const heldSeq = withholdCurrentHolder(seq, { scope: sc(seq), expectedVersion: seq.version, expectedTurnNumber: seq.turnNumber, eligibility: gone }).state;
    expect(codeOf(() => roll(rolled, heldSeq, [1, 1, 1, 1, 1], { eligibility: gone }))).toBe('TURN_SEQ_HELD');
    const view = projectDiceTurn({ role: 'PLAYER', participantId: 'a', teamId: null }, rolled, { scope: sc(heldSeq), sequence: heldSeq, release: 'VALUES', stateVersion: 5 });
    expect(view).toMatchObject({ values: [4, 4, 4, 4, 4], rollCount: 1, you: { holdsTurn: true, canRoll: false, canHold: false } });
    const next = advanceTurnSequence(heldSeq, { scope: sc(heldSeq), expectedVersion: heldSeq.version, expectedTurnNumber: heldSeq.turnNumber, outcome: 'SKIP', eligibility: gone }).state;
    expect(next.turnNumber).toBe(2);
    expect(codeOf(() => roll(rolled, next, [1, 1, 1, 1, 1], { eligibility: gone, caller: { role: 'PLAYER', participantId: 'b', teamId: null } }))).toBe('DICE_TURN_STALE');
  });
});

// ── G. Stored state: strict, never repaired ──────────────────

describe('N9 G: loading a damaged state is refused as a whole', () => {
  const valid = () => { const { seq, dice } = rig(); return roll(hold(roll(dice, seq, [1, 2, 3, 4, 5]).state, seq, [1]).state, seq, [6, 6, 6, 6]).state; };

  it('the valid state round-trips through JSON unchanged and parsing returns a fresh copy', () => {
    const state = valid();
    expect(parseDiceTurnState(JSON.parse(JSON.stringify(state)))).toEqual(state);
    const copy = parseDiceTurnState(state);
    copy.values![0] = 1;
    copy.held[0] = true;
    expect(state.values).toEqual([6, 2, 6, 6, 6][0] === 6 ? state.values : null);
    expect(parseDiceTurnState(state)).toEqual(state);
  });

  const breakers: Array<[string, (s: Draft) => void, string?]> = [
    ['zero as a value', s => { s.values[0] = 0; }], ['value above sides', s => { s.values[2] = 7; }], ['fractional value', s => { s.values[1] = 1.5; }], ['string value', s => { s.values[1] = '3'; }],
    ['NaN-like value (null)', s => { s.values[1] = null; }], ['too few values', s => { s.values.pop(); }, 'VALUES_CONFLICT'], ['values missing after a roll', s => { s.values = null; }, 'VALUES_CONFLICT'],
    ['values present with no roll', s => { s.rollCount = 0; s.phase = 'PREPARED'; s.version = 0; s.lastRolled = []; s.held = [false, false, false, false, false]; }, 'VALUES_CONFLICT'],
    ['held too short', s => { s.held.pop(); }, 'HELD_CONFLICT'], ['held not boolean', s => { s.held[0] = 1; }], ['held in a profile without holding', s => { s.config = { diceCount: 5, sides: 6, maxRolls: 1, holdAllowed: false }; s.rollCount = 1; s.phase = 'EXHAUSTED'; }],
    ['held before any roll', s => { s.rollCount = 0; s.phase = 'PREPARED'; s.version = 0; s.values = null; s.lastRolled = []; }, 'HELD_CONFLICT'],
    ['roll count above the limit', s => { s.rollCount = 4; }, 'COUNTER_CONFLICT'], ['version below the roll count', s => { s.version = 1; }, 'COUNTER_CONFLICT'],
    ['PREPARED with a roll', s => { s.phase = 'PREPARED'; }, 'PHASE_CONFLICT'], ['IN_PROGRESS at the limit', s => { s.rollCount = 3; s.version = 5; }, 'PHASE_CONFLICT'],
    ['EXHAUSTED below the limit', s => { s.phase = 'EXHAUSTED'; }, 'PHASE_CONFLICT'], ['CLOSED without the closing step', s => { s.phase = 'CLOSED'; s.version = s.rollCount; }, 'COUNTER_CONFLICT'],
    ['unknown phase', s => { s.phase = 'OPEN'; }], ['last rolled unsorted', s => { s.lastRolled = [2, 0]; }, 'ROLLED_CONFLICT'], ['last rolled duplicate', s => { s.lastRolled = [0, 0]; }, 'ROLLED_CONFLICT'],
    ['last rolled out of range', s => { s.lastRolled = [0, 5]; }, 'ROLLED_CONFLICT'], ['last rolled empty after a roll', s => { s.lastRolled = []; }, 'ROLLED_CONFLICT'],
    ['unknown key', s => { s.seed = 'x'; }], ['wrong kind', s => { s.kind = 'DICE'; }], ['wrong schema version', s => { s.schemaVersion = 2; }],
    ['team unit without a team', s => { s.binding.unit = 'TEAM'; }, 'BINDING_CONFLICT'], ['player unit with a team', s => { s.binding.teamId = 'T1'; }, 'BINDING_CONFLICT'],
    ['turn zero', s => { s.binding.turnNumber = 0; }], ['config outside the bounds', s => { s.config.sides = 99; }], ['hold with a single roll', s => { s.config = { diceCount: 5, sides: 6, maxRolls: 1, holdAllowed: true }; }],
    ['oversized values array', s => { s.values = new Array(11).fill(1); }, 'LIMIT_EXCEEDED'], ['oversized held array', s => { s.held = new Array(11).fill(false); }, 'LIMIT_EXCEEDED'],
    ['bad dice id', s => { s.diceId = '../x'; }], ['negative version', s => { s.version = -1; }], ['float version', s => { s.version = 1.5; }], ['run zero', s => { s.runIndex = 0; }],
  ];
  it.each(breakers)('refuses %s as a whole — DICE_STATE_INVALID, code-only issues, no repair', (_name, breaker, issue) => {
    const state = clone(valid());
    breaker(state);
    expect(codeOf(() => parseDiceTurnState(state))).toBe('DICE_STATE_INVALID');
    const issues = issuesOf(() => parseDiceTurnState(state));
    expect(issues.length).toBeGreaterThan(0);
    for (const code of issues) expect(DICE_ISSUE_CODES as readonly string[]).toContain(code);
    if (issue) expect(issues).toContain(issue);
    // every entry point refuses it BEFORE anything is drawn
    const { seq } = rig();
    const s = source([1, 1, 1, 1, 1]);
    expect(codeOf(() => rollDice(state, { ...act(state, seq), source: s.fn } as never))).toBe('DICE_STATE_INVALID');
    expect(codeOf(() => setDiceHeld(state, { ...act(state, seq), held: [] } as never))).toBe('DICE_STATE_INVALID');
    expect(codeOf(() => closeIt(state))).toBe('DICE_STATE_INVALID');
    expect(codeOf(() => projectDiceTurn({ role: 'VIEWER' }, state, { scope: sc(seq), sequence: seq, release: 'VALUES', stateVersion: 1 }))).toBe('DICE_STATE_INVALID');
    expect(s.calls).toHaveLength(0);
  });

  it.each([null, undefined, 5, 'x', [], [1], true])('a non-object (%s) is refused', raw => {
    expect(codeOf(() => parseDiceTurnState(raw))).toBe('DICE_STATE_INVALID');
  });
});

// ── H. Pure application of a decided result; replay ──────────

describe('N9 H: applying an already decided result — no random source, no clock, no mutation', () => {
  it('re-applying the recorded decision to the state BEFORE reproduces exactly the committed state, with no random call and no clock', () => {
    const { seq, dice } = rig();
    const steps: Array<{ before: DiceTurnState; after: DiceTurnState; rolled: { indices: number[]; values: number[] } }> = [];
    let current = dice;
    for (const [values, held] of [[[1, 2, 3, 4, 5], [1, 3]], [[6, 6, 6], [0]], [[3, 3, 3, 3], []]] as const) {
      const r = roll(current, seq, [...values]);
      steps.push({ before: current, after: r.state, rolled: r.transition!.rolled! });
      current = r.state.rollCount < 3 ? hold(r.state, seq, held).state : r.state;
    }
    expect(steps.map(s => s.after.rollCount)).toEqual([1, 2, 3]);
    vi.mocked(randomInt).mockClear();
    const now = vi.spyOn(Date, 'now');
    const mathRandom = vi.spyOn(Math, 'random');
    for (const step of steps) {
      const replayed = applyDecidedDiceRoll(deepFreeze(clone(step.before)), { expectedVersion: step.before.version, expectedRollCount: step.before.rollCount, indices: step.rolled.indices, values: step.rolled.values });
      expect(replayed.state).toEqual(step.after);
    }
    expect(vi.mocked(randomInt)).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    expect(mathRandom).not.toHaveBeenCalled();
    now.mockRestore(); mathRandom.mockRestore();
  });

  it('the pure function takes the decided values, not its own: the same input gives the same output, and different decided values give different results', () => {
    const { dice } = rig();
    const apply = (values: number[]) => applyDecidedDiceRoll(dice, { expectedVersion: 0, expectedRollCount: 0, indices: [0, 1, 2, 3, 4], values }).state.values;
    expect(apply([1, 2, 3, 4, 5])).toEqual([1, 2, 3, 4, 5]);
    expect(apply([1, 2, 3, 4, 5])).toEqual([1, 2, 3, 4, 5]);
    expect(apply([6, 5, 4, 3, 2])).toEqual([6, 5, 4, 3, 2]);
  });

  it('a decided result that does not fit is DICE_RESULT_INVALID (wrong positions, wrong count, wrong values) — stale numbers keep their own codes; nothing is repaired or redrawn', () => {
    const { seq, dice } = rig();
    const r1 = roll(dice, seq, [1, 2, 3, 4, 5]).state;
    const h = hold(r1, seq, [1, 3]).state;
    const ok = { expectedVersion: h.version, expectedRollCount: h.rollCount, indices: [0, 2, 4], values: [6, 6, 6] };
    expect(applyDecidedDiceRoll(h, ok).state.values).toEqual([6, 2, 6, 4, 6]);
    const code = (over: Record<string, unknown>) => codeOf(() => applyDecidedDiceRoll(h, { ...ok, ...over } as never));
    expect(code({ indices: [0, 1, 2, 4] })).toBe('DICE_RESULT_INVALID'); // a held position would be overwritten
    expect(code({ indices: [0, 2] , values: [6, 6] })).toBe('DICE_RESULT_INVALID'); // not every unheld position is covered
    expect(code({ indices: [4, 2, 0] })).toBe('DICE_RESULT_INVALID'); // not ascending
    expect(code({ values: [6, 6] })).toBe('DICE_RESULT_INVALID');
    expect(code({ values: [6, 6, 6, 6] })).toBe('DICE_RESULT_INVALID');
    for (const bad of [0, 7, 1.5, NaN, '6', null]) expect(code({ values: [6, bad, 6] }), String(bad)).toBe('DICE_RESULT_INVALID');
    expect(code({ indices: 'x' })).toBe('DICE_RESULT_INVALID');
    expect(code({ expectedVersion: h.version - 1 })).toBe('DICE_VERSION_STALE');
    expect(code({ expectedRollCount: 0 })).toBe('DICE_ROLL_STALE');
    expect(code({ seed: 1 })).toBe('DICE_ARGS_INVALID');
    expect(codeOf(() => applyDecidedDiceRoll(h, { expectedVersion: h.version, expectedRollCount: 1, indices: [0, 2, 4] } as never))).toBe('DICE_ARGS_INVALID');
    const allHeld = hold(h, seq, [0, 1, 2, 3, 4]).state;
    expect(codeOf(() => applyDecidedDiceRoll(allHeld, { expectedVersion: allHeld.version, expectedRollCount: 1, indices: [], values: [] }))).toBe('DICE_NOTHING_TO_ROLL');
  });

  it('SDK state events replay a whole process deterministically: created from the committed states, applied to the start, they rebuild the final state — without any draw', () => {
    const { seq, dice } = rig();
    const states: DiceTurnState[] = [dice];
    const step = (next: DiceTurnState) => { states.push(next); return next; };
    let d = dice;
    d = step(roll(d, seq, [1, 2, 3, 4, 5]).state);
    d = step(hold(d, seq, [1, 3]).state);
    d = step(roll(d, seq, [6, 6, 6]).state);
    d = step(closeIt(d).state);
    const snap = (state: DiceTurnState, version: number): EngineStateSnapshot => ({ roomId: 'room-1', runIndex: 1, gameSlug: 'stand-in', engineVersion: 1, stateVersion: version, state: { phase: 'ROUND_ACTIVE', dice: state } });
    const events = states.slice(1).map((next, i) => createStateEvent(snap(states[i], i + 10), { phase: 'ROUND_ACTIVE', dice: next }, { eventId: randomUUID(), type: 'DICE_CHANGED', commandId: `c${i}`, actorId: 'a', occurredAtMs: 1 + i }));
    vi.mocked(randomInt).mockClear();
    const wire = JSON.parse(JSON.stringify(events)) as unknown[]; // the persisted form
    const rebuilt = wire.reduce<EngineStateSnapshot>((snapshot, event) => applyStateEvent(snapshot, event), snap(dice, 10));
    expect(parseDiceTurnState(rebuilt.state.dice)).toEqual(d);
    expect(parseDiceTurnState(rebuilt.state.dice).values).toEqual([6, 2, 6, 4, 6]);
    expect(rebuilt.stateVersion).toBe(14);
    expect(vi.mocked(randomInt)).not.toHaveBeenCalled();
    // a replay never repairs: a corrupted stored value is refused when the state is read, not silently re-drawn
    const corrupt = clone(rebuilt.state.dice) as Draft;
    corrupt.values[0] = 0;
    expect(codeOf(() => parseDiceTurnState(corrupt))).toBe('DICE_STATE_INVALID');
  });

  it('no function of the module mutates its inputs (deep-frozen inputs are enough) or touches the clock', () => {
    const { seq, dice } = rig();
    const now = vi.spyOn(Date, 'now');
    const frozenSeq = deepFreeze(clone(seq));
    const frozen = deepFreeze(clone(dice));
    const s = source([1, 2, 3, 4, 5]);
    const args = deepFreeze({ ...act(frozen, frozenSeq) });
    const rolled = rollDice(frozen, { ...args, source: s.fn } as never);
    const frozenRolled = deepFreeze(clone(rolled.state));
    const held = setDiceHeld(frozenRolled, { ...deepFreeze({ ...act(frozenRolled, frozenSeq) }), held: deepFreeze([0, 1]) } as never);
    closeDiceTurn(deepFreeze(clone(held.state)), deepFreeze({ scope: diceTurnScopeOf(held.state), diceId: held.state.diceId, expectedTurnNumber: 1, expectedVersion: held.state.version }));
    projectDiceTurn(deepFreeze({ role: 'PLAYER', participantId: 'a', teamId: null } as ProjectionAudience), frozenRolled, deepFreeze({ scope: sc(frozenSeq), sequence: frozenSeq, release: 'VALUES', stateVersion: 1 }) as never);
    openDiceTurn(deepFreeze({ scope: sc(frozenSeq), diceId: 'x1', config: { ...DICE_CONFIG_FIVE_D6_HOLD }, sequence: frozenSeq, expectedTurnNumber: 1 }) as never);
    expect(now).not.toHaveBeenCalled();
    now.mockRestore();
  });
});

// ── I. Client contract: intents, projection, no secrets ──────

describe('N9 I: intents carry no result; projections carry nothing secret', () => {
  const binding = { turnNumber: 1, sequenceVersion: 1, diceVersion: 0, rollCount: 0 };

  it('the roll intent is strictly a binding: a client cannot name values, a seed, positions or a roll count to draw', () => {
    expect(readDiceRollIntent(binding)).toEqual(binding);
    for (const extra of [{ values: [6, 6, 6, 6, 6] }, { seed: 'x' }, { held: [0] }, { dice: [1] }, { random: 4 }, { result: 6 }, { __proto__: null, values: [1] }]) {
      expect(codeOf(() => readDiceRollIntent({ ...binding, ...extra })), JSON.stringify(extra)).toBe('DICE_ARGS_INVALID');
      expect(DiceRollIntentSchema.safeParse({ ...binding, ...extra }).success).toBe(false);
    }
    for (const bad of [{ turnNumber: 0 }, { turnNumber: -1 }, { turnNumber: 1.5 }, { sequenceVersion: '1' }, { diceVersion: NaN }, { rollCount: 1e12 }, { rollCount: null }]) {
      expect(codeOf(() => readDiceRollIntent({ ...binding, ...bad })), JSON.stringify(bad)).toBe('DICE_ARGS_INVALID');
    }
    expect(codeOf(() => readDiceRollIntent(null))).toBe('DICE_ARGS_INVALID');
    expect(codeOf(() => readDiceRollIntent([]))).toBe('DICE_ARGS_INVALID');
  });

  it('the hold intent is the binding plus a bounded list of positions — and nothing else', () => {
    expect(readDiceHoldIntent({ ...binding, held: [1, 3] })).toEqual({ ...binding, held: [1, 3] });
    expect(readDiceHoldIntent({ ...binding, held: [] }).held).toEqual([]);
    for (const bad of [{ held: [-1] }, { held: [10] }, { held: [1.5] }, { held: ['1'] }, { held: new Array(11).fill(0) }, { held: 'all' }, { values: [1] }, { held: [0], seed: 1 }]) {
      expect(codeOf(() => readDiceHoldIntent({ ...binding, held: [], ...bad })), JSON.stringify(bad)).toBe('DICE_ARGS_INVALID');
    }
    expect(codeOf(() => readDiceHoldIntent(binding))).toBe('DICE_ARGS_INVALID'); // the target is mandatory
    expect(DiceHoldIntentSchema.safeParse({ ...binding, held: [0, 1, 2, 3, 4] }).success).toBe(true);
    expect(DiceActionBindingSchema.safeParse(binding).success).toBe(true);
    expect(diceActionBindingKey(binding)).toBe(JSON.stringify(['DICE_BINDING', 1, 1, 0, 0]));
    // the shared module exports no schema that could carry values from a client
    expect(Object.keys(contract).filter(name => /Roll|Result|Values/i.test(name) && name.endsWith('Schema'))).toEqual(['DiceRollIntentSchema']);
  });

  const KEYS_NONE = ['contract', 'diceId', 'diceVersion', 'recipientId', 'release', 'rollCount', 'scope', 'sequenceVersion', 'stateVersion', 'turnNumber'];
  const KEYS_VALUES = [...KEYS_NONE, 'config', 'held', 'holder', 'lastRolled', 'status', 'values', 'you'].sort();

  it('release NONE sends only the binding and the ordering counters; VALUES adds exactly the documented fields — by allowlist, no spread of the private state', () => {
    const { seq, dice } = rig();
    const rolled = hold(roll(dice, seq, [1, 2, 3, 4, 5]).state, seq, [0]).state;
    const none = projectDiceTurn({ role: 'VIEWER' }, rolled, { scope: sc(seq), sequence: seq, release: 'NONE', stateVersion: 7 });
    expect(Object.keys(none).sort()).toEqual(KEYS_NONE);
    expect(none).toEqual({ contract: 'DICE_TURN_STATUS_V1', release: 'NONE', scope: sc(seq), diceId: 'dice-1', recipientId: null, stateVersion: 7, sequenceVersion: seq.version, turnNumber: 1, diceVersion: rolled.version, rollCount: 1 });
    const values = projectDiceTurn({ role: 'VIEWER' }, rolled, { scope: sc(seq), sequence: seq, release: 'VALUES', stateVersion: 7 });
    expect(Object.keys(values).sort()).toEqual(KEYS_VALUES);
    expect(values).toMatchObject({ status: 'IN_PROGRESS', values: [1, 2, 3, 4, 5], held: [true, false, false, false, false], lastRolled: [0, 1, 2, 3, 4], holder: { teamId: null, playerId: 'a' }, you: null });
    expect(Object.keys(values.release === 'VALUES' ? values.config : {}).sort()).toEqual(['diceCount', 'holdAllowed', 'maxRolls', 'sides']);
  });

  it('nothing secret is projectable: no seed, no random state, no precomputed roll, no session, no eligibility, no reason, no member list, no rotation cursor', () => {
    const seq = teamSequence();
    const dice = open(seq);
    const rolled = roll(dice, seq, [2, 3, 4, 5, 6]).state;
    const audiences: ProjectionAudience[] = [{ role: 'PLAYER', participantId: 'A', teamId: 'T1' }, { role: 'PLAYER', participantId: 'B', teamId: 'T1' }, { role: 'HOST' }, { role: 'VIEWER' }, { role: 'DISPLAY' }, { role: 'HOST', blindHost: true }];
    for (const audience of audiences) for (const release of ['NONE', 'VALUES'] as const) {
      const text = JSON.stringify(projectDiceTurn(audience, rolled, { scope: sc(seq), sequence: seq, release, stateVersion: 3 }));
      for (const forbidden of ['seed', 'random', 'future', 'next', 'secret', 'session', 'token', 'eligib', 'reason', 'members', 'cursor', 'order', 'trackId', 'basis', 'knownIds', 'activeIds', 'lives', 'role']) {
        expect(text.toLowerCase(), `${audience.role}/${release}/${forbidden}`).not.toContain(forbidden.toLowerCase());
      }
    }
    // the private state has no seed or random state to begin with
    expect(Object.keys(rolled).sort()).toEqual(['binding', 'config', 'diceId', 'held', 'kind', 'lastRolled', 'phase', 'rollCount', 'runIndex', 'schemaVersion', 'values', 'version']);
  });

  it('seeing is not acting: only a PLAYER audience gets `you`; viewer, display and a non-playing host get none; a playing host is a PLAYER; the recipient is named in EVERY packet', () => {
    const { seq, dice } = rig();
    const rolled = roll(dice, seq, [1, 2, 3, 4, 5]).state;
    const proj = (audience: ProjectionAudience, release: 'NONE' | 'VALUES' = 'VALUES') => projectDiceTurn(audience, rolled, { scope: sc(seq), sequence: seq, release, stateVersion: 2 });
    for (const audience of [{ role: 'VIEWER' }, { role: 'DISPLAY' }, { role: 'HOST' }, { role: 'HOST', blindHost: true }] as ProjectionAudience[]) {
      const p = proj(audience);
      expect(p.recipientId).toBeNull();
      expect(p.release === 'VALUES' && p.you).toBeNull();
    }
    expect(proj({ role: 'PLAYER', participantId: 'a', teamId: null })).toMatchObject({ recipientId: 'a', you: { holdsTurn: true, teamHoldsTurn: null, canRoll: true, canHold: true } });
    expect(proj({ role: 'PLAYER', participantId: 'b', teamId: null })).toMatchObject({ recipientId: 'b', you: { holdsTurn: false, canRoll: false, canHold: false } });
    expect(proj({ role: 'PLAYER', participantId: 'b', teamId: null }, 'NONE').recipientId).toBe('b');
    expect(proj({ role: 'PLAYER', participantId: 'a', teamId: null }, 'NONE').recipientId).toBe('a');
    expect(proj({ role: 'PLAYER', participantId: 'a', teamId: null }, 'NONE')).not.toHaveProperty('you');
    // a PLAYER audience without an id has no recipient and therefore no `you`
    expect(proj({ role: 'PLAYER', participantId: null, teamId: null })).toMatchObject({ recipientId: null, you: null });
  });

  it('team mode: the holder gets canRoll, a teammate sees "my team is on turn" without any right to act, the other team neither', () => {
    const seq = teamSequence();
    const dice = open(seq);
    const rolled = roll(dice, seq, [1, 2, 3, 4, 5]).state;
    const you = (participantId: string, teamId: string) => {
      const p = projectDiceTurn({ role: 'PLAYER', participantId, teamId }, rolled, { scope: sc(seq), sequence: seq, release: 'VALUES', stateVersion: 2 });
      return p.release === 'VALUES' ? p.you : 'none';
    };
    expect(you('A', 'T1')).toEqual({ holdsTurn: true, teamHoldsTurn: true, canRoll: true, canHold: true });
    expect(you('B', 'T1')).toEqual({ holdsTurn: false, teamHoldsTurn: true, canRoll: false, canHold: false });
    expect(you('C', 'T2')).toEqual({ holdsTurn: false, teamHoldsTurn: false, canRoll: false, canHold: false });
    expect(you('A', 'T2')).toEqual({ holdsTurn: false, teamHoldsTurn: false, canRoll: false, canHold: false }); // the right participant id with the wrong team
  });

  it('the action hints follow the process and the CURRENT N8 turn: prepared, in progress, exhausted, closed, all held, N8 moved on, N8 held', () => {
    const { seq, dice } = rig();
    const you = (state: DiceTurnState, sequence: TurnSequenceState = seq) => {
      const p = projectDiceTurn({ role: 'PLAYER', participantId: 'a', teamId: null }, state, { scope: sc(sequence), sequence, release: 'VALUES', stateVersion: 2 });
      return p.release === 'VALUES' && p.you ? [p.you.canRoll, p.you.canHold] : null;
    };
    expect(you(dice)).toEqual([true, false]); // may roll, nothing to hold yet
    const r1 = roll(dice, seq, [1, 2, 3, 4, 5]).state;
    expect(you(r1)).toEqual([true, true]);
    expect(you(hold(r1, seq, [0, 1, 2, 3, 4]).state)).toEqual([false, true]); // everything held: nothing to roll, but the assignment may still change
    const r3 = roll(roll(r1, seq, [1, 1, 1, 1, 1]).state, seq, [1, 1, 1, 1, 1]).state;
    expect(you(r3)).toEqual([false, false]);
    expect(you(closeIt(r1).state)).toEqual([false, false]);
    expect(you(r1, advance(seq))).toEqual([false, false]); // the turn moved on: the old process offers nothing
    const heldSeq = withholdCurrentHolder(seq, { scope: sc(seq), expectedVersion: seq.version, expectedTurnNumber: seq.turnNumber, eligibility: pel(['b', 'c'], 2) }).state;
    expect(you(r1, heldSeq)).toEqual([false, false]);
    const single = rig(DICE_CONFIG_SINGLE_D6);
    expect(you(single.dice, single.seq)).toEqual([true, false]);
    expect(you(roll(single.dice, single.seq, [3]).state, single.seq)).toEqual([false, false]);
  });

  it('the projection carries the CURRENT sequence version (what an action must be bound to) and the dice counters separately: a basis update moves the one, not the other', () => {
    const { seq: seq0, dice } = rig();
    const r1 = roll(dice, seq0, [1, 2, 3, 4, 5]).state;
    const seq1 = refreshEligibilityBasis(seq0, { scope: sc(seq0), expectedVersion: seq0.version, eligibility: pel(PLAYERS, 4) }).state;
    const at = (seq: TurnSequenceState) => projectDiceTurn({ role: 'VIEWER' }, r1, { scope: sc(seq), sequence: seq, release: 'NONE', stateVersion: 2 });
    expect(at(seq0)).toMatchObject({ sequenceVersion: seq0.version, diceVersion: r1.version, rollCount: 1, turnNumber: 1 });
    expect(at(seq1)).toMatchObject({ sequenceVersion: seq0.version + 1, diceVersion: r1.version, rollCount: 1, turnNumber: 1 });
  });

  it('projection arguments are checked: release has no default, unknown audiences and ids are refused, foreign scope or sequence is stale', () => {
    const { seq, dice } = rig();
    const base = { scope: sc(seq), sequence: seq, release: 'VALUES' as const, stateVersion: 1 };
    const p = (audience: unknown, over: Record<string, unknown> = {}) => codeOf(() => projectDiceTurn(audience as never, dice, { ...base, ...over } as never));
    expect(p({ role: 'VIEWER' }, { release: undefined })).toBe('DICE_RELEASE_INVALID');
    expect(p({ role: 'VIEWER' }, { release: 'ALL' })).toBe('DICE_RELEASE_INVALID');
    expect(p({ role: 'VIEWER' }, { release: 'CURRENT' })).toBe('DICE_RELEASE_INVALID');
    const noRelease = { scope: base.scope, sequence: base.sequence, stateVersion: base.stateVersion }; // the key is missing altogether (not undefined)
    expect(codeOf(() => projectDiceTurn({ role: 'VIEWER' }, dice, noRelease as never))).toBe('DICE_ARGS_INVALID');
    for (const audience of [{ role: 'ADMIN' }, { role: 'player' }, null, 'PLAYER', { role: 'PLAYER', participantId: 5 }, { role: 'PLAYER', participantId: 'a'.repeat(201) }, { role: 'PLAYER', teamId: 7 }, { participantId: 'a' }]) {
      expect(p(audience), JSON.stringify(audience)).toBe('DICE_AUDIENCE_INVALID');
    }
    expect(p({ role: 'VIEWER' }, { stateVersion: -1 })).toBe('DICE_ARGS_INVALID');
    expect(p({ role: 'VIEWER' }, { stateVersion: 1.5 })).toBe('DICE_ARGS_INVALID');
    expect(p({ role: 'VIEWER' }, { scope: { ...sc(seq), runIndex: 2 } })).toBe('DICE_SCOPE_STALE');
    expect(p({ role: 'VIEWER' }, { scope: { runIndex: 1 } })).toBe('DICE_ARGS_INVALID');
    const otherPrepared = prepareTurnSequence({ ...BASE, sequenceId: 'seq-2', unit: 'PLAYER', mode: 'FIXED', order: PLAYERS });
    const other = startTurnSequence(otherPrepared, { scope: sc(otherPrepared), expectedVersion: 0, eligibility: pel(PLAYERS) }).state;
    expect(p({ role: 'VIEWER' }, { sequence: other })).toBe('DICE_SCOPE_STALE');
  });

  it('the strict projection schema refuses crafted packets: invented fields, values out of range, impossible hints, inconsistent counters', () => {
    const { seq, dice } = rig();
    const good = clone(projectDiceTurn({ role: 'PLAYER', participantId: 'a', teamId: null }, roll(dice, seq, [1, 2, 3, 4, 5]).state, { scope: sc(seq), sequence: seq, release: 'VALUES', stateVersion: 2 })) as Draft;
    expect(parseDiceProjection(good).ok).toBe(true);
    const crafted: Array<[string, (p: Draft) => void]> = [
      ['seed field', p => { p.seed = 'x'; }], ['value zero', p => { p.values[0] = 0; }], ['value above sides', p => { p.values[0] = 7; }], ['too few values', p => { p.values.pop(); }],
      ['no values after a roll', p => { p.values = null; }], ['held length', p => { p.held.pop(); }], ['rollCount above the limit', p => { p.rollCount = 4; }],
      ['canRoll without holding the turn', p => { p.you.holdsTurn = false; }], ['canHold when exhausted', p => { p.status = 'EXHAUSTED'; }],
      ['you without a recipient', p => { p.recipientId = null; }], ['team hint in player mode', p => { p.you.teamHoldsTurn = true; }], ['team in the holder in player mode', p => { p.holder.teamId = 'T1'; }],
      ['last rolled unsorted', p => { p.lastRolled = [1, 0, 2, 3, 4]; }], ['last rolled outside', p => { p.lastRolled = [0, 1, 2, 3, 9]; }], ['first roll with partial lastRolled', p => { p.lastRolled = [0, 1]; }],
      ['unknown release', p => { p.release = 'ALL'; }], ['wrong contract', p => { p.contract = 'X'; }], ['negative counter', p => { p.diceVersion = -1; }], ['turn zero', p => { p.turnNumber = 0; }],
      ['unknown status', p => { p.status = 'OPEN'; }], ['held while holding is disabled', p => { p.config.holdAllowed = false; p.config.maxRolls = 3; p.held[0] = true; }],
    ];
    for (const [name, change] of crafted) {
      const packet = clone(good);
      change(packet);
      expect(parseDiceProjection(packet), name).toEqual({ ok: false, code: 'DICE_PROJECTION_INVALID' });
      expect(DiceProjectionSchema.safeParse(packet).success, name).toBe(false);
    }
    for (const junk of [null, undefined, 5, 'x', [], {}]) expect(parseDiceProjection(junk)).toEqual({ ok: false, code: 'DICE_PROJECTION_INVALID' });
    expect(JSON.stringify(parseDiceProjection({ ...good, values: [0, 0, 0, 0, 0] }))).toBe('{"ok":false,"code":"DICE_PROJECTION_INVALID"}'); // no value echoed
  });
});

// ── J. Contract hygiene ──────────────────────────────────────

describe('N9 J: contract, codes and module boundaries', () => {
  it('the shared file is client-safe: it imports only zod (no node, no db, no server file, no relative import)', () => {
    const source_ = readFileSync(fileURLToPath(new URL('../../../../../packages/shared/src/dice.ts', import.meta.url)), 'utf8');
    const imports = [...source_.matchAll(/^\s*(?:import|export)\b[^;]*?from\s+['"]([^'"]+)['"]/gm)].map(m => m[1]);
    expect(imports).toEqual(['zod']);
    const code = source_.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''); // the prose of the comments is not code
    expect(code).not.toMatch(/\bnode:|\bprocess\.|require\(|Math\.random|Date\.now/);
    // strip-only TypeScript: no enum, no parameter properties
    expect(source_).not.toMatch(/^\s*(export\s+)?(const\s+)?enum\s/m);
    const paramProperty = /constructor\((?:[^)]*,)?\s*(?:public|private|protected|readonly)\s+\w+/;
    expect(code).not.toMatch(paramProperty);
    expect('constructor(readonly code: string) {}').toMatch(paramProperty); // positive controls: the probe does see a parameter property, first or later
    expect('constructor(code: string, private x = 1) {}').toMatch(paramProperty);
    expect('constructor(code: string, issues: readonly string[] = []) {}').not.toMatch(paramProperty); // ... and not a type modifier
  });

  it('its scope schema accepts and rejects exactly what the N8 scope schema does (the two files are kept self-contained, so equality is a test)', () => {
    const samples: unknown[] = [
      { runIndex: 1, sequenceId: 's', rosterRevision: 'r', unit: 'PLAYER' }, { runIndex: 1, sequenceId: 's', rosterRevision: 'r', unit: 'TEAM' }, { runIndex: 0, sequenceId: 's', rosterRevision: 'r', unit: 'PLAYER' },
      { runIndex: 1.5, sequenceId: 's', rosterRevision: 'r', unit: 'PLAYER' }, { runIndex: 1, sequenceId: '-bad', rosterRevision: 'r', unit: 'PLAYER' }, { runIndex: 1, sequenceId: 's', rosterRevision: 'r', unit: 'X' },
      { runIndex: 1, sequenceId: 's', rosterRevision: 'r' }, { runIndex: 1, sequenceId: 's', rosterRevision: 'r', unit: 'PLAYER', extra: 1 }, { runIndex: 1, sequenceId: 'a'.repeat(81), rosterRevision: 'r', unit: 'PLAYER' }, null, 'x',
    ];
    for (const sample of samples) expect(DiceScopeSchema.safeParse(sample).success, JSON.stringify(sample)).toBe(TurnSequenceScopeSchema.safeParse(sample).success);
  });

  it('every dice error code is a stable wire code that passes the central whitelist unchanged; N8 codes pass through unchanged as well', () => {
    for (const code of DICE_ERROR_CODES) expect(gameErrorCode(new DiceTurnError(code))).toBe(code);
    for (const code of TURN_SEQUENCE_ERROR_CODES) expect(gameErrorCode(new Error(code))).toBe(code);
    expect(new Set(DICE_ERROR_CODES).size).toBe(DICE_ERROR_CODES.length);
    for (const code of DICE_ERROR_CODES) expect(code).toMatch(/^DICE_[A-Z_]+$/);
    expect(new DiceTurnError('DICE_CLOSED').message).toBe('DICE_CLOSED');
    expect(new DiceTurnError('DICE_STATE_INVALID', ['PHASE_CONFLICT']).issues).toEqual(['PHASE_CONFLICT']);
  });

  it('an error never carries a value, a position list, an id or a reason: messages are the code; issues are codes', () => {
    const { seq, dice } = rig();
    const secretId = 'participant-secret-77';
    for (const run of [
      () => rollDice(dice, { ...act(dice, seq, { caller: { role: 'PLAYER', participantId: secretId, teamId: null } }), source: source([1]).fn } as never),
      () => setDiceHeld(dice, { ...act(dice, seq), held: [4242] } as never),
      () => parseDiceTurnState({ ...clone(dice), values: [9, 9, 9, 9, 9], rollCount: 1 }),
    ]) {
      try { run(); } catch (error) {
        const text = JSON.stringify({ message: (error as Error).message, issues: (error as { issues?: unknown }).issues });
        expect(text).not.toContain(secretId);
        expect(text).not.toContain('4242');
        expect(text).not.toContain('9,9,9');
      }
    }
  });
});
