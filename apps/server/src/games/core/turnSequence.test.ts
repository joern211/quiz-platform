import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { applyStateEvent, createStateEvent, type EngineStateSnapshot } from '@quiz/game-sdk';
import { CoreTurnSchema } from '@quiz/shared';
import * as contract from '@quiz/shared/turnSequence';
import { TURN_SEQUENCE_ERROR_CODES, TURN_SEQUENCE_MAX_ACTORS, TurnSequenceProjectionSchema, TurnSequenceError, type TurnSequenceRelease } from '@quiz/shared/turnSequence';
import { gameErrorCode } from './errors.js';
import { advanceTurn as advanceCoreTurn, createTurn } from './roundFlow.js';
import { changeLives, createParticipationTrack, eliminateActor, findNextActiveTurn, parseParticipationTrackState, participationScopeOf, type ParticipationTrackState } from './participationTrack.js';
import type { ProjectionAudience } from './visibility.js';
import * as domain from './turnSequence.js';
import {
  advanceTurn, authorizeTurnAction, closeTurnSequence, currentTurnHolder, decideTurnOrder, eligibilityFromParticipation, overrideTurn, parseTurnSequenceState,
  prepareTurnSequence, projectTurnSequence, startTurnSequence, turnSequenceScopeOf, turnSequenceToCoreTurn, withholdCurrentHolder,
  type TurnEligibility, type TurnOutcome, type TurnSequenceState,
} from './turnSequence.js';

// A mutable view for the deliberate corruption tests (the point is to break the shape).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Draft = any;

// ── Synthetic fixtures. Ids are not names; nothing here is a game preset or a rule. ─────────────

const BASE = { runIndex: 1, sequenceId: 'seq-1', rosterRevision: 'roster-1' };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const level = (activeIds: string[], version: number, trackId: string) => ({ trackId, rosterRevision: 'track-roster-1', version, activeIds });
/** Plain eligibility snapshots. `version` is the (N6-like) track version: it only ever grows within one test story. */
const pel = (actors: string[], version = 1): TurnEligibility => ({ actors: level(actors, version, 'players-track'), members: null });
const tel = (teams: string[], members: string[], version = 1): TurnEligibility => ({ actors: level(teams, version, 'teams-track'), members: level(members, version, 'members-track') });

const PLAYERS = ['a', 'b', 'c'];
const TEAMS = [{ teamId: 'T1', members: ['A', 'B'] }, { teamId: 'T2', members: ['C', 'D', 'E'] }];
const ALL_TEAM_MEMBERS = ['A', 'B', 'C', 'D', 'E'];
const playerSequence = (order: string[] = PLAYERS, mode: 'FIXED' | 'RANDOM' | 'ROTATING_START' | 'CUSTOM_HOST_ORDER' = 'FIXED') => prepareTurnSequence({ ...BASE, unit: 'PLAYER', mode, order });
const teamSequence = (teams = TEAMS) => prepareTurnSequence({ ...BASE, unit: 'TEAM', mode: 'FIXED', order: teams.map(t => t.teamId), teams });
const everyone = (state: TurnSequenceState, version = 1): TurnEligibility => (state.unit === 'PLAYER' ? pel(state.order, version) : tel(state.order, state.teams!.flatMap(t => t.members), version));
const sc = (state: TurnSequenceState) => turnSequenceScopeOf(state);

const start = (state: TurnSequenceState, eligibility: TurnEligibility = everyone(state)) => startTurnSequence(state, { scope: sc(state), expectedVersion: state.version, eligibility }).state;
const adv = (state: TurnSequenceState, eligibility: TurnEligibility = everyone(state), outcome: TurnOutcome = 'COMPLETE', over: Record<string, unknown> = {}) =>
  advanceTurn(state, { scope: sc(state), expectedVersion: state.version, expectedTurnNumber: state.turnNumber, outcome, eligibility, ...over });
const label = (state: TurnSequenceState): string | null => { const h = currentTurnHolder(state); return h === null ? null : h.teamId === null ? h.playerId : `${h.teamId}/${h.playerId}`; };
const walk = (state: TurnSequenceState, steps: number, eligibility?: TurnEligibility): { states: TurnSequenceState[]; holders: Array<string | null> } => {
  const states = [state]; let current = state;
  for (let i = 0; i < steps; i++) { current = adv(current, eligibility ?? everyone(current)).state; states.push(current); }
  return { states, holders: states.map(label) };
};
const codeOf = (fn: () => unknown): string => { try { fn(); return 'NO_THROW'; } catch (error) { return error instanceof TurnSequenceError ? error.code : `OTHER:${String(error)}`; } };
const issuesOf = (fn: () => unknown): readonly string[] => { try { fn(); return []; } catch (error) { return error instanceof TurnSequenceError ? error.issues : ['OTHER']; } };

const started = (state: TurnSequenceState, eligibility?: TurnEligibility) => start(state, eligibility);

// ── A. Preparation ───────────────────────────────────────────

describe('N8 A: deciding and preparing an order', () => {
  it('FIXED keeps the given order and does not touch the input', () => {
    const ids = ['x', 'a', 'm'];
    expect(decideTurnOrder({ mode: 'FIXED', ids })).toEqual({ mode: 'FIXED', order: ['x', 'a', 'm'] }); // not alphabetical, not re-sorted
    expect(ids).toEqual(['x', 'a', 'm']);
  });
  it('RANDOM draws exactly once, from the injectable source, and checks the result for a permutation', () => {
    const shuffle = vi.fn((values: readonly string[]) => [...values].reverse());
    expect(decideTurnOrder({ mode: 'RANDOM', ids: ['a', 'b', 'c'], shuffle: shuffle as never })).toEqual({ mode: 'RANDOM', order: ['c', 'b', 'a'] });
    expect(shuffle).toHaveBeenCalledTimes(1);
    for (const broken of [(v: readonly string[]) => v.slice(1), (v: readonly string[]) => [...v, 'z'], (v: readonly string[]) => [v[0], v[0], v[1]], (v: readonly string[]) => v.map(() => 'q')]) {
      expect(codeOf(() => decideTurnOrder({ mode: 'RANDOM', ids: ['a', 'b', 'c'], shuffle: broken as never }))).toBe('TURN_SEQ_ORDER_INVALID');
    }
    expect(codeOf(() => decideTurnOrder({ mode: 'RANDOM', ids: ['a', 'b'], shuffle: 5 as never }))).toBe('TURN_SEQ_ARGS_INVALID');
  });
  it('RANDOM with the default server randomness yields a permutation, and over many draws it is not always the identity', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    const seen = new Set<string>();
    for (let i = 0; i < 60; i++) {
      const { order } = decideTurnOrder({ mode: 'RANDOM', ids });
      expect([...order].sort()).toEqual(ids);
      seen.add(order.join(''));
    }
    expect(seen.size).toBeGreaterThan(1);
  });
  it('ROTATING_START: explicit first run, known predecessor (same rotation as createTurn), invalid predecessor never guessed', () => {
    const ids = ['a', 'b', 'c', 'd'];
    expect(decideTurnOrder({ mode: 'ROTATING_START', ids, previousStartId: null }).order).toEqual(ids); // first run: unchanged, ids[0] starts
    for (const previous of ids) expect(decideTurnOrder({ mode: 'ROTATING_START', ids, previousStartId: previous }).order).toEqual(createTurn(ids, 'ROTATING_START', previous).order);
    expect(decideTurnOrder({ mode: 'ROTATING_START', ids, previousStartId: 'b' }).order).toEqual(['c', 'd', 'a', 'b']);
    expect(decideTurnOrder({ mode: 'ROTATING_START', ids, previousStartId: 'd' }).order).toEqual(['a', 'b', 'c', 'd']);
    for (const bad of ['zz', '', 'A', 7, undefined, {}]) {
      expect(codeOf(() => decideTurnOrder({ mode: 'ROTATING_START', ids, previousStartId: bad as never })), String(bad)).toBe(bad === undefined ? 'TURN_SEQ_ARGS_INVALID' : 'TURN_SEQ_PREVIOUS_START_INVALID');
    }
    expect(codeOf(() => decideTurnOrder({ mode: 'ROTATING_START', ids } as never))).toBe('TURN_SEQ_ARGS_INVALID'); // the key is required: null says "first run" explicitly
  });
  it('rotation is not advanced by delivery: the same inputs always give the same order', () => {
    const a = decideTurnOrder({ mode: 'ROTATING_START', ids: ['a', 'b', 'c'], previousStartId: 'a' }).order;
    for (let i = 0; i < 5; i++) expect(decideTurnOrder({ mode: 'ROTATING_START', ids: ['a', 'b', 'c'], previousStartId: 'a' }).order).toEqual(a);
  });
  it('CUSTOM_HOST_ORDER must be an explicit permutation: unknown, missing and duplicate entries are rejected, never sorted or repaired', () => {
    const ids = ['a', 'b', 'c'];
    expect(decideTurnOrder({ mode: 'CUSTOM_HOST_ORDER', ids, customOrder: ['c', 'a', 'b'] }).order).toEqual(['c', 'a', 'b']);
    const cases: Array<[unknown, string[]]> = [
      [['a', 'b', 'x'], ['ORDER_UNKNOWN_ACTOR', 'ORDER_MISSING_ACTOR']], [['a', 'b'], ['ORDER_MISSING_ACTOR']], [['a', 'b', 'c', 'c'], ['ORDER_DUPLICATE']],
      [['a', 'a', 'b'], ['ORDER_DUPLICATE', 'ORDER_MISSING_ACTOR']], [[], ['ORDER_EMPTY']], ['abc', ['SHAPE_INVALID']], [['a', 'b', 'c', 'd'], ['ORDER_UNKNOWN_ACTOR']],
    ];
    for (const [customOrder, expected] of cases) {
      expect(codeOf(() => decideTurnOrder({ mode: 'CUSTOM_HOST_ORDER', ids, customOrder: customOrder as never })), JSON.stringify(customOrder)).toBe('TURN_SEQ_ORDER_INVALID');
      expect([...issuesOf(() => decideTurnOrder({ mode: 'CUSTOM_HOST_ORDER', ids, customOrder: customOrder as never }))].sort(), JSON.stringify(customOrder)).toEqual([...expected].sort());
    }
    expect(codeOf(() => decideTurnOrder({ mode: 'CUSTOM_HOST_ORDER', ids } as never))).toBe('TURN_SEQ_ARGS_INVALID'); // no whole state / no default order
  });
  it('rejects malformed candidates and arguments: duplicate, empty, oversized, non-string, extra keys, unknown mode', () => {
    expect(issuesOf(() => decideTurnOrder({ mode: 'FIXED', ids: ['a', 'a'] }))).toEqual(['ORDER_DUPLICATE']);
    expect(issuesOf(() => decideTurnOrder({ mode: 'FIXED', ids: [] }))).toEqual(['ORDER_EMPTY']);
    expect(issuesOf(() => decideTurnOrder({ mode: 'FIXED', ids: Array.from({ length: TURN_SEQUENCE_MAX_ACTORS + 1 }, (_, i) => `p${i}`) }))).toEqual(['LIMIT_EXCEEDED']);
    expect(issuesOf(() => decideTurnOrder({ mode: 'FIXED', ids: ['a', 3] as never }))).toEqual(['SHAPE_INVALID']);
    expect(issuesOf(() => decideTurnOrder({ mode: 'FIXED', ids: ['a', ''] }))).toEqual(['SHAPE_INVALID']);
    for (const bad of [null, undefined, 'FIXED', [], { mode: 'LOTTERY', ids: ['a'] }, { mode: 'FIXED', ids: ['a'], extra: 1 }, { mode: 'FIXED', ids: ['a'], previousStartId: null }, { ids: ['a'] }]) {
      expect(codeOf(() => decideTurnOrder(bad as never)), JSON.stringify(bad)).toBe('TURN_SEQ_ARGS_INVALID');
    }
    expect(decideTurnOrder({ mode: 'FIXED', ids: Array.from({ length: TURN_SEQUENCE_MAX_ACTORS }, (_, i) => `p${i}`) }).order).toHaveLength(TURN_SEQUENCE_MAX_ACTORS);
  });
  it('prepares a READY player sequence with the decided order and records nothing else', () => {
    const state = playerSequence(['c', 'a', 'b'], 'CUSTOM_HOST_ORDER');
    expect(state).toEqual({
      kind: 'TURN_SEQUENCE', schemaVersion: 1, ...BASE, unit: 'PLAYER', mode: 'CUSTOM_HOST_ORDER', order: ['c', 'a', 'b'], teams: null, phase: 'READY',
      version: 0, turnNumber: 0, completedTurns: 0, cycle: 0, position: null, memberIndex: null, entitlementRevision: 0, eligibility: null, lastOverride: null,
    });
    expect(currentTurnHolder(state)).toBeNull();
    expect(CoreTurnSchema.safeParse(turnSequenceToCoreTurn(state)).success).toBe(false); // READY has no holder → no CoreTurn
    expect(turnSequenceToCoreTurn(state)).toBeNull();
  });
  it('prepares a team sequence: teams aligned to the outer order by id, member order exactly as given, every cursor 0', () => {
    const state = prepareTurnSequence({ ...BASE, unit: 'TEAM', mode: 'FIXED', order: ['T2', 'T1'], teams: TEAMS }); // teams listed in another order than `order`
    expect(state.teams).toEqual([{ teamId: 'T2', members: ['C', 'D', 'E'], cursor: 0 }, { teamId: 'T1', members: ['A', 'B'], cursor: 0 }]);
    expect(state.order).toEqual(['T2', 'T1']);
    expect(state.eligibility).toBeNull();
  });
  it('rejects every impossible preparation with a code-only reason and keeps nothing of the input', () => {
    const bad = (over: Record<string, unknown>) => () => prepareTurnSequence({ ...BASE, unit: 'TEAM', mode: 'FIXED', order: ['T1', 'T2'], teams: TEAMS, ...over } as never);
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['teams missing', { teams: undefined }, 'TEAMS_CONFLICT'], ['unknown team in order', { order: ['T1', 'T9'] }, 'TEAMS_CONFLICT'], ['team without entry', { order: ['T1'] }, 'TEAMS_CONFLICT'],
      ['duplicate team entry', { teams: [TEAMS[0], TEAMS[0]] }, 'TEAM_DUPLICATE'], ['empty team', { teams: [TEAMS[0], { teamId: 'T2', members: [] }] }, 'TEAM_EMPTY'],
      ['member in two teams', { teams: [TEAMS[0], { teamId: 'T2', members: ['A', 'D'] }] }, 'MEMBER_DUPLICATE'], ['duplicate member in a team', { teams: [{ teamId: 'T1', members: ['A', 'A'] }, TEAMS[1]] }, 'MEMBER_DUPLICATE'],
      ['duplicate team in order', { order: ['T1', 'T1'] }, 'ORDER_DUPLICATE'], ['empty order', { order: [] }, 'ORDER_EMPTY'], ['bad entry shape', { teams: [{ teamId: 'T1', members: ['A'], extra: 1 }, TEAMS[1]] }, 'SHAPE_INVALID'],
      ['unknown mode', { mode: 'LOTTERY' }, 'SHAPE_INVALID'], ['unit', { unit: 'GROUP' }, 'SHAPE_INVALID'], ['run 0', { runIndex: 0 }, 'SHAPE_INVALID'], ['bad label', { sequenceId: 'a b' }, 'SHAPE_INVALID'],
    ];
    for (const [name, over, issue] of cases) { expect(codeOf(bad(over)), name).toBe('TURN_SEQ_INVALID'); expect(issuesOf(bad(over)), name).toContain(issue); }
    expect(codeOf(() => prepareTurnSequence({ ...BASE, unit: 'PLAYER', mode: 'FIXED', order: ['a'], teams: TEAMS }))).toBe('TURN_SEQ_INVALID');
    const many = Array.from({ length: 26 }, (_, i) => ({ teamId: `t${i}`, members: Array.from({ length: 4 }, (_, j) => `m${i}-${j}`) })); // 104 players in total
    expect(issuesOf(() => prepareTurnSequence({ ...BASE, unit: 'TEAM', mode: 'FIXED', order: many.map(t => t.teamId), teams: many }))).toContain('LIMIT_EXCEEDED');
    for (const garbage of [null, 'x', [], { ...BASE }, { ...BASE, unit: 'PLAYER', mode: 'FIXED', order: ['a'], extra: true }]) expect(codeOf(() => prepareTurnSequence(garbage as never)), JSON.stringify(garbage)).toBe('TURN_SEQ_ARGS_INVALID');
    const input = { ...BASE, unit: 'PLAYER' as const, mode: 'FIXED' as const, order: ['a', 'b'] };
    const state = prepareTurnSequence(input);
    input.order.push('z');
    expect(state.order).toEqual(['a', 'b']);
  });
  it('once decided, the order is never decided again: a counting shuffle ran once; transitions, projections, loads and JSON round trips never reorder', () => {
    const shuffle = vi.fn((values: readonly string[]) => [...values].reverse());
    const decided = decideTurnOrder({ mode: 'RANDOM', ids: ['a', 'b', 'c', 'd'], shuffle: shuffle as never });
    let state = start(prepareTurnSequence({ ...BASE, unit: 'PLAYER', mode: decided.mode, order: decided.order }));
    const clock = vi.spyOn(Date, 'now'), random = vi.spyOn(Math, 'random');
    try {
      for (let i = 0; i < 40; i++) {
        state = parseTurnSequenceState(clone(state));
        state = adv(state).state;
        projectTurnSequence({ role: 'PLAYER', participantId: 'a' }, state, { scope: sc(state), release: 'ORDER', stateVersion: i });
        expect(state.order).toEqual(['d', 'c', 'b', 'a']);
      }
      expect(clock).not.toHaveBeenCalled();
      expect(random).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); random.mockRestore(); }
    expect(shuffle).toHaveBeenCalledTimes(1);
  });
  it('keeps randomness out of the state module: the shuffle source is referenced only by the import and the one preparation function', () => {
    const source = readFileSync(fileURLToPath(new URL('./turnSequence.ts', import.meta.url)), 'utf8');
    const lines = source.split('\n').filter(line => /shuffleServer|randomInt|Math\.random|Date\.now/.test(line) && !line.trim().startsWith('//') && !line.trim().startsWith('*'));
    expect(lines.filter(line => /Date\.now|Math\.random|randomInt/.test(line))).toEqual([]);
    expect(lines.filter(line => line.includes('shuffleServer'))).toHaveLength(2); // import + the default of decideTurnOrder
  });
});

// ── B. Single-player sequences ───────────────────────────────

describe('N8 B: a sequence of players', () => {
  it('goes A → B → C → A with correct cycles, distinct turn identities and one version step per turn', () => {
    const { states, holders } = walk(started(playerSequence()), 7);
    expect(holders).toEqual(['a', 'b', 'c', 'a', 'b', 'c', 'a', 'b']);
    expect(states.map(s => s.turnNumber)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(states.map(s => s.cycle)).toEqual([0, 0, 0, 1, 1, 1, 2, 2]);
    expect(states.map(s => s.completedTurns)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(states.map(s => s.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(new Set(states.map(s => s.turnNumber)).size).toBe(8);
    expect(states.every(s => s.phase === 'ACTIVE' && s.entitlementRevision === 1)).toBe(true); // "may anybody act" never flipped after the start
    expect(states[0].order).toEqual(PLAYERS);
  });
  it('a single actor gets a NEW turn after completion — same player, new identity, no winner', () => {
    const first = started(playerSequence(['solo']));
    const second = adv(first);
    expect(second.changed).toBe(true);
    expect(label(second.state)).toBe('solo');
    expect(second.state.turnNumber).toBe(first.turnNumber + 1);
    expect(second.state.cycle).toBe(1);
    expect(second.state.completedTurns).toBe(1);
    expect(second.state.phase).toBe('ACTIVE');
    expect(Object.keys(second.state).some(key => /win|rank|point|score|life/i.test(key))).toBe(false);
    expect(second.transition).toMatchObject({ kind: 'COMPLETE', turnNumberBefore: 1, turnNumberAfter: 2, holderBefore: { teamId: null, playerId: 'solo' }, holderAfter: { teamId: null, playerId: 'solo' } });
  });
  it('skips inactive players without re-sorting and without consuming anything; a skipped position is no completed turn', () => {
    let state = started(playerSequence(['a', 'b', 'c', 'd']), pel(['a', 'b', 'c', 'd'], 1));
    const act = pel(['a', 'c', 'd'], 2); // b is out
    state = adv(state, act).state;
    expect(label(state)).toBe('c');
    expect(state.completedTurns).toBe(1); // one real completion (a); b's position was only passed
    expect(state.order).toEqual(['a', 'b', 'c', 'd']);
    state = adv(state, act).state; state = adv(state, act).state;
    expect(label(state)).toBe('a'); // d → wrap over the end → a (b skipped next time)
    expect(state.cycle).toBe(1);
    expect(label(adv(state, act).state)).toBe('c');
  });
  it('shows "no suitable actor" explicitly, with no holder, no winner and no endless loop; a retry that finds nobody is no change', () => {
    const s1 = started(playerSequence());
    const none = adv(s1, pel([], 2));
    expect(none.state.phase).toBe('NO_ELIGIBLE');
    expect(currentTurnHolder(none.state)).toBeNull();
    expect(none.state.turnNumber).toBe(1); // no turn began
    expect(none.state.completedTurns).toBe(1);
    expect(none.state.entitlementRevision).toBe(2); // "may anybody act" flipped off
    expect(none.transition).toMatchObject({ phaseBefore: 'ACTIVE', phaseAfter: 'NO_ELIGIBLE', holderAfter: null });
    const again = adv(none.state, pel([], 2), 'SKIP');
    expect(again).toMatchObject({ changed: false, transition: null });
    expect(again.state).toEqual(none.state);
    expect(codeOf(() => adv(none.state, pel(['b'], 3), 'COMPLETE'))).toBe('TURN_SEQ_NO_CURRENT');
    const resumed = adv(none.state, pel(['b'], 3), 'SKIP');
    expect(label(resumed.state)).toBe('b');
    expect(resumed.state.turnNumber).toBe(2);
    expect(resumed.state.entitlementRevision).toBe(3);
    // the start itself can find nobody: still READY → NO_ELIGIBLE with turnNumber 0 and no position
    const idle = startTurnSequence(playerSequence(), { scope: sc(playerSequence()), expectedVersion: 0, eligibility: pel([], 1) }).state;
    expect(idle).toMatchObject({ phase: 'NO_ELIGIBLE', turnNumber: 0, position: null, version: 1 });
    expect(label(adv(idle, pel(['c'], 2), 'SKIP').state)).toBe('c');
    expect(adv(idle, pel(['c'], 2), 'SKIP').state.turnNumber).toBe(1);
  });
  it('a lone eligible actor who is also the current one is found again after one full cycle (the current position is examined last)', () => {
    const state = started(playerSequence(), pel(['a', 'b', 'c'], 1));
    const next = adv(state, pel(['a'], 2)).state;
    expect(label(next)).toBe('a');
    expect(next).toMatchObject({ turnNumber: 2, cycle: 1 });
  });
  it('disconnect and rejoin change nothing: the sequence has no connection input, a reload and a re-projection are identical', () => {
    const state = walk(started(playerSequence()), 4).states[4];
    const audience = (): ProjectionAudience => ({ role: 'PLAYER', participantId: 'b' });
    const before = projectTurnSequence(audience(), state, { scope: sc(state), release: 'ORDER', stateVersion: 9 });
    const reloaded = parseTurnSequenceState(clone(state));
    const after = projectTurnSequence(audience(), reloaded, { scope: sc(reloaded), release: 'ORDER', stateVersion: 9 });
    expect(after).toEqual(before);
    expect(reloaded).toEqual(state);
    expect(Object.keys(domain).filter(name => /connect|presence|online|disconnect/i.test(name))).toEqual([]);
  });
  it('maps exactly to a CoreTurn for the player unit and finds the same next actor as N6 findNextActiveTurn for every status pattern', () => {
    const ids = ['p1', 'p2', 'p3', 'p4', 'p5'];
    const track = (out: string[]): ParticipationTrackState => {
      let t = createParticipationTrack({ runIndex: 1, trackId: 'trk', rosterRevision: 'r1', actorKind: 'PARTICIPANT', config: { livesMode: 'OFF' }, actors: ids.map(actorId => ({ actorId, lives: null })) });
      for (const id of out) t = eliminateActor(t, { scope: participationScopeOf(t), expectedVersion: t.version, actorId: id, now: 1 }).state;
      return t;
    };
    let compared = 0;
    for (const mode of ['FIXED', 'CUSTOM_HOST_ORDER'] as const) {
      for (let pattern = 0; pattern < 32; pattern++) {
        const out = ids.filter((_, i) => pattern & (1 << i));
        for (let at = 0; at < ids.length; at++) {
          const everybody = eligibilityFromParticipation({ unit: 'PLAYER', actors: { track: track([]), scope: participationScopeOf(track([])) } });
          let state = started(prepareTurnSequence({ ...BASE, unit: 'PLAYER', mode, order: ids }), everybody);
          for (let i = 0; i < at; i++) state = adv(state, everybody).state;
          const t = track(out);
          const coreTurn = turnSequenceToCoreTurn(state)!;
          expect(coreTurn).toEqual({ mode, order: ids, index: at, cycle: 0 });
          expect(CoreTurnSchema.safeParse(coreTurn).success).toBe(true);
          const expected = findNextActiveTurn(t, participationScopeOf(t), coreTurn, { includeCurrent: false });
          const eligibility = eligibilityFromParticipation({ unit: 'PLAYER', actors: { track: t, scope: participationScopeOf(t) } });
          const result = adv(state, eligibility);
          if (expected.kind === 'NONE') expect(result.state.phase).toBe('NO_ELIGIBLE');
          else {
            expect(result.state.phase).toBe('ACTIVE');
            expect(result.state.position).toBe(expected.turn.index);
            expect(result.state.cycle).toBe(expected.turn.cycle);
            expect(turnSequenceToCoreTurn(result.state)).toEqual(expected.turn);
          }
          compared++;
        }
      }
    }
    expect(compared).toBe(320);
    // and for the plain all-active case it is the existing advanceTurn
    let core = createTurn(ids, 'FIXED'); let ours = started(prepareTurnSequence({ ...BASE, unit: 'PLAYER', mode: 'FIXED', order: ids }));
    for (let i = 0; i < 12; i++) { core = advanceCoreTurn(core); ours = adv(ours).state; expect(turnSequenceToCoreTurn(ours)).toEqual(core); }
  });
  it('takes the status from N6: a player at 0 lives under KEEP_ACTIVE still gets turns; under ELIMINATE the same loss removes the player from the turns', () => {
    const ids = ['p1', 'p2', 'p3'];
    const make = (zeroLivesPolicy: 'KEEP_ACTIVE' | 'ELIMINATE') => {
      let t = createParticipationTrack({ runIndex: 1, trackId: 'trk', rosterRevision: 'r1', actorKind: 'PARTICIPANT', config: { livesMode: 'ON', maxLives: 3, zeroLivesPolicy }, actors: ids.map(actorId => ({ actorId, lives: 1 })) });
      t = changeLives(t, { scope: participationScopeOf(t), expectedVersion: t.version, actorId: 'p2', delta: -1, now: 5 }).state;
      return t;
    };
    for (const [policy, expectedHolders] of [['KEEP_ACTIVE', ['p1', 'p2', 'p3', 'p1', 'p2']], ['ELIMINATE', ['p1', 'p3', 'p1', 'p3', 'p1']]] as const) {
      const t = make(policy);
      const eligibility = eligibilityFromParticipation({ unit: 'PLAYER', actors: { track: t, scope: participationScopeOf(t) } });
      expect(walk(started(prepareTurnSequence({ ...BASE, unit: 'PLAYER', mode: 'FIXED', order: ids }), eligibility), 4, eligibility).holders, policy).toEqual(expectedHolders);
    }
  });
  it('rejects an eligibility from the wrong layer, kind or track', () => {
    const t = createParticipationTrack({ runIndex: 1, trackId: 'trk', rosterRevision: 'r1', actorKind: 'TEAM', config: { livesMode: 'OFF' }, actors: [{ actorId: 'T1', lives: null }] });
    expect(codeOf(() => eligibilityFromParticipation({ unit: 'PLAYER', actors: { track: t, scope: participationScopeOf(t) } }))).toBe('TURN_SEQ_ELIGIBILITY_INVALID');
    expect(codeOf(() => eligibilityFromParticipation({ unit: 'TEAM', actors: { track: t, scope: participationScopeOf(t) } }))).toBe('TURN_SEQ_ELIGIBILITY_INVALID'); // members missing
    expect(codeOf(() => eligibilityFromParticipation({ unit: 'TEAM', actors: { track: t, scope: participationScopeOf(t) }, members: { track: t, scope: participationScopeOf(t) } }))).toBe('TURN_SEQ_ELIGIBILITY_INVALID'); // members must be PARTICIPANT
    expect(() => eligibilityFromParticipation({ unit: 'TEAM', actors: { track: t, scope: { ...participationScopeOf(t), runIndex: 9 } }, members: { track: t, scope: participationScopeOf(t) } })).toThrow('PARTICIPATION_RUN_STALE');
    expect(codeOf(() => eligibilityFromParticipation({ unit: 'PLAYER', actors: { track: { broken: true }, scope: participationScopeOf(t) } }))).toBe('OTHER:ParticipationError: PARTICIPATION_STATE_INVALID');
  });
});

// ── C. Team rotation ─────────────────────────────────────────

/** A small INDEPENDENT oracle: per team a ring that is rotated with shift/push (no cursor, no index arithmetic), and an outer pointer over team names. */
function oracleTeams(teams: Array<{ teamId: string; members: string[] }>, turns: number, activeTeams: (turn: number) => string[], activeMembers: (turn: number) => string[]): Array<string | null> {
  const rings = new Map(teams.map(t => [t.teamId, [...t.members]]));
  const result: Array<string | null> = [];
  let outer = -1;
  for (let turn = 0; turn < turns; turn++) {
    let found: string | null = null;
    for (let tries = 0; tries < teams.length && found === null; tries++) {
      outer = (outer + 1) % teams.length;
      const team = teams[outer].teamId;
      if (!activeTeams(turn).includes(team)) continue;
      const ring = rings.get(team)!;
      for (let k = 0; k < ring.length; k++) {
        if (activeMembers(turn).includes(ring[0])) { found = `${team}/${ring[0]}`; ring.push(ring.shift()!); break; } // the actor completes → he goes to the back
        ring.push(ring.shift()!); // a passed-over member keeps his place relative to the others (rotated back below)
      }
      if (found === null) { /* nobody suitable in this team: ring is back at its start after one full pass */ }
    }
    result.push(found);
    if (found === null) break;
  }
  return result;
}

describe('N8 C: team turns with an inner rotation', () => {
  it('reproduces the documented example T1=[A,B], T2=[C,D,E] over many outer cycles', () => {
    const { holders } = walk(started(teamSequence()), 9);
    expect(holders).toEqual(['T1/A', 'T2/C', 'T1/B', 'T2/D', 'T1/A', 'T2/E', 'T1/B', 'T2/C', 'T1/A', 'T2/D']);
  });
  it('matches a closed-form oracle over 60 turns and gives every team the same number of outer turns (no extra turns for the bigger team)', () => {
    const { holders, states } = walk(started(teamSequence()), 59);
    const closed = Array.from({ length: 60 }, (_, k) => { const team = TEAMS[k % 2]; return `${team.teamId}/${team.members[Math.floor(k / 2) % team.members.length]}`; });
    expect(holders).toEqual(closed);
    expect(holders.filter(h => h!.startsWith('T1/'))).toHaveLength(30);
    expect(holders.filter(h => h!.startsWith('T2/'))).toHaveLength(30);
    expect(states[59]).toMatchObject({ turnNumber: 60, completedTurns: 59, cycle: 29 });
    expect(new Set(states.map(s => s.turnNumber)).size).toBe(60);
  });
  it('keeps an own cursor per team and moves ONLY the completing team, exactly once per completed team turn', () => {
    let state = started(teamSequence());
    const cursors = (s: TurnSequenceState) => Object.fromEntries(s.teams!.map(t => [t.teamId, t.cursor]));
    expect(cursors(state)).toEqual({ T1: 0, T2: 0 }); // a started turn moves nothing
    const trace: Array<Record<string, number>> = [];
    for (let i = 0; i < 6; i++) { state = adv(state).state; trace.push(cursors(state)); }
    expect(trace).toEqual([{ T1: 1, T2: 0 }, { T1: 1, T2: 1 }, { T1: 0, T2: 1 }, { T1: 0, T2: 2 }, { T1: 1, T2: 2 }, { T1: 1, T2: 0 }]);
  });
  it('a skipped (SKIP) turn moves no cursor and counts as no completion; the same member stays next in line', () => {
    const s1 = started(teamSequence());
    const skipped = adv(s1, everyone(s1, 2), 'SKIP').state;
    expect(label(skipped)).toBe('T2/C');
    expect(skipped.teams!.map(t => t.cursor)).toEqual([0, 0]);
    expect(skipped.completedTurns).toBe(0);
    expect(label(adv(skipped, everyone(skipped, 3), 'SKIP').state)).toBe('T1/A'); // T1/A did not use his turn; the rotation did not move
  });
  it('matches the independent ring oracle over several outer cycles with changing eligibility (members and teams)', () => {
    const scenarios: Array<{ name: string; teams: Array<{ teamId: string; members: string[] }>; activeTeams: (t: number) => string[]; activeMembers: (t: number) => string[] }> = [
      { name: 'one member inactive', teams: TEAMS, activeTeams: () => ['T1', 'T2'], activeMembers: () => ['A', 'B', 'C', 'E'] },
      { name: 'member leaves later', teams: TEAMS, activeTeams: () => ['T1', 'T2'], activeMembers: t => (t < 5 ? ALL_TEAM_MEMBERS : ['A', 'C', 'D', 'E']) },
      { name: 'team inactive from turn 4', teams: TEAMS, activeTeams: t => (t < 4 ? ['T1', 'T2'] : ['T2']), activeMembers: () => ALL_TEAM_MEMBERS },
      { name: 'three teams, uneven', teams: [{ teamId: 'X', members: ['x1'] }, { teamId: 'Y', members: ['y1', 'y2', 'y3', 'y4'] }, { teamId: 'Z', members: ['z1', 'z2'] }], activeTeams: () => ['X', 'Y', 'Z'], activeMembers: () => ['x1', 'y1', 'y2', 'y3', 'y4', 'z1', 'z2'] },
      { name: 'three teams, y3 and z1 out', teams: [{ teamId: 'X', members: ['x1'] }, { teamId: 'Y', members: ['y1', 'y2', 'y3', 'y4'] }, { teamId: 'Z', members: ['z1', 'z2'] }], activeTeams: () => ['X', 'Y', 'Z'], activeMembers: () => ['x1', 'y1', 'y2', 'y4', 'z2'] },
    ];
    for (const scenario of scenarios) {
      const turns = 24;
      const expected = oracleTeams(scenario.teams, turns, scenario.activeTeams, scenario.activeMembers);
      const all = scenario.teams.flatMap(t => t.members);
      let state = prepareTurnSequence({ ...BASE, unit: 'TEAM', mode: 'FIXED', order: scenario.teams.map(t => t.teamId), teams: scenario.teams });
      const eligibility = (turn: number) => tel(scenario.activeTeams(turn), scenario.activeMembers(turn).filter(m => all.includes(m)), turn + 1);
      state = startTurnSequence(state, { scope: sc(state), expectedVersion: 0, eligibility: eligibility(0) }).state;
      const holders = [label(state)];
      for (let turn = 1; turn < turns; turn++) { state = adv(state, eligibility(turn)).state; holders.push(label(state)); }
      expect(holders, scenario.name).toEqual(expected);
    }
  });
  it('a team with one member always gets that member; a team without any eligible member is passed over (no invented player, no cursor consumed, no team KO)', () => {
    const teams = [{ teamId: 'S', members: ['solo'] }, { teamId: 'M', members: ['m1', 'm2'] }];
    expect(walk(started(teamSequence(teams)), 5).holders).toEqual(['S/solo', 'M/m1', 'S/solo', 'M/m2', 'S/solo', 'M/m1']);
    let state = started(teamSequence(), tel(['T1', 'T2'], ALL_TEAM_MEMBERS, 1)); // T1/A
    const noT1Members = tel(['T1', 'T2'], ['C', 'D', 'E'], 2);
    state = adv(state, noT1Members).state;
    expect(label(state)).toBe('T2/C');
    expect(state.teams![0].cursor).toBe(1); // T1/A completed once
    state = adv(state, noT1Members).state; // T1 has nobody → T2 again
    expect(label(state)).toBe('T2/D');
    expect(state.teams![0].cursor).toBe(1); // T1 consumed nothing while passed over
    expect(state.teams![0].members).toEqual(['A', 'B']);
    expect(state.cycle).toBe(1); // T1 (position 0) was passed over once: the end of the outer order was crossed
    const nobody = adv(state, tel(['T1', 'T2'], [], 3)).state;
    expect(nobody.phase).toBe('NO_ELIGIBLE'); // no team has a suitable member: neutral, no winner, no redistribution
    expect(currentTurnHolder(nobody)).toBeNull();
    const inactiveTeams = adv(state, tel([], ALL_TEAM_MEMBERS, 3)).state;
    expect(inactiveTeams.phase).toBe('NO_ELIGIBLE');
    expect(nobody.teams!.map(t => t.members)).toEqual([['A', 'B'], ['C', 'D', 'E']]);
  });
  it('an inactive team is skipped without touching its member cursor; when it is suitable again it resumes exactly where it was', () => {
    let state = started(teamSequence(), tel(['T1', 'T2'], ALL_TEAM_MEMBERS, 1));
    state = adv(state, tel(['T2'], ALL_TEAM_MEMBERS, 2)).state; // T1/A completes, T1 out → T2/C
    state = adv(state, tel(['T2'], ALL_TEAM_MEMBERS, 2)).state; // T2/D
    state = adv(state, tel(['T2'], ALL_TEAM_MEMBERS, 2)).state; // T2/E
    expect(state.teams!.map(t => t.cursor)).toEqual([1, 2]); // T1 untouched since A; T2 cursor is on E, who is still playing
    expect(label(state)).toBe('T2/E');
    state = adv(state, tel(['T1', 'T2'], ALL_TEAM_MEMBERS, 3)).state;
    expect(label(state)).toBe('T1/B'); // T1 resumes with the member after A
  });
  it('only the current member of the current team may act: other member, other team, wrong team claim, viewer, display, host, unknown role', () => {
    const state = adv(started(teamSequence())).state; // T2/C is current
    const eligibility = everyone(state);
    const call = (caller: unknown, gate: unknown = { admitted: true, phaseOpen: true, paused: false }) => () => authorizeTurnAction(state, {
      scope: sc(state), expectedVersion: state.version, expectedTurnNumber: state.turnNumber, caller: caller as never, gate: gate as never, eligibility });
    expect(call({ role: 'PLAYER', participantId: 'C', teamId: 'T2' })()).toEqual({ allowed: true, turnNumber: 2, sequenceVersion: 2 });
    for (const [name, caller, code] of [
      ['teammate D', { role: 'PLAYER', participantId: 'D', teamId: 'T2' }, 'TURN_SEQ_NOT_CURRENT_ACTOR'], ['other team', { role: 'PLAYER', participantId: 'A', teamId: 'T1' }, 'TURN_SEQ_NOT_CURRENT_ACTOR'],
      ['holder claims the wrong team', { role: 'PLAYER', participantId: 'C', teamId: 'T1' }, 'TURN_SEQ_NOT_CURRENT_ACTOR'], ['holder without team', { role: 'PLAYER', participantId: 'C', teamId: null }, 'TURN_SEQ_NOT_CURRENT_ACTOR'],
      ['viewer', { role: 'VIEWER', participantId: 'C', teamId: 'T2' }, 'TURN_SEQ_ROLE_NOT_ALLOWED'], ['display', { role: 'DISPLAY', participantId: 'C', teamId: 'T2' }, 'TURN_SEQ_ROLE_NOT_ALLOWED'],
      ['non-playing host', { role: 'HOST', participantId: 'C', teamId: 'T2' }, 'TURN_SEQ_ROLE_NOT_ALLOWED'], ['admin string', { role: 'ADMIN', participantId: 'C', teamId: 'T2' }, 'TURN_SEQ_ROLE_NOT_ALLOWED'],
      ['unknown participant', { role: 'PLAYER', participantId: 'ZZ', teamId: 'T2' }, 'TURN_SEQ_NOT_CURRENT_ACTOR'],
      ['malformed', { role: 'PLAYER', participantId: '', teamId: 'T2' }, 'TURN_SEQ_ARGS_INVALID'], ['extra key', { role: 'PLAYER', participantId: 'C', teamId: 'T2', admin: true }, 'TURN_SEQ_ARGS_INVALID'],
      ['team undefined', { role: 'PLAYER', participantId: 'C' }, 'TURN_SEQ_ARGS_INVALID'],
    ] as const) expect(codeOf(call(caller)), name).toBe(code);
  });
});

// ── D. Actions, versions, concurrency of intents, override ───

describe('N8 D: actions, stale intents, held turns, override and close', () => {
  const authorize = (state: TurnSequenceState, over: Record<string, unknown> = {}) => authorizeTurnAction(state, {
    scope: sc(state), expectedVersion: state.version, expectedTurnNumber: state.turnNumber, caller: { role: 'PLAYER', participantId: (currentTurnHolder(state) ?? { playerId: 'a' }).playerId, teamId: currentTurnHolder(state)?.teamId ?? null },
    gate: { admitted: true, phaseOpen: true, paused: false }, eligibility: everyone(state), ...over });

  it('a second "next" with the same expected turn and version is rejected and changes nothing; with the new version but the old turn it is rejected as a stale turn', () => {
    const s1 = started(playerSequence());
    const intent = { scope: sc(s1), expectedVersion: s1.version, expectedTurnNumber: s1.turnNumber, outcome: 'COMPLETE' as const, eligibility: everyone(s1) };
    const s2 = advanceTurn(s1, intent).state;
    expect(codeOf(() => advanceTurn(s2, intent))).toBe('TURN_SEQ_VERSION_STALE'); // the SAME intent again: not applied twice
    expect(codeOf(() => advanceTurn(s2, { ...intent, expectedVersion: s2.version }))).toBe('TURN_SEQ_TURN_STALE');
    expect(label(s2)).toBe('b');
    expect(s2.turnNumber).toBe(2);
    expect(codeOf(() => advanceTurn(s1, { ...intent, expectedVersion: s1.version + 1 }))).toBe('TURN_SEQ_VERSION_STALE'); // also a future version is no match
    for (const bad of [NaN, 1.5, '1', null, undefined, -1, 2 ** 53]) expect(codeOf(() => advanceTurn(s1, { ...intent, expectedVersion: bad as never })), String(bad)).toBe('TURN_SEQ_VERSION_STALE');
    for (const bad of [NaN, 1.5, '1', null, undefined, -1]) expect(codeOf(() => advanceTurn(s1, { ...intent, expectedTurnNumber: bad as never })), String(bad)).toBe('TURN_SEQ_TURN_STALE');
  });
  it('the SAME player in a later turn is not the old turn: a late action from turn 1 is stale in turn 4 (A → B → C → A), by version and by turn', () => {
    const states = walk(started(playerSequence()), 3).states;
    const [t1, , , t4] = states;
    expect(label(t1)).toBe('a'); expect(label(t4)).toBe('a');
    const lateFromTurn1 = (state: TurnSequenceState) => authorizeTurnAction(state, { scope: sc(state), expectedVersion: t1.version, expectedTurnNumber: t1.turnNumber,
      caller: { role: 'PLAYER', participantId: 'a', teamId: null }, gate: { admitted: true, phaseOpen: true, paused: false }, eligibility: everyone(state) });
    expect(codeOf(() => lateFromTurn1(t4))).toBe('TURN_SEQ_VERSION_STALE');
    expect(codeOf(() => authorizeTurnAction(t4, { scope: sc(t4), expectedVersion: t4.version, expectedTurnNumber: t1.turnNumber, caller: { role: 'PLAYER', participantId: 'a', teamId: null },
      gate: { admitted: true, phaseOpen: true, paused: false }, eligibility: everyone(t4) }))).toBe('TURN_SEQ_TURN_STALE');
    expect(authorize(t4).allowed).toBe(true);
    // a single actor: the identity differs although the player is the same
    const solo1 = started(playerSequence(['solo'])); const solo2 = adv(solo1).state;
    expect(codeOf(() => authorizeTurnAction(solo2, { scope: sc(solo2), expectedVersion: solo1.version, expectedTurnNumber: solo1.turnNumber, caller: { role: 'PLAYER', participantId: 'solo', teamId: null },
      gate: { admitted: true, phaseOpen: true, paused: false }, eligibility: everyone(solo2) }))).toBe('TURN_SEQ_VERSION_STALE');
    expect(codeOf(() => adv(solo2, everyone(solo2), 'COMPLETE', { expectedTurnNumber: 1 }))).toBe('TURN_SEQ_TURN_STALE');
  });
  it('refuses to act before the start, after the close, in NO_ELIGIBLE and while held — with a fixed code each', () => {
    const ready = playerSequence();
    for (const fn of [
      () => adv(ready), () => withholdCurrentHolder(ready, { scope: sc(ready), expectedVersion: 0, expectedTurnNumber: 0, eligibility: pel([]) }),
      () => overrideTurn(ready, { scope: sc(ready), expectedVersion: 0, expectedTurnNumber: 0, target: { playerId: 'a' }, eligibility: pel(['a']), now: 1 }), () => authorize(ready),
    ]) expect(codeOf(fn)).toBe('TURN_SEQ_NOT_STARTED');
    const live = started(playerSequence());
    expect(codeOf(() => startTurnSequence(live, { scope: sc(live), expectedVersion: live.version, eligibility: everyone(live) }))).toBe('TURN_SEQ_ALREADY_STARTED');
    expect(codeOf(() => startTurnSequence(live, { scope: sc(live), expectedVersion: 0, eligibility: everyone(live) }))).toBe('TURN_SEQ_VERSION_STALE');
    const held = withholdCurrentHolder(live, { scope: sc(live), expectedVersion: live.version, expectedTurnNumber: live.turnNumber, eligibility: pel(['b', 'c'], 2) }).state;
    expect(codeOf(() => authorize(held, { eligibility: pel(['a', 'b', 'c'], 3) }))).toBe('TURN_SEQ_HELD');
    expect(codeOf(() => adv(held, pel(['b', 'c'], 3), 'COMPLETE'))).toBe('TURN_SEQ_HELD');
    const none = adv(live, pel([], 2)).state;
    expect(codeOf(() => authorize(none, { eligibility: pel([], 2) }))).toBe('TURN_SEQ_NO_CURRENT');
    const closed = closeTurnSequence(live, { scope: sc(live), expectedVersion: live.version }).state;
    for (const fn of [() => adv(closed), () => authorize(closed), () => startTurnSequence(closed, { scope: sc(closed), expectedVersion: closed.version, eligibility: everyone(closed) }),
      () => overrideTurn(closed, { scope: sc(closed), expectedVersion: closed.version, expectedTurnNumber: closed.turnNumber, target: { playerId: 'a' }, eligibility: everyone(closed), now: 1 }),
      () => withholdCurrentHolder(closed, { scope: sc(closed), expectedVersion: closed.version, expectedTurnNumber: closed.turnNumber, eligibility: everyone(closed) })]) expect(codeOf(fn)).toBe('TURN_SEQ_CLOSED');
  });
  it('pause, phase lock and missing admission block the action; the booleans are mandatory and exact', () => {
    const state = started(playerSequence());
    for (const [name, gate] of [['paused', { admitted: true, phaseOpen: true, paused: true }], ['phase closed', { admitted: true, phaseOpen: false, paused: false }], ['not admitted', { admitted: false, phaseOpen: true, paused: false }]] as const) {
      expect(codeOf(() => authorize(state, { gate })), name).toBe('TURN_SEQ_ACTION_BLOCKED');
    }
    for (const gate of [{ admitted: true, phaseOpen: true }, { admitted: 1, phaseOpen: true, paused: false }, null, { admitted: true, phaseOpen: true, paused: false, x: 1 }, 'ok']) {
      expect(codeOf(() => authorize(state, { gate })), JSON.stringify(gate)).toBe('TURN_SEQ_ARGS_INVALID');
    }
    expect(authorize(state).allowed).toBe(true);
  });
  it('an explicit loss of eligibility blocks the holder at once; a stale (older) eligibility can never revive him; the next actor is chosen only by an explicit server action', () => {
    const live = started(playerSequence(), pel(['a', 'b', 'c'], 5));
    const lost = pel(['b', 'c'], 6);
    expect(codeOf(() => authorize(live, { eligibility: lost }))).toBe('TURN_SEQ_ACTOR_NOT_ELIGIBLE');
    expect(codeOf(() => authorize(live, { eligibility: pel(['a', 'b', 'c'], 4) }))).toBe('TURN_SEQ_ELIGIBILITY_STALE'); // an OLD stand showing a as active
    expect(codeOf(() => withholdCurrentHolder(live, { scope: sc(live), expectedVersion: live.version, expectedTurnNumber: live.turnNumber, eligibility: pel(['a', 'b', 'c'], 6) }))).toBe('TURN_SEQ_HOLDER_STILL_ELIGIBLE');
    expect(codeOf(() => withholdCurrentHolder(live, { scope: sc(live), expectedVersion: live.version, expectedTurnNumber: live.turnNumber, eligibility: pel(['b', 'c'], 4) }))).toBe('TURN_SEQ_ELIGIBILITY_STALE');
    const held = withholdCurrentHolder(live, { scope: sc(live), expectedVersion: live.version, expectedTurnNumber: live.turnNumber, eligibility: lost });
    expect(held).toMatchObject({ changed: true });
    expect(held.state).toMatchObject({ phase: 'HELD', turnNumber: 1, version: 2, entitlementRevision: 2 });
    expect(label(held.state)).toBe('a'); // the holder stays visible as evidence; nobody may act
    expect(held.transition).toMatchObject({ kind: 'WITHHOLD', phaseBefore: 'ACTIVE', phaseAfter: 'HELD', versionBefore: 1, versionAfter: 2 });
    // a late older eligibility cannot undo the stored basis afterwards either
    expect(codeOf(() => adv(held.state, pel(['a', 'b', 'c'], 5), 'SKIP'))).toBe('TURN_SEQ_ELIGIBILITY_STALE');
    // idempotent at the current binding
    const again = withholdCurrentHolder(held.state, { scope: sc(held.state), expectedVersion: held.state.version, expectedTurnNumber: 1, eligibility: lost });
    expect(again).toMatchObject({ changed: false, transition: null });
    expect(codeOf(() => withholdCurrentHolder(held.state, { scope: sc(held.state), expectedVersion: live.version, expectedTurnNumber: 1, eligibility: lost }))).toBe('TURN_SEQ_VERSION_STALE');
    // explicit selection of the next actor
    const next = adv(held.state, lost, 'SKIP').state;
    expect(label(next)).toBe('b');
    expect(next).toMatchObject({ turnNumber: 2, completedTurns: 0, phase: 'ACTIVE', entitlementRevision: 3 });
    // a connection change is no input at all: the held state is the same after a reload
    expect(parseTurnSequenceState(clone(held.state))).toEqual(held.state);
  });
  it('a team holder whose team OR member lost eligibility is blocked and can be held', () => {
    const live = started(teamSequence(), tel(['T1', 'T2'], ALL_TEAM_MEMBERS, 1)); // T1/A
    for (const lost of [tel(['T2'], ALL_TEAM_MEMBERS, 2), tel(['T1', 'T2'], ['B', 'C', 'D', 'E'], 2)]) {
      expect(codeOf(() => authorize(live, { eligibility: lost }))).toBe('TURN_SEQ_ACTOR_NOT_ELIGIBLE');
      expect(withholdCurrentHolder(live, { scope: sc(live), expectedVersion: live.version, expectedTurnNumber: 1, eligibility: lost }).state.phase).toBe('HELD');
    }
    const memberOutOnly = tel(['T1', 'T2'], ['B', 'C', 'D', 'E'], 2);
    expect(label(adv(withholdCurrentHolder(live, { scope: sc(live), expectedVersion: 1, expectedTurnNumber: 1, eligibility: memberOutOnly }).state, memberOutOnly, 'SKIP').state)).toBe('T2/C');
  });
  describe('override', () => {
    const base = () => adv(started(teamSequence())).state; // T2/C, cursors [1, 0]
    const over = (state: TurnSequenceState, target: unknown, extra: Record<string, unknown> = {}) => overrideTurn(state, {
      scope: sc(state), expectedVersion: state.version, expectedTurnNumber: state.turnNumber, target: target as never, eligibility: everyone(state, 5), now: 7000, ...extra });
    it('names a new holder with a new turn, consumes no completion and no cursor, and the previous turn\'s open actions become void', () => {
      const s = base();
      const changed = over(s, { teamId: 'T1', playerId: 'B' }, { reason: '  Gerät defekt  ' });
      expect(changed.changed).toBe(true);
      expect(label(changed.state)).toBe('T1/B');
      expect(changed.state).toMatchObject({ turnNumber: 3, completedTurns: 1, cycle: s.cycle, version: s.version + 1, lastOverride: { atMs: 7000, fromTurnNumber: 2, toTurnNumber: 3 } });
      expect(changed.state.teams!.map(t => t.cursor)).toEqual([1, 0]); // neither the displaced T2 member C nor T1 moved
      expect(changed.transition).toMatchObject({ kind: 'OVERRIDE', reason: 'Gerät defekt', holderBefore: { teamId: 'T2', playerId: 'C' }, holderAfter: { teamId: 'T1', playerId: 'B' } });
      expect(JSON.stringify(changed.state)).not.toContain('Gerät'); // the reason lives in the transition only
      // the old binding is void
      expect(codeOf(() => authorizeTurnAction(changed.state, { scope: sc(s), expectedVersion: s.version, expectedTurnNumber: s.turnNumber, caller: { role: 'PLAYER', participantId: 'C', teamId: 'T2' },
        gate: { admitted: true, phaseOpen: true, paused: false }, eligibility: everyone(s, 5) }))).toBe('TURN_SEQ_VERSION_STALE');
      // continuation: after the overridden turn the sequence goes on after the TARGET's position and uses the target team's cursor once
      const done = adv(changed.state, everyone(changed.state, 5)).state;
      expect(label(done)).toBe('T2/C'); // C was displaced but is still next in his team
      expect(done.teams!.map(t => t.cursor)).toEqual([0, 0]); // B completed (cursor of T1 wraps to 0), T2 untouched
      expect(done.completedTurns).toBe(2);
      expect(done.cycle).toBe(s.cycle); // T1 (position 0) → T2 (position 1): no wrap
    });
    it('overriding to a later position and back never double-consumes: two normal turns cost two cursor steps, the override none', () => {
      let state = started(teamSequence());
      const before = state.teams!.map(t => t.cursor);
      state = over(state, { teamId: 'T2', playerId: 'E' }).state; // T2/E (index 2)
      expect(state.teams!.map(t => t.cursor)).toEqual(before);
      state = adv(state, everyone(state, 5)).state; // E completes → T2 cursor 0, next T1 with cursor 0
      expect(label(state)).toBe('T1/A');
      expect(state.teams!.map(t => t.cursor)).toEqual([0, 0]);
      expect(state.cycle).toBe(1);
      expect(state.completedTurns).toBe(1);
    });
    it('an identical target is a controlled no-op (no turn, no version) — but only at the CURRENT version; an old version is not rescued by being harmless', () => {
      const s = base();
      const same = over(s, { teamId: 'T2', playerId: 'C' });
      expect(same).toMatchObject({ changed: false, transition: null });
      expect(same.state).toEqual(s);
      expect(codeOf(() => over(s, { teamId: 'T2', playerId: 'C' }, { expectedVersion: s.version - 1 }))).toBe('TURN_SEQ_VERSION_STALE');
      expect(codeOf(() => over(s, { teamId: 'T2', playerId: 'C' }, { expectedTurnNumber: s.turnNumber - 1 }))).toBe('TURN_SEQ_TURN_STALE');
      // replaying the first override's intent after it was applied is not an identical-target no-op
      const applied = over(s, { teamId: 'T1', playerId: 'A' }).state;
      expect(codeOf(() => over(applied, { teamId: 'T1', playerId: 'A' }, { expectedVersion: s.version, expectedTurnNumber: s.turnNumber }))).toBe('TURN_SEQ_VERSION_STALE');
    });
    it('checks the target: unknown, other team, not eligible, malformed — each with its own code, state untouched', () => {
      const s = base();
      const cases: Array<[string, unknown, string, Partial<{ eligibility: TurnEligibility }>?]> = [
        ['unknown team', { teamId: 'T9', playerId: 'A' }, 'TURN_SEQ_ACTOR_UNKNOWN'], ['unknown player', { teamId: 'T1', playerId: 'ZZ' }, 'TURN_SEQ_ACTOR_UNKNOWN'],
        ['player of the other team', { teamId: 'T1', playerId: 'C' }, 'TURN_SEQ_TEAM_MEMBER_MISMATCH'],
        ['inactive member', { teamId: 'T1', playerId: 'B' }, 'TURN_SEQ_ACTOR_NOT_ELIGIBLE', { eligibility: tel(['T1', 'T2'], ['A', 'C', 'D', 'E'], 5) }],
        ['inactive team', { teamId: 'T1', playerId: 'A' }, 'TURN_SEQ_ACTOR_NOT_ELIGIBLE', { eligibility: tel(['T2'], ALL_TEAM_MEMBERS, 5) }],
        ['player id only', { playerId: 'A' }, 'TURN_SEQ_ARGS_INVALID'], ['extra key', { teamId: 'T1', playerId: 'A', role: 'x' }, 'TURN_SEQ_ARGS_INVALID'], ['no target', null, 'TURN_SEQ_ARGS_INVALID'],
      ];
      for (const [name, target, code, extra] of cases) expect(codeOf(() => over(s, target, extra)), name).toBe(code);
      expect(codeOf(() => over(s, { teamId: 'T1', playerId: 'A' }, { now: -1 }))).toBe('TURN_SEQ_TIME_INVALID');
      expect(codeOf(() => over(s, { teamId: 'T1', playerId: 'A' }, { now: 1.5 }))).toBe('TURN_SEQ_TIME_INVALID');
      expect(codeOf(() => over(s, { teamId: 'T1', playerId: 'A' }, { reason: 'x'.repeat(301) }))).toBe('TURN_SEQ_ARGS_INVALID');
      expect(codeOf(() => over(s, { teamId: 'T1', playerId: 'A' }, { reason: 5 }))).toBe('TURN_SEQ_ARGS_INVALID');
      expect(over(s, { teamId: 'T1', playerId: 'A' }, { reason: '   ' }).transition!.reason).toBeNull();
      expect(parseTurnSequenceState(s)).toEqual(base());
      const players = started(playerSequence());
      expect(codeOf(() => overrideTurn(players, { scope: sc(players), expectedVersion: 1, expectedTurnNumber: 1, target: { playerId: 'zz' }, eligibility: pel(['a'], 2), now: 1 }))).toBe('TURN_SEQ_ACTOR_UNKNOWN');
      expect(codeOf(() => overrideTurn(players, { scope: sc(players), expectedVersion: 1, expectedTurnNumber: 1, target: { playerId: 'b' }, eligibility: pel(['a'], 2), now: 1 }))).toBe('TURN_SEQ_ACTOR_NOT_ELIGIBLE');
      expect(codeOf(() => overrideTurn(players, { scope: sc(players), expectedVersion: 1, expectedTurnNumber: 1, target: { playerId: 'b', teamId: 'T1' }, eligibility: pel(['a', 'b'], 2), now: 1 }))).toBe('TURN_SEQ_ARGS_INVALID');
    });
    it('restores a held turn when the SAME target is named again and is eligible (a new turn), and can also select out of NO_ELIGIBLE', () => {
      const live = started(playerSequence(), pel(['a', 'b', 'c'], 1));
      const held = withholdCurrentHolder(live, { scope: sc(live), expectedVersion: 1, expectedTurnNumber: 1, eligibility: pel(['b', 'c'], 2) }).state;
      const back = overrideTurn(held, { scope: sc(held), expectedVersion: held.version, expectedTurnNumber: 1, target: { playerId: 'a' }, eligibility: pel(['a', 'b', 'c'], 3), now: 5 });
      expect(back.changed).toBe(true);
      expect(back.state).toMatchObject({ phase: 'ACTIVE', turnNumber: 2, entitlementRevision: 3 });
      const none = adv(live, pel([], 2)).state;
      const chosen = overrideTurn(none, { scope: sc(none), expectedVersion: none.version, expectedTurnNumber: none.turnNumber, target: { playerId: 'c' }, eligibility: pel(['c'], 3), now: 9 });
      expect(label(chosen.state)).toBe('c');
      expect(chosen.state.turnNumber).toBe(none.turnNumber + 1);
    });
  });
  it('close is terminal and idempotent at the current version; a closed sequence never reopens', () => {
    const live = started(playerSequence());
    const closed = closeTurnSequence(live, { scope: sc(live), expectedVersion: live.version });
    expect(closed.state).toMatchObject({ phase: 'CLOSED', version: live.version + 1, turnNumber: live.turnNumber, entitlementRevision: 2 });
    expect(currentTurnHolder(closed.state)).toBeNull();
    expect(closeTurnSequence(closed.state, { scope: sc(closed.state), expectedVersion: closed.state.version })).toMatchObject({ changed: false, transition: null });
    expect(codeOf(() => closeTurnSequence(closed.state, { scope: sc(closed.state), expectedVersion: live.version }))).toBe('TURN_SEQ_VERSION_STALE');
    expect(parseTurnSequenceState(clone(closed.state)).phase).toBe('CLOSED');
    const earlyClose = closeTurnSequence(playerSequence(), { scope: sc(playerSequence()), expectedVersion: 0 }).state;
    expect(earlyClose).toMatchObject({ phase: 'CLOSED', turnNumber: 0, position: null });
    expect(parseTurnSequenceState(clone(earlyClose))).toEqual(earlyClose);
  });
  it('rejects a foreign context for every operation: run, sequence, roster revision, unit and a malformed scope', () => {
    const s = started(playerSequence());
    for (const [name, scope, code] of [
      ['run', { ...sc(s), runIndex: 2 }, 'TURN_SEQ_RUN_STALE'], ['sequence', { ...sc(s), sequenceId: 'seq-2' }, 'TURN_SEQ_SEQUENCE_STALE'], ['roster', { ...sc(s), rosterRevision: 'roster-2' }, 'TURN_SEQ_ROSTER_STALE'],
      ['unit', { ...sc(s), unit: 'TEAM' }, 'TURN_SEQ_UNIT_MISMATCH'], ['malformed', { ...sc(s), runIndex: 0 }, 'TURN_SEQ_SCOPE_INVALID'], ['extra', { ...sc(s), roundId: 'r1' }, 'TURN_SEQ_SCOPE_INVALID'],
    ] as const) {
      expect(codeOf(() => adv(s, everyone(s), 'COMPLETE', { scope })), name).toBe(code);
      expect(codeOf(() => authorize(s, { scope })), name).toBe(code);
      expect(codeOf(() => projectTurnSequence({ role: 'VIEWER' }, s, { scope: scope as never, release: 'NONE', stateVersion: 1 })), name).toBe(code);
      expect(codeOf(() => closeTurnSequence(s, { scope: scope as never, expectedVersion: s.version })), name).toBe(code);
    }
  });
  it('rejects an eligibility of another track or roster revision, a malformed one, and one of the wrong unit', () => {
    const s = started(playerSequence(), pel(['a', 'b', 'c'], 3));
    const base = pel(['a', 'b', 'c'], 3);
    expect(codeOf(() => adv(s, { ...base, actors: { ...base.actors, trackId: 'other' } }))).toBe('TURN_SEQ_ELIGIBILITY_MISMATCH');
    expect(codeOf(() => adv(s, { ...base, actors: { ...base.actors, rosterRevision: 'other' } }))).toBe('TURN_SEQ_ELIGIBILITY_MISMATCH');
    expect(codeOf(() => adv(s, { ...base, actors: { ...base.actors, version: 2 } }))).toBe('TURN_SEQ_ELIGIBILITY_STALE');
    expect(adv(s, { ...base, actors: { ...base.actors, version: 3 } }).changed).toBe(true); // equal version = same stand
    for (const bad of [null, {}, { actors: base.actors }, { ...base, members: base.actors }, { ...base, extra: 1 }, { ...base, actors: { ...base.actors, activeIds: ['a', 'a'] } },
      { ...base, actors: { ...base.actors, activeIds: [1] } }, { ...base, actors: { ...base.actors, version: -1 } }, { ...base, actors: { ...base.actors, activeIds: new Array(101).fill('x').map((_, i) => `p${i}`) } }]) {
      expect(codeOf(() => adv(s, bad as never)), JSON.stringify(bad)?.slice(0, 40)).toBe('TURN_SEQ_ELIGIBILITY_INVALID');
    }
    const t = started(teamSequence());
    expect(codeOf(() => adv(t, pel(['T1', 'T2'], 2)))).toBe('TURN_SEQ_ELIGIBILITY_INVALID'); // a team sequence needs the member level too
  });
});

// ── E. Projection ────────────────────────────────────────────

describe('N8 E: projection through an explicit release', () => {
  const marker = { teams: [{ teamId: 'TEAM_RED', members: ['MBR_ONE', 'MBR_TWO'] }, { teamId: 'TEAM_BLUE', members: ['MBR_THREE', 'MBR_FOUR', 'MBR_FIVE'] }] };
  const audiences: Array<[string, ProjectionAudience]> = [
    ['holder', { role: 'PLAYER', participantId: 'MBR_ONE', teamId: 'TEAM_RED' }], ['teammate', { role: 'PLAYER', participantId: 'MBR_TWO', teamId: 'TEAM_RED' }],
    ['other team', { role: 'PLAYER', participantId: 'MBR_THREE', teamId: 'TEAM_BLUE' }], ['playing host', { role: 'PLAYER', participantId: 'MBR_ONE', teamId: 'TEAM_RED' }],
    ['host', { role: 'HOST', participantId: null }], ['blind host', { role: 'HOST', blindHost: true }], ['viewer', { role: 'VIEWER' }], ['display', { role: 'DISPLAY' }],
    ['player without ids', { role: 'PLAYER' }],
  ];
  const mid = () => {
    let s = started(prepareTurnSequence({ ...BASE, unit: 'TEAM', mode: 'FIXED', order: ['TEAM_RED', 'TEAM_BLUE'], teams: marker.teams }), tel(['TEAM_RED', 'TEAM_BLUE'], ['MBR_ONE', 'MBR_TWO', 'MBR_THREE', 'MBR_FOUR', 'MBR_FIVE'], 1));
    s = overrideTurn(s, { scope: sc(s), expectedVersion: s.version, expectedTurnNumber: s.turnNumber, target: { teamId: 'TEAM_RED', playerId: 'MBR_TWO' }, eligibility: tel(['TEAM_RED', 'TEAM_BLUE'], ['MBR_ONE', 'MBR_TWO', 'MBR_THREE', 'MBR_FOUR', 'MBR_FIVE'], 2), now: 1234, reason: 'PRIVATE_REASON_MARKER' }).state;
    return s;
  };
  it('NONE carries only the ordering counters; CURRENT adds state, holder and the caller\'s own view; ORDER adds the outer order — nothing else, per allowlist', () => {
    const s = mid();
    const key = (release: TurnSequenceRelease, audience: ProjectionAudience) => Object.keys(projectTurnSequence(audience, s, { scope: sc(s), release, stateVersion: 9 })).sort();
    const counters = ['contract', 'scope', 'stateVersion', 'sequenceVersion', 'turnNumber', 'entitlementRevision', 'release'];
    for (const [, audience] of audiences) {
      expect(key('NONE', audience)).toEqual([...counters].sort());
      expect(key('CURRENT', audience)).toEqual([...counters, 'status', 'current', 'you'].sort());
      expect(key('ORDER', audience)).toEqual([...counters, 'status', 'current', 'you', 'order'].sort());
    }
    expect(projectTurnSequence({ role: 'VIEWER' }, s, { scope: sc(s), release: 'ORDER', stateVersion: 9 })).toEqual({
      contract: 'TURN_SEQUENCE_STATUS_V1', scope: sc(s), stateVersion: 9, sequenceVersion: s.version, turnNumber: s.turnNumber, entitlementRevision: 1, release: 'ORDER',
      status: 'ACTIVE', current: { teamId: 'TEAM_RED', playerId: 'MBR_TWO' }, you: null, order: { actorIds: ['TEAM_RED', 'TEAM_BLUE'], position: 0, cycle: 0 },
    });
  });
  it('gives "you" only to a PLAYER through the existing visibility rules; the holder may act, a teammate only advises, others and every non-player get nothing', () => {
    const s = mid(); // MBR_TWO of TEAM_RED holds the turn
    const you = (audience: ProjectionAudience) => (projectTurnSequence(audience, s, { scope: sc(s), release: 'CURRENT', stateVersion: 3 }) as { you: unknown }).you;
    expect(you({ role: 'PLAYER', participantId: 'MBR_TWO', teamId: 'TEAM_RED' })).toEqual({ holdsTurn: true, teamHoldsTurn: true, canAct: true });
    expect(you({ role: 'PLAYER', participantId: 'MBR_ONE', teamId: 'TEAM_RED' })).toEqual({ holdsTurn: false, teamHoldsTurn: true, canAct: false });
    expect(you({ role: 'PLAYER', participantId: 'MBR_THREE', teamId: 'TEAM_BLUE' })).toEqual({ holdsTurn: false, teamHoldsTurn: false, canAct: false });
    expect(you({ role: 'PLAYER', participantId: 'MBR_TWO', teamId: 'TEAM_BLUE' })).toEqual({ holdsTurn: false, teamHoldsTurn: false, canAct: false }); // the id alone is no proof: the team must match too
    expect(you({ role: 'PLAYER', participantId: 'MBR_TWO', teamId: null })).toEqual({ holdsTurn: false, teamHoldsTurn: false, canAct: false });
    for (const audience of [{ role: 'HOST' as const }, { role: 'HOST' as const, blindHost: true }, { role: 'VIEWER' as const }, { role: 'DISPLAY' as const }, { role: 'PLAYER' as const }, { role: 'HOST' as const, participantId: 'MBR_TWO', teamId: 'TEAM_RED' }]) {
      expect(you(audience)).toBeNull();
    }
    const held = withholdCurrentHolder(s, { scope: sc(s), expectedVersion: s.version, expectedTurnNumber: s.turnNumber, eligibility: tel(['TEAM_RED', 'TEAM_BLUE'], ['MBR_ONE', 'MBR_THREE', 'MBR_FOUR', 'MBR_FIVE'], 3) }).state;
    const heldYou = projectTurnSequence({ role: 'PLAYER', participantId: 'MBR_TWO', teamId: 'TEAM_RED' }, held, { scope: sc(held), release: 'CURRENT', stateVersion: 4 }) as { you: { canAct: boolean; holdsTurn: boolean }; status: string };
    expect(heldYou).toMatchObject({ status: 'HELD', you: { holdsTurn: true, canAct: false } });
  });
  it('never serialises member lists, cursors, eligibility, override evidence or reasons — over 9 audiences × 3 releases × team and player sequences, also with other counters', () => {
    const sequences = [mid(), started(prepareTurnSequence({ ...BASE, unit: 'PLAYER', mode: 'FIXED', order: ['PLAYER_RED', 'PLAYER_BLUE', 'PLAYER_GREEN'] }), pel(['PLAYER_RED', 'PLAYER_BLUE', 'PLAYER_GREEN'], 1))];
    const forbidden = ['PRIVATE_REASON_MARKER', 'players-track', 'teams-track', 'members-track', 'track-roster-1', 'lastOverride', 'cursor', 'members', 'eligibility', 'completedTurns', 'memberIndex', 'atMs', 'teams"', 'reason'];
    for (const s of sequences) {
      for (const [name, audience] of audiences) for (const release of contract.TURN_SEQUENCE_RELEASES) {
        const text = JSON.stringify(projectTurnSequence(audience, s, { scope: sc(s), release, stateVersion: 1 }));
        for (const word of forbidden) expect(text, `${name}/${release}/${word}`).not.toContain(word);
        if (release !== 'ORDER' && s.unit === 'PLAYER') expect(text, `${name}/${release}`).not.toContain('PLAYER_GREEN'); // an unreleased order is not listed
        if (release === 'NONE') for (const id of ['MBR_', 'PLAYER_', 'TEAM_']) expect(text, `${name}/NONE/${id}`).not.toContain(id);
        if (s.unit === 'TEAM') for (const stranger of ['MBR_ONE', 'MBR_THREE', 'MBR_FOUR', 'MBR_FIVE']) expect(text, `${name}/${release}/${stranger}`).not.toContain(stranger); // only the holder (MBR_TWO) is ever named
      }
    }
    const orderText = JSON.stringify(projectTurnSequence({ role: 'VIEWER' }, sequences[0], { scope: sc(sequences[0]), release: 'ORDER', stateVersion: 1 }));
    expect(orderText).toContain('TEAM_BLUE'); // the outer order is released at ORDER and holds teams only
  });
  it('rejects a wrong release, audience, stateVersion and extra arguments with codes only; a foreign scope is stale, never "empty"', () => {
    const s = mid(); const scope = sc(s);
    const call = (audience: unknown, args: Record<string, unknown>) => () => projectTurnSequence(audience as never, s, { scope, release: 'CURRENT', stateVersion: 1, ...args } as never);
    expect(codeOf(call({ role: 'VIEWER' }, { release: undefined }))).toBe('TURN_SEQ_RELEASE_INVALID');
    for (const release of ['ALL', 'order', 3, null]) expect(codeOf(call({ role: 'VIEWER' }, { release })), String(release)).toBe('TURN_SEQ_RELEASE_INVALID');
    for (const audience of [null, {}, { role: 'ADMIN' }, { role: 'PLAYER', participantId: 5 }, { role: 'PLAYER', teamId: '' }, 'PLAYER']) expect(codeOf(call(audience, {})), JSON.stringify(audience)).toBe('TURN_SEQ_AUDIENCE_INVALID');
    for (const stateVersion of [-1, 1.5, NaN, '1', undefined, 2 ** 53]) expect(codeOf(call({ role: 'VIEWER' }, { stateVersion })), String(stateVersion)).toBe('TURN_SEQ_ARGS_INVALID');
    expect(codeOf(() => projectTurnSequence({ role: 'VIEWER' }, s, { scope, release: 'CURRENT', stateVersion: 1, extra: 1 } as never))).toBe('TURN_SEQ_ARGS_INVALID');
  });
  it('the client schema is strict at every level and refuses contradictory combinations', () => {
    const s = mid();
    const ok = projectTurnSequence({ role: 'PLAYER', participantId: 'MBR_TWO', teamId: 'TEAM_RED' }, s, { scope: sc(s), release: 'ORDER', stateVersion: 5 });
    expect(contract.parseTurnSequenceProjection(ok)).toEqual({ ok: true, projection: ok });
    const bad = (mutate: (draft: Draft) => void) => { const draft = clone(ok) as Draft; mutate(draft); return contract.parseTurnSequenceProjection(draft).ok; };
    expect(bad(() => undefined)).toBe(true);
    for (const [name, mutate] of Object.entries({
      'extra top': (d: Draft) => { d.members = []; }, 'extra scope': (d: Draft) => { d.scope.roundId = 'r'; }, 'extra current': (d: Draft) => { d.current.name = 'x'; }, 'extra you': (d: Draft) => { d.you.cursor = 1; },
      'extra order': (d: Draft) => { d.order.members = []; }, 'wrong contract': (d: Draft) => { d.contract = 'V2'; }, 'negative counter': (d: Draft) => { d.turnNumber = -1; }, 'float counter': (d: Draft) => { d.sequenceVersion = 1.5; },
      'huge counter': (d: Draft) => { d.entitlementRevision = 1e12; }, 'unknown status': (d: Draft) => { d.status = 'DONE'; }, 'ACTIVE without holder': (d: Draft) => { d.current = null; },
      'holder in READY': (d: Draft) => { d.status = 'READY'; }, 'team id in a player unit': (d: Draft) => { d.scope.unit = 'PLAYER'; d.you.teamHoldsTurn = null; },
      'canAct while HELD': (d: Draft) => { d.status = 'HELD'; }, 'canAct without holdsTurn': (d: Draft) => { d.you.holdsTurn = false; }, 'duplicate order': (d: Draft) => { d.order.actorIds = ['TEAM_RED', 'TEAM_RED']; },
      'position out of range': (d: Draft) => { d.order.position = 5; }, 'empty order': (d: Draft) => { d.order.actorIds = []; }, 'unknown release': (d: Draft) => { d.release = 'ALL'; },
      'NONE with a holder': (d: Draft) => { d.release = 'NONE'; }, 'turn 0 with holder': (d: Draft) => { d.turnNumber = 0; },
    })) expect(bad(mutate), name).toBe(false);
    expect(TurnSequenceProjectionSchema.safeParse(null).success).toBe(false);
    const none = projectTurnSequence({ role: 'VIEWER' }, s, { scope: sc(s), release: 'NONE', stateVersion: 0 });
    expect(contract.parseTurnSequenceProjection({ ...none, status: 'ACTIVE' }).ok).toBe(false);
    expect(contract.parseTurnSequenceProjection({ ...none, current: null }).ok).toBe(false);
    const parsed = contract.parseTurnSequenceProjection(ok);
    if (parsed.ok) {
      (parsed.projection as unknown as { order: { actorIds: string[] } }).order.actorIds.push('zz');
      expect((ok as unknown as { order: { actorIds: string[] } }).order.actorIds).toEqual(['TEAM_RED', 'TEAM_BLUE']);
    }
  });
  it('builds the context key from labels only and compares scope and the independent minimum', () => {
    const s = mid(); const scope = sc(s);
    const expected = { ...scope, recipientId: 'MBR_TWO', minStateVersion: 5 };
    const p = projectTurnSequence({ role: 'VIEWER' }, s, { scope, release: 'NONE', stateVersion: 5 });
    expect(contract.turnSequenceProjectionMatches(p, expected)).toBe(true);
    expect(contract.turnSequenceProjectionMatches(p, { ...expected, minStateVersion: 6 })).toBe(false);
    for (const change of [{ runIndex: 2 }, { sequenceId: 'x' }, { rosterRevision: 'x' }, { unit: 'PLAYER' as const }]) expect(contract.turnSequenceProjectionMatches(p, { ...expected, ...change })).toBe(false);
    expect(contract.turnSequenceContextKey(expected)).not.toBe(contract.turnSequenceContextKey({ ...expected, recipientId: null }));
    expect(contract.turnActionBindingKey({ turnNumber: 4, sequenceVersion: 9 })).not.toBe(contract.turnActionBindingKey({ turnNumber: 4, sequenceVersion: 10 }));
  });
});

// ── F. Recovery ──────────────────────────────────────────────

describe('N8 F: persistence, replay and damaged state', () => {
  const played = () => {
    let s = started(teamSequence(), tel(['T1', 'T2'], ALL_TEAM_MEMBERS, 1));
    for (let i = 0; i < 5; i++) s = adv(s, tel(['T1', 'T2'], ALL_TEAM_MEMBERS, 1 + i)).state;
    return overrideTurn(s, { scope: sc(s), expectedVersion: s.version, expectedTurnNumber: s.turnNumber, target: { teamId: 'T1', playerId: 'B' }, eligibility: tel(['T1', 'T2'], ALL_TEAM_MEMBERS, 9), now: 777, reason: 'x' }).state;
  };
  it('round-trips through JSON with the same holder, cursors, counters and configuration, and continues exactly like the original', () => {
    const original = played();
    const restored = parseTurnSequenceState(clone(original));
    expect(restored).toEqual(original);
    expect(restored).not.toBe(original);
    expect(restored.teams![0]).not.toBe(original.teams![0]);
    const elig = (n: number) => tel(['T1', 'T2'], ALL_TEAM_MEMBERS, 10 + n);
    let a = original, b = restored;
    for (let i = 0; i < 25; i++) { a = adv(a, elig(i)).state; b = adv(b, elig(i)).state; expect(b).toEqual(a); expect(label(b)).toBe(label(a)); }
    expect(restored.lastOverride).toEqual({ atMs: 777, fromTurnNumber: 6, toTurnNumber: 7 });
  });
  it('recovers through the SDK state event and replay without clock, randomness or an extra step', () => {
    const s0 = started(teamSequence());
    const s1 = adv(s0).state; const s2 = adv(s1).state; const s3 = adv(s2, everyone(s2, 2), 'SKIP').state;
    const snap = (value: TurnSequenceState, stateVersion: number): EngineStateSnapshot => ({ roomId: 'room-1', runIndex: 1, gameSlug: 'future-turns', engineVersion: 1, stateVersion, state: { turnSequence: value, scores: { A: 0 } } });
    const e = [s0, s1, s2, s3].slice(0, 3).map((from, i) => createStateEvent(snap(from, i), { turnSequence: [s1, s2, s3][i], scores: { A: 0 } }, { eventId: randomUUID(), type: 'TURN_CHANGED', commandId: `c${i}`, actorId: 'host', occurredAtMs: 1000 + i }));
    const clock = vi.spyOn(Date, 'now'), random = vi.spyOn(Math, 'random');
    try {
      const wire = JSON.parse(JSON.stringify(e));
      const replay = () => wire.reduce((snapshot: EngineStateSnapshot, event: unknown) => applyStateEvent(snapshot, event), snap(s0, 0)) as EngineStateSnapshot;
      const replayed = replay();
      expect(replay()).toEqual(replayed);
      expect(replayed.stateVersion).toBe(3);
      expect(parseTurnSequenceState(replayed.state.turnSequence)).toEqual(s3);
      expect(replayed.state.scores).toEqual({ A: 0 }); // replay writes no points
      expect(clock).not.toHaveBeenCalled(); expect(random).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); random.mockRestore(); }
    expect(label(s3)).toBe('T2/D'); // the SKIPPED T1/B completed nothing: the T1 cursor stays on B, the search goes on with T2's next member
    expect(s3.teams!.map(t => t.cursor)).toEqual([1, 1]);
    expect(s3.completedTurns).toBe(2);
  });
  it('a new "process" with only the stored JSON continues with the stored counters (no reset to player 1, no new draw, no extra advance)', () => {
    const shuffle = vi.fn((values: readonly string[]) => [...values].reverse());
    const decided = decideTurnOrder({ mode: 'RANDOM', ids: ['a', 'b', 'c'], shuffle: shuffle as never });
    const stored = JSON.stringify(walk(started(prepareTurnSequence({ ...BASE, unit: 'PLAYER', mode: 'RANDOM', order: decided.order })), 4).states[4]); // turn 5 → order [c,b,a]: c b a c b
    const afterRestart = parseTurnSequenceState(JSON.parse(stored));
    expect(label(afterRestart)).toBe('b');
    expect(afterRestart).toMatchObject({ turnNumber: 5, completedTurns: 4, cycle: 1, version: 5 });
    expect(label(adv(afterRestart).state)).toBe('a');
    expect(shuffle).toHaveBeenCalledTimes(1); // not at load, not at the next transition
    expect(parseTurnSequenceState(JSON.parse(JSON.stringify(closeTurnSequence(afterRestart, { scope: sc(afterRestart), expectedVersion: afterRestart.version }).state))).phase).toBe('CLOSED');
  });
  it('rejects every damaged state as a whole with TURN_SEQ_STATE_INVALID — nothing is repaired, clamped, reordered or restarted', () => {
    const good = played();
    const mutated = (mutate: (draft: Draft) => void) => () => { const d = clone(good) as Draft; mutate(d); return parseTurnSequenceState(d); };
    const cases: Record<string, (d: Draft) => void> = {
      'extra key': d => { d.winner = 'T1'; }, 'wrong kind': d => { d.kind = 'PARTICIPATION_TRACK'; }, 'schema 2': d => { d.schemaVersion = 2; }, 'unknown phase': d => { d.phase = 'PAUSED'; },
      'duplicate order': d => { d.order = ['T1', 'T1']; }, 'order/team mismatch': d => { d.order = ['T2', 'T1']; }, 'team missing': d => { d.teams.pop(); }, 'unit PLAYER with teams': d => { d.unit = 'PLAYER'; },
      'cursor out of range': d => { d.teams[0].cursor = 2; }, 'negative cursor': d => { d.teams[0].cursor = -1; }, 'member in two teams': d => { d.teams[1].members[0] = 'A'; }, 'empty team': d => { d.teams[0].members = []; },
      'position out of range': d => { d.position = 2; }, 'position null while ACTIVE': d => { d.position = null; }, 'memberIndex null in team mode': d => { d.memberIndex = null; }, 'memberIndex out of range': d => { d.memberIndex = 5; },
      'turn 0 while ACTIVE': d => { d.turnNumber = 0; }, 'completed > turns': d => { d.completedTurns = d.turnNumber + 1; }, 'negative version': d => { d.version = -1; }, 'float version': d => { d.version = 1.5; },
      'unsafe counter': d => { d.cycle = 2 ** 53; }, 'counter above bound': d => { d.version = 1_000_000_001; }, 'NaN-like': d => { d.version = null; }, 'string counter': d => { d.turnNumber = '3'; },
      'eligibility missing while ACTIVE': d => { d.eligibility = null; }, 'member level missing in team mode': d => { d.eligibility.members = null; },
      'override from >= to': d => { d.lastOverride.fromTurnNumber = 9; }, 'override beyond turn': d => { d.lastOverride.toTurnNumber = 99; },
      'NO_ELIGIBLE with member': d => { d.phase = 'NO_ELIGIBLE'; }, 'CLOSED with member': d => { d.phase = 'CLOSED'; },
      'READY but started': d => { d.phase = 'READY'; }, 'bad label': d => { d.sequenceId = 'a b'; }, 'run 0': d => { d.runIndex = 0; },
    };
    for (const [name, mutate] of Object.entries(cases)) expect(codeOf(mutated(mutate)), name).toBe('TURN_SEQ_STATE_INVALID');
    for (const garbage of [null, undefined, 'x', 3, [], {}, '{}', JSON.stringify(good)]) expect(codeOf(() => parseTurnSequenceState(garbage)), String(garbage)?.slice(0, 20)).toBe('TURN_SEQ_STATE_INVALID');
    expect(issuesOf(mutated(d => { d.order = Array.from({ length: 101 }, (_, i) => `t${i}`); }))).toEqual(['LIMIT_EXCEEDED']); // bound before any cross-comparison
    expect(issuesOf(mutated(d => { d.teams[0].members = Array.from({ length: 101 }, (_, i) => `m${i}`); }))).toEqual(['LIMIT_EXCEEDED']);
    expect(issuesOf(mutated(d => { d.teams[0].cursor = 9; }))).toContain('CURSOR_INVALID');
    expect(issuesOf(mutated(d => { d.order = ['T1', 'T1']; }))).toContain('ORDER_DUPLICATE');
    // every operation re-validates the stored state it receives
    const broken = clone(good) as Draft; broken.teams[0].cursor = 7;
    expect(codeOf(() => adv(broken as never))).toBe('TURN_SEQ_STATE_INVALID');
    expect(codeOf(() => projectTurnSequence({ role: 'VIEWER' }, broken, { scope: sc(good), release: 'NONE', stateVersion: 1 }))).toBe('TURN_SEQ_STATE_INVALID');
    expect(codeOf(() => closeTurnSequence(broken, { scope: sc(good), expectedVersion: good.version }))).toBe('TURN_SEQ_STATE_INVALID');
    expect(good).toEqual(played()); // the good one stayed untouched by all of the above
  });
  it('N6 and N8 states cannot be read as one another, and the existing CoreTurn is untouched', () => {
    const track = createParticipationTrack({ runIndex: 1, trackId: 'trk', rosterRevision: 'r1', actorKind: 'PARTICIPANT', config: { livesMode: 'OFF' }, actors: [{ actorId: 'a', lives: null }] });
    expect(codeOf(() => parseTurnSequenceState(track))).toBe('TURN_SEQ_STATE_INVALID');
    expect(() => parseParticipationTrackState(played())).toThrow('PARTICIPATION_STATE_INVALID');
    const core = createTurn(['a', 'b'], 'FIXED');
    expect(core).toEqual({ mode: 'FIXED', order: ['a', 'b'], index: 0, cycle: 0 });
    expect(advanceCoreTurn(advanceCoreTurn(core))).toEqual({ mode: 'FIXED', order: ['a', 'b'], index: 0, cycle: 1 });
  });
});

// ── Cross-cutting ────────────────────────────────────────────

describe('N8 contract surface', () => {
  it('has unique wire codes, all in the public whitelist, and thrown errors carry only a code (no ids, no values)', () => {
    expect(new Set(TURN_SEQUENCE_ERROR_CODES).size).toBe(TURN_SEQUENCE_ERROR_CODES.length);
    expect(new Set(contract.TURN_SEQUENCE_ISSUE_CODES).size).toBe(contract.TURN_SEQUENCE_ISSUE_CODES.length);
    for (const code of TURN_SEQUENCE_ERROR_CODES) { expect(code.startsWith('TURN_SEQ_')).toBe(true); expect(gameErrorCode(new Error(code))).toBe(code); }
    expect(gameErrorCode(new Error('TURN_OWNER_CONFLICT'))).toBe('TURN_OWNER_CONFLICT'); // the older single-owner code is untouched
    const s = started(teamSequence([{ teamId: 'MARK_TEAM', members: ['MARK_MEMBER'] }, { teamId: 'MARK_TEAM2', members: ['MARK_MEMBER2'] }]), tel(['MARK_TEAM', 'MARK_TEAM2'], ['MARK_MEMBER', 'MARK_MEMBER2'], 4));
    const attempts: Array<() => unknown> = [
      () => adv(s, tel(['MARK_TEAM'], ['MARK_MEMBER'], 3)), () => overrideTurn(s, { scope: sc(s), expectedVersion: s.version, expectedTurnNumber: s.turnNumber, target: { teamId: 'MARK_TEAM', playerId: 'MARK_OTHER' }, eligibility: everyone(s, 5), now: 1 }),
      () => parseTurnSequenceState({ ...s, teams: [{ teamId: 'MARK_TEAM', members: ['MARK_MEMBER', 'MARK_MEMBER'], cursor: 0 }] }), () => decideTurnOrder({ mode: 'CUSTOM_HOST_ORDER', ids: ['MARK_A'], customOrder: ['MARK_B'] }),
    ];
    for (const attempt of attempts) {
      try { attempt(); throw new Error('expected failure'); } catch (error) {
        expect(error).toBeInstanceOf(TurnSequenceError);
        const e = error as TurnSequenceError;
        expect(e.message).toBe(e.code);
        expect(`${e.message}${JSON.stringify(e.issues)}${e.stack?.split('\n')[0]}`).not.toContain('MARK_');
      }
    }
  });
  it('introduces no winner, revive, elimination, scoring or game-end API', () => {
    const names = [...Object.keys(domain), ...Object.keys(contract)];
    expect(names.filter(name => /winner|revive|eliminat|score|points|gameEnd|captain|defeat|loser|loss/i.test(name))).toEqual([]);
  });
});
