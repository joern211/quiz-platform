// ============================================================
// N11 — board and figures: domain tests (pure, no database). Everything below runs on an EXPLICIT TEST GEOMETRY (see GEOMETRY) — it is no platform preset
// and no game rule. Ids are not names. The shared CAS / receipt / SQLite proof is boardState.cas.integration.test.ts.
// ============================================================

import { describe, expect, it } from 'vitest';
import { BOARD_ERROR_CODES, BoardError, boardActionBindingKey, boardCapturableFields, boardGeometryIssues, parseBoardProjection, type BoardGeometry, type BoardMoveIntent } from '@quiz/shared/board';
import { DICE_CONFIG_SINGLE_D6, type DiceConfig } from '@quiz/shared/dice';
import {
  applyDecidedBoardMove, assertBoardConsistent, boardActionArgsFromIntent, legalBoardMoves, moveFigure, parseBoardState, prepareBoard, projectBoard, readBoardMoveIntent, type BoardPolicy, type BoardState,
} from './boardState.js';
import { closeDiceTurn, diceTurnScopeOf, openDiceTurn, rollDice, type DiceTurnState } from './diceTurn.js';
import {
  advanceTurnSequence, currentTurnHolder, parseTurnSequenceState, prepareTurnSequence, refreshEligibilityBasis, startTurnSequence, turnSequenceScopeOf, type TurnEligibility, type TurnSequenceState,
} from './turnSequence.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Draft = any;

const BASE = { runIndex: 1, sequenceId: 'seq-1', rosterRevision: 'roster-1' };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const deepFreeze = <T>(value: T): T => {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) { Object.freeze(value); for (const inner of Object.values(value)) deepFreeze(inner); }
  return value;
};
const codeOf = (fn: () => unknown): string => {
  try { fn(); } catch (error) { return (error as Error).message; }
  return 'NO_ERROR';
};
const issuesOf = (fn: () => unknown): string[] => {
  try { fn(); } catch (error) { return [...((error as BoardError).issues ?? [])]; }
  return [];
};

// ── TEST GEOMETRY (explicit configuration for the proofs, NOT a platform default) ─────────────
// a: sa t1 t2 t3 t4 ha     b: sb t3 t4 t5 t6 hb     the ring fields t3 and t4 are shared; capacity 1 on the ring, 2 on start and home fields.
const GEOMETRY: BoardGeometry = {
  fields: [
    { id: 'sa', capacity: 2 }, { id: 'sb', capacity: 2 }, { id: 't1', capacity: 1 }, { id: 't2', capacity: 1 }, { id: 't3', capacity: 1 }, { id: 't4', capacity: 1 },
    { id: 't5', capacity: 1 }, { id: 't6', capacity: 1 }, { id: 'ha', capacity: 2 }, { id: 'hb', capacity: 2 },
  ],
  routes: [
    { ownerId: 'a', route: ['sa', 't1', 't2', 't3', 't4', 'ha'] },
    { ownerId: 'b', route: ['sb', 't3', 't4', 't5', 't6', 'hb'] },
  ],
};
const FIGURES = [{ id: 'a1', ownerId: 'a' }, { id: 'a2', ownerId: 'a' }, { id: 'b1', ownerId: 'b' }, { id: 'b2', ownerId: 'b' }];
const ALLOW: BoardPolicy = { capture: 'ALLOWED' };
const FORBID: BoardPolicy = { capture: 'FORBIDDEN' };
const OPEN_GATE = { admitted: true, phaseOpen: true, paused: false };

const level = (activeIds: string[], version: number, trackId: string, knownIds: string[], runIndex = BASE.runIndex) => ({ runIndex, trackId, rosterRevision: 'track-roster-1', version, knownIds, activeIds });
const KNOWN_PLAYERS = ['a', 'b', 'c', 'd'];
const KNOWN_TEAMS = ['T1', 'T2'];
const KNOWN_MEMBERS = ['A', 'B', 'C', 'D'];
const pel = (actors: string[], version = 1): TurnEligibility => ({ actors: level(actors, version, 'players-track', KNOWN_PLAYERS), members: null });
const tel = (teams: string[], members: string[], version = 1): TurnEligibility => ({ actors: level(teams, version, 'teams-track', KNOWN_TEAMS), members: level(members, version, 'members-track', KNOWN_MEMBERS) });
const everyone = (seq: TurnSequenceState, version = 1): TurnEligibility => (seq.unit === 'PLAYER' ? pel(seq.order, version) : tel(seq.order, seq.teams!.flatMap(t => t.members), version));
const sc = (seq: TurnSequenceState) => turnSequenceScopeOf(seq);

interface World { seq: TurnSequenceState; dice: DiceTurnState; board: BoardState }
const playerSequence = (): TurnSequenceState => {
  const prepared = prepareTurnSequence({ ...BASE, unit: 'PLAYER', mode: 'FIXED', order: ['a', 'b', 'c'] });
  return startTurnSequence(prepared, { scope: sc(prepared), expectedVersion: 0, eligibility: pel(['a', 'b', 'c']) }).state;
};
const callerOf = (seq: TurnSequenceState) => { const h = currentTurnHolder(seq)!; return { role: 'PLAYER' as const, participantId: h.playerId, teamId: h.teamId }; };
const openDice = (seq: TurnSequenceState, diceId = 'dice-1') => openDiceTurn({ scope: sc(seq), diceId, config: DICE_CONFIG_SINGLE_D6, sequence: seq, expectedTurnNumber: seq.turnNumber });
/** a roll with a KNOWN face (the random source is replaced; the board never draws) */
const rollWith = (dice: DiceTurnState, seq: TurnSequenceState, face: number): DiceTurnState => rollDice(dice, {
  scope: sc(seq), diceId: dice.diceId, sequence: seq, expectedTurnNumber: seq.turnNumber, expectedSequenceVersion: seq.version, expectedVersion: dice.version, expectedRollCount: dice.rollCount,
  caller: callerOf(seq), gate: OPEN_GATE, eligibility: everyone(seq), source: () => face,
}).state;
/** Builds a world: the sequence, the dice of turn 1 rolled with `face`, and a board whose figures stand where `at` says (default: all on their start). */
function world(face: number, at: Record<string, string> = {}, geometry: BoardGeometry = GEOMETRY): World {
  const seq = playerSequence();
  const dice = rollWith(openDice(seq), seq, face);
  const fresh = prepareBoard({ scope: sc(seq), boardId: 'board-1', geometry, figures: FIGURES, sequence: seq });
  const board = parseBoardState({ ...fresh, figures: fresh.figures.map(f => ({ ...f, at: at[f.id] ?? f.at })) });
  return { seq, dice, board };
}
/** The intent a UI would send: the ORIGIN is what the client was shown, figure and target are its choice. */
const intentFor = (w: World, figureId: string, to: string, over: Draft = {}): BoardMoveIntent => ({
  scope: sc(w.seq), boardId: w.board.boardId, turnNumber: w.seq.turnNumber, sequenceVersion: w.seq.version, boardVersion: w.board.version,
  diceId: w.dice.diceId, diceVersion: w.dice.version, rollCount: w.dice.rollCount, figureId, to, ...over,
});
/** The stand-in of an adapter's last steps: validate the intent, take the ORIGIN from it, add only the trusted facts. */
function move(w: World, intent: unknown, over: Draft = {}, policy: BoardPolicy = ALLOW) {
  const parsed = readBoardMoveIntent(intent);
  return moveFigure(w.board, { ...boardActionArgsFromIntent(parsed), sequence: w.seq, dice: w.dice, caller: callerOf(w.seq), gate: OPEN_GATE, eligibility: everyone(w.seq), policy, ...over });
}
const positions = (state: BoardState) => Object.fromEntries(state.figures.map(f => [f.id, f.at]));

describe('N11 board: the narrow end-to-end case', () => {
  it('a rolls 3; the server derives the move; a1 goes sa → t3; the roll is spent; the sequence and the dice are untouched', () => {
    const w = deepFreeze(world(3));
    const result = move(w, intentFor(w, 'a1', 't3'));
    expect(result.changed).toBe(true);
    expect(positions(result.state)).toEqual({ a1: 't3', a2: 'sa', b1: 'sb', b2: 'sb' });
    expect(result.state.version).toBe(1);
    expect(result.state.lastMove).toEqual({ figureId: 'a1', from: 'sa', to: 't3', captured: [], steps: 3, diceId: 'dice-1', rollCount: 1, turnNumber: 1 });
    expect(result.transition).toMatchObject({ versionBefore: 0, versionAfter: 1, steps: 3 });
    expect(result.sequenceBasisAdvanced).toBe(false);
    expect(w.board.version).toBe(0); // the input was not mutated (frozen)
    // the stored state survives a JSON round trip exactly (recovery reads nothing else)
    expect(parseBoardState(JSON.parse(JSON.stringify(result.state)))).toEqual(result.state);
  });
});

describe('N11 board: positive paths', () => {
  it('capture is an ATOMIC state change: mover on the target, victim back on ITS start, one version step; FORBIDDEN refuses the same intent', () => {
    const w = world(3, { b1: 't3' });
    const result = move(w, intentFor(w, 'a1', 't3'), {}, ALLOW);
    expect(positions(result.state)).toEqual({ a1: 't3', a2: 'sa', b1: 'sb', b2: 'sb' });
    expect(result.state.lastMove).toMatchObject({ figureId: 'a1', captured: ['b1'] });
    expect(result.state.version).toBe(1);
    expect(codeOf(() => move(w, intentFor(w, 'a1', 't3'), {}, FORBID))).toBe('BOARD_TARGET_ILLEGAL');
  });
  it('an own figure on a full target is no target, also under ALLOWED', () => {
    const w = world(3, { a2: 't3' });
    expect(codeOf(() => move(w, intentFor(w, 'a1', 't3')))).toBe('BOARD_TARGET_ILLEGAL');
    expect(legalBoardMoves(w.board, { ownerId: 'a', steps: 3, policy: ALLOW })).toEqual([]); // a1 is blocked by its own a2, a2 (on t3) would overshoot the home field
  });
  it('only ring fields are capturable: never a start or a home field, whatever the policy', () => {
    expect([...boardCapturableFields(GEOMETRY)].sort()).toEqual(['t1', 't2', 't3', 't4', 't5', 't6']);
  });
  it('reaching the HOME field is an ordinary move; a figure at home has no move; overshooting is no move (no platform rule)', () => {
    const exact = world(1, { a1: 't4' });
    expect(move(exact, intentFor(exact, 'a1', 'ha')).state.figures.find(f => f.id === 'a1')!.at).toBe('ha');
    const direct = world(5);
    expect(move(direct, intentFor(direct, 'a1', 'ha')).state.figures.find(f => f.id === 'a1')!.at).toBe('ha');
    const over = world(2, { a1: 't4' });
    expect(codeOf(() => move(over, intentFor(over, 'a1', 'ha')))).toBe('BOARD_TARGET_ILLEGAL');
    const home = world(1, { a1: 'ha' });
    expect(legalBoardMoves(home.board, { ownerId: 'a', steps: 1, policy: ALLOW }).some(m => m.figureId === 'a1')).toBe(false);
    expect(codeOf(() => move(home, intentFor(home, 'a1', 'ha')))).toBe('BOARD_TARGET_ILLEGAL');
  });
  it('NO legal target: nothing changes, the roll is NOT spent and the dice state stays exactly as it was', () => {
    const w = world(6);
    expect(legalBoardMoves(w.board, { ownerId: 'a', steps: 6, policy: ALLOW })).toEqual([]);
    for (const figure of ['a1', 'a2']) for (const to of ['ha', 't4', 'sa']) expect(codeOf(() => move(w, intentFor(w, figure, to)))).toBe('BOARD_TARGET_ILLEGAL');
    expect(w.dice.rollCount).toBe(1);
    expect(w.board.lastMove).toBeNull();
  });
  it('two DIFFERENT figures of the same player: each needs its own roll; the same roll never moves the second one', () => {
    const w = world(2);
    const first = move(w, intentFor(w, 'a1', 't2'));
    const afterFirst: World = { ...w, board: first.state };
    // the second figure with the SAME roll — bound to the new board version, so only the spent roll can refuse it
    expect(codeOf(() => move(afterFirst, intentFor(afterFirst, 'a2', 't2')))).toBe('BOARD_ROLL_SPENT');
    expect(codeOf(() => move(afterFirst, intentFor(afterFirst, 'a2', 't2'), {}, FORBID))).toBe('BOARD_ROLL_SPENT');
    // the intent still bound to board version 0 is stale at the board version first
    expect(codeOf(() => move(afterFirst, intentFor(w, 'a2', 't2')))).toBe('BOARD_VERSION_STALE');
    expect(positions(afterFirst.board)).toEqual({ a1: 't2', a2: 'sa', b1: 'sb', b2: 'sb' });
  });
  it('a NEW turn of the same person: a new process, a new roll — the old intent stays refused, the new one works and the board keeps its figures', () => {
    let w = world(2);
    w = { ...w, board: move(w, intentFor(w, 'a1', 't2')).state };
    const old = intentFor(w, 'a2', 't2');
    // the consumer's turn change: N8 advance ×3 (a → b → c → a), the old dice closes, a new one opens (one process per turn)
    let seq = w.seq;
    let dice = w.dice;
    for (let i = 0; i < 3; i++) {
      seq = advanceTurnSequence(seq, { scope: sc(seq), expectedVersion: seq.version, expectedTurnNumber: seq.turnNumber, outcome: 'COMPLETE', eligibility: everyone(seq) }).state;
      dice = closeDiceTurn(dice, { scope: diceTurnScopeOf(dice), diceId: dice.diceId, expectedTurnNumber: dice.binding.turnNumber, expectedVersion: dice.version }).state;
      dice = openDice(seq, `dice-t${seq.turnNumber}`);
    }
    expect(seq.turnNumber).toBe(4);
    dice = rollWith(dice, seq, 1);
    const next: World = { seq, dice, board: w.board };
    expect(codeOf(() => move(next, old))).toBe('TURN_SEQ_VERSION_STALE');
    expect(codeOf(() => move(next, { ...old, sequenceVersion: seq.version }))).toBe('TURN_SEQ_TURN_STALE');
    expect(codeOf(() => move(next, { ...intentFor(next, 'a2', 't1'), turnNumber: 1 }))).toBe('TURN_SEQ_TURN_STALE');
    expect(codeOf(() => move(next, { ...intentFor(next, 'a2', 't1'), diceId: 'dice-1' }))).toBe('BOARD_SCOPE_STALE'); // the old process id with fresh counters
    const done = move(next, intentFor(next, 'a2', 't1'));
    expect(positions(done.state)).toEqual({ a1: 't2', a2: 't1', b1: 'sb', b2: 'sb' });
    expect(done.state.version).toBe(2);
  });
});

describe('N11 board: foreign and stale actors / states', () => {
  const w = world(3);
  it('a foreign figure, a viewer / host / display, a non-holder, a paused or closed phase, a withdrawn participation', () => {
    expect(codeOf(() => move(w, intentFor(w, 'b1', 't3')))).toBe('BOARD_FIGURE_NOT_OWNED'); // a holds the turn, b1 is b's figure (the move would even be legal for b's steps)
    for (const role of ['VIEWER', 'DISPLAY', 'HOST']) expect(codeOf(() => move(w, intentFor(w, 'a1', 't3'), { caller: { role, participantId: 'a', teamId: null } }))).toBe('TURN_SEQ_ROLE_NOT_ALLOWED');
    expect(codeOf(() => move(w, intentFor(w, 'a1', 't3'), { caller: { role: 'PLAYER', participantId: 'b', teamId: null } }))).toBe('TURN_SEQ_NOT_CURRENT_ACTOR');
    expect(codeOf(() => move(w, intentFor(w, 'a1', 't3'), { gate: { ...OPEN_GATE, paused: true } }))).toBe('TURN_SEQ_ACTION_BLOCKED');
    expect(codeOf(() => move(w, intentFor(w, 'a1', 't3'), { gate: { ...OPEN_GATE, phaseOpen: false } }))).toBe('TURN_SEQ_ACTION_BLOCKED');
    expect(codeOf(() => move(w, intentFor(w, 'a1', 't3'), { gate: { ...OPEN_GATE, admitted: false } }))).toBe('TURN_SEQ_ACTION_BLOCKED');
    expect(codeOf(() => move(w, intentFor(w, 'a1', 't3'), { eligibility: pel(['b', 'c'], 2) }))).toBe('TURN_SEQ_ACTOR_NOT_ELIGIBLE');
    // no right is derived from client data: an intent that claims an owner / holder / flags is refused as a shape error
    for (const extra of [{ ownerId: 'a' }, { canMove: true }, { steps: 3 }, { captured: ['b1'] }, { resetTo: 'sb' }, { roll: 3 }, { holder: 'a' }]) {
      expect(codeOf(() => readBoardMoveIntent({ ...intentFor(w, 'a1', 't3'), ...extra }))).toBe('BOARD_ARGS_INVALID');
    }
  });
  it('another board, another run / sequence / roster / unit with the SAME local counters, another dice process', () => {
    const intent = intentFor(w, 'a1', 't3');
    expect(codeOf(() => move(w, { ...intent, boardId: 'board-2' }))).toBe('BOARD_SCOPE_STALE');
    expect(codeOf(() => move(w, { ...intent, diceId: 'dice-9' }))).toBe('BOARD_SCOPE_STALE');
    expect(codeOf(() => move(w, { ...intent, scope: { ...intent.scope, runIndex: 2 } }))).toBe('TURN_SEQ_RUN_STALE');
    expect(codeOf(() => move(w, { ...intent, scope: { ...intent.scope, sequenceId: 'seq-2' } }))).toBe('TURN_SEQ_SEQUENCE_STALE');
    expect(codeOf(() => move(w, { ...intent, scope: { ...intent.scope, rosterRevision: 'roster-2' } }))).toBe('TURN_SEQ_ROSTER_STALE');
    expect(codeOf(() => move(w, { ...intent, scope: { ...intent.scope, unit: 'TEAM' } }))).toBe('TURN_SEQ_UNIT_MISMATCH');
  });
  it('a LATE FIRST-TIME intent of an old board: the loaded state has the same counters, but a different board / run — no receipt is needed to refuse it', () => {
    // two worlds with identical counters; the intent was made for world 1, the server loads world 2 (another board id, then another run)
    const old = intentFor(w, 'a1', 't3');
    const otherBoard = { ...w, board: parseBoardState({ ...w.board, boardId: 'board-2' }) };
    expect(codeOf(() => move(otherBoard, old))).toBe('BOARD_SCOPE_STALE');
    const seq2 = (() => { const p = prepareTurnSequence({ ...BASE, runIndex: 2, unit: 'PLAYER', mode: 'FIXED', order: ['a', 'b', 'c'] }); return startTurnSequence(p, { scope: sc(p), expectedVersion: 0, eligibility: { actors: level(['a', 'b', 'c'], 1, 'players-track', KNOWN_PLAYERS, 2), members: null } }).state; })();
    const dice2 = rollDice(openDice(seq2), { scope: sc(seq2), diceId: 'dice-1', sequence: seq2, expectedTurnNumber: 1, expectedSequenceVersion: seq2.version, expectedVersion: 0, expectedRollCount: 0, caller: callerOf(seq2), gate: OPEN_GATE, eligibility: { actors: level(['a', 'b', 'c'], 1, 'players-track', KNOWN_PLAYERS, 2), members: null }, source: () => 3 }).state;
    const board2 = prepareBoard({ scope: sc(seq2), boardId: 'board-1', geometry: GEOMETRY, figures: FIGURES, sequence: seq2 });
    expect(codeOf(() => moveFigure(board2, { ...boardActionArgsFromIntent(readBoardMoveIntent(old)), sequence: seq2, dice: dice2, caller: callerOf(seq2), gate: OPEN_GATE, eligibility: { actors: level(['a', 'b', 'c'], 1, 'players-track', KNOWN_PLAYERS, 2), members: null }, policy: ALLOW }))).toBe('TURN_SEQ_RUN_STALE');
  });
  it('an old roll: another dice version / roll number, and a dice state of an earlier turn handed in by a forgetful adapter', () => {
    expect(codeOf(() => move(w, intentFor(w, 'a1', 't3', { diceVersion: 0 })))).toBe('BOARD_ROLL_STALE');
    expect(codeOf(() => move(w, intentFor(w, 'a1', 't3', { rollCount: 2 })))).toBe('BOARD_ROLL_STALE');
    const seq2 = advanceTurnSequence(w.seq, { scope: sc(w.seq), expectedVersion: w.seq.version, expectedTurnNumber: 1, outcome: 'COMPLETE', eligibility: everyone(w.seq) }).state;
    const forgetful: World = { seq: seq2, dice: w.dice, board: w.board }; // N8 moved on, the old dice process was never replaced
    const b = { ...intentFor(forgetful, 'b1', 't3'), diceId: w.dice.diceId, diceVersion: w.dice.version, rollCount: w.dice.rollCount };
    expect(codeOf(() => move(forgetful, b))).toBe('BOARD_TURN_STALE');
    const closed = closeDiceTurn(w.dice, { scope: diceTurnScopeOf(w.dice), diceId: w.dice.diceId, expectedTurnNumber: 1, expectedVersion: w.dice.version }).state;
    expect(codeOf(() => move({ ...w, dice: closed }, intentFor(w, 'a1', 't3')))).toBe('BOARD_NO_ROLL');
  });
  it('missing, partial or mixed version data is a shape error — never completed from the loaded state', () => {
    const intent = intentFor(w, 'a1', 't3') as Draft;
    for (const key of Object.keys(intent)) {
      const copy = clone(intent);
      delete copy[key];
      expect(codeOf(() => readBoardMoveIntent(copy)), key).toBe('BOARD_ARGS_INVALID');
    }
    for (const key of ['runIndex', 'sequenceId', 'rosterRevision', 'unit']) {
      const copy = clone(intent);
      delete copy.scope[key];
      expect(codeOf(() => readBoardMoveIntent(copy)), key).toBe('BOARD_ARGS_INVALID');
    }
    for (const bad of [{ turnNumber: 0 }, { rollCount: 0 }, { boardVersion: -1 }, { boardVersion: 1.5 }, { sequenceVersion: '1' }, { diceVersion: null }, { to: '' }, { figureId: 'a b' }]) {
      expect(codeOf(() => readBoardMoveIntent({ ...intent, ...bad }))).toBe('BOARD_ARGS_INVALID');
    }
    expect(codeOf(() => moveFigure(w.board, { ...boardActionArgsFromIntent(intent), sequence: w.seq, caller: callerOf(w.seq), gate: OPEN_GATE, eligibility: everyone(w.seq), policy: ALLOW } as Draft))).toBe('BOARD_ARGS_INVALID'); // dice missing
    expect(codeOf(() => move(w, intent, { policy: undefined }))).toBe('BOARD_POLICY_INVALID');
    expect(codeOf(() => move(w, intent, {}, { capture: 'MAYBE' } as Draft))).toBe('BOARD_POLICY_INVALID');
    expect(codeOf(() => move(w, intent, {}, {} as Draft))).toBe('BOARD_POLICY_INVALID');
  });
  it('the unit mismatch / owners that are no actors of the sequence are refused', () => {
    const foreignOwners = parseBoardState({ ...w.board, geometry: { ...w.board.geometry, routes: [{ ownerId: 'a', route: GEOMETRY.routes[0].route }, { ownerId: 'zz', route: GEOMETRY.routes[1].route }] }, figures: w.board.figures.map(f => (f.ownerId === 'b' ? { ...f, ownerId: 'zz' } : f)) });
    expect(codeOf(() => move({ ...w, board: foreignOwners }, intentFor(w, 'a1', 't3')))).toBe('BOARD_SCOPE_STALE');
    expect(issuesOf(() => prepareBoard({ scope: sc(w.seq), boardId: 'x', geometry: { ...GEOMETRY, routes: [{ ownerId: 'a', route: GEOMETRY.routes[0].route }, { ownerId: 'zz', route: GEOMETRY.routes[1].route }] }, figures: [{ id: 'a1', ownerId: 'a' }, { id: 'z1', ownerId: 'zz' }], sequence: w.seq }))).toContain('FIGURE_OWNER_UNKNOWN');
  });
});

describe('N11 board: versions, N8 base progress and reserved steps', () => {
  it('a BASIS update without a move changes neither board nor dice, but makes the old binding stale; a move with a NEWER N6 stand reports that the basis step is owed', () => {
    const w = world(3);
    const newer = pel(['a', 'b', 'c'], 2);
    const basis = refreshEligibilityBasis(w.seq, { scope: sc(w.seq), expectedVersion: w.seq.version, eligibility: newer });
    expect(basis.changed).toBe(true);
    expect(basis.state.version).toBe(w.seq.version + 1);
    const afterBasis: World = { ...w, seq: basis.state };
    expect(afterBasis.board).toEqual(w.board);
    expect(codeOf(() => move(afterBasis, intentFor(w, 'a1', 't3'), { eligibility: newer }))).toBe('TURN_SEQ_VERSION_STALE');
    const fresh = move(afterBasis, intentFor(afterBasis, 'a1', 't3'), { eligibility: newer });
    expect(fresh.sequenceBasisAdvanced).toBe(false);
    // the move itself saw a newer stand than the committed basis → the consumer owes refreshEligibilityBasis in the same commit
    const owed = move(w, intentFor(w, 'a1', 't3'), { eligibility: newer });
    expect(owed.sequenceBasisAdvanced).toBe(true);
    expect(owed.state.version).toBe(1);
  });
  it('an exhausted counter is refused BEFORE any change: board version at the limit; N8 sequence version at the limit when the basis step is owed', () => {
    const w = world(3);
    const moved = move(w, intentFor(w, 'a1', 't3')).state; // version 1, spent roll = dice-1 / 1
    const maxed = parseBoardState({ ...moved, version: 1_000_000_000 });
    // a LATER turn with its own process and an unspent roll (one process per turn — a second process in turn 1 would itself be a damaged history)
    const seq2 = advanceTurnSequence(w.seq, { scope: sc(w.seq), expectedVersion: w.seq.version, expectedTurnNumber: 1, outcome: 'COMPLETE', eligibility: everyone(w.seq) }).state;
    const dice2 = rollWith(openDice(seq2, 'dice-2'), seq2, 1);
    const w2: World = { seq: seq2, dice: dice2, board: maxed };
    expect(codeOf(() => move(w2, intentFor(w2, 'b1', 't3'), { caller: { role: 'PLAYER', participantId: 'b', teamId: null } }))).toBe('BOARD_COUNTER_LIMIT');
    expect(w2.board.version).toBe(1_000_000_000);
    // one step below the limit still works (the boundary is exact)
    const below: World = { ...w2, board: parseBoardState({ ...moved, version: 999_999_999 }) };
    expect(move(below, intentFor(below, 'b1', 't3'), { caller: { role: 'PLAYER', participantId: 'b', teamId: null } }).state.version).toBe(1_000_000_000);
    // the N8 counter: with a NEWER N6 stand the basis step is owed and needs room; without it the move needs none
    const full = world(3);
    const seqMax = parseTurnSequenceState({ ...full.seq, version: 1_000_000_000 });
    const atMax: World = { ...full, seq: seqMax };
    const newer = pel(['a', 'b', 'c'], 2);
    expect(codeOf(() => move(atMax, intentFor(atMax, 'a1', 't3'), { eligibility: newer }))).toBe('BOARD_COUNTER_LIMIT');
    expect(move(atMax, intentFor(atMax, 'a1', 't3')).sequenceBasisAdvanced).toBe(false);
    // RESERVE (second review, same pattern as N10-04): the owed basis step must not consume the LAST step the engine needs to end the turn (advanceTurnSequence needs +1 as well)
    const nearMax = (version: number): World => { const seqN = parseTurnSequenceState({ ...full.seq, version }); return { ...full, seq: seqN }; };
    const oneBelow = nearMax(999_999_999);
    expect(codeOf(() => move(oneBelow, intentFor(oneBelow, 'a1', 't3'), { eligibility: newer }))).toBe('BOARD_COUNTER_LIMIT'); // basis step to MAX would leave nothing for the turn end
    expect(move(oneBelow, intentFor(oneBelow, 'a1', 't3')).state.version).toBe(1); // no basis owed: no sequence step at all
    const twoBelow = nearMax(999_999_998);
    const fits = move(twoBelow, intentFor(twoBelow, 'a1', 't3'), { eligibility: newer });
    expect(fits.sequenceBasisAdvanced).toBe(true);
    // both owed steps really fit, one after the other: the basis step to MAX-1 and then the turn end to MAX
    const refreshed = refreshEligibilityBasis(twoBelow.seq, { scope: sc(twoBelow.seq), expectedVersion: twoBelow.seq.version, eligibility: newer }).state;
    expect(advanceTurnSequence(refreshed, { scope: sc(refreshed), expectedVersion: refreshed.version, expectedTurnNumber: 1, outcome: 'COMPLETE', eligibility: newer }).state.version).toBe(1_000_000_000);
  });
});

describe('N11 board: damaged and impossible states are refused as a whole', () => {
  const w = world(3);
  const base = clone(w.board) as Draft;
  const cases: Array<[string, (s: Draft) => void, string[]]> = [
    ['duplicate figure id', s => { s.figures[1].id = 'a1'; }, ['FIGURE_DUPLICATE']],
    ['unknown owner', s => { s.figures[0].ownerId = 'zz'; }, ['FIGURE_OWNER_UNKNOWN']],
    ['figure on a field outside its route', s => { s.figures[0].at = 't6'; }, ['FIGURE_POSITION_INVALID']],
    ['figure on an unknown field', s => { s.figures[0].at = 'nowhere'; }, ['FIGURE_POSITION_INVALID']],
    ['ring field over capacity', s => { s.figures[0].at = 't3'; s.figures[2].at = 't3'; }, ['CAPACITY_EXCEEDED']],
    ['owner without a figure', s => { s.figures = s.figures.filter((f: Draft) => f.ownerId !== 'b'); }, ['OWNER_WITHOUT_FIGURE']],
    ['start cannot hold the owner\'s figures', s => { s.geometry.fields[0].capacity = 1; }, ['START_CAPACITY']],
    ['version without a last move', s => { s.version = 1; }, ['COUNTER_CONFLICT']],
    ['last move without a version', s => { s.lastMove = { figureId: 'a1', from: 'sa', to: 't1', captured: [], steps: 1, diceId: 'd', rollCount: 1, turnNumber: 1 }; }, ['COUNTER_CONFLICT']],
    ['last move names a figure that is not on its target', s => { s.version = 1; s.lastMove = { figureId: 'a1', from: 'sa', to: 't1', captured: [], steps: 1, diceId: 'd', rollCount: 1, turnNumber: 1 }; }, ['LASTMOVE_CONFLICT']],
    ['unknown field of the state', s => { s.extra = 1; }, []],
    ['figure with an extra key', s => { s.figures[0].hp = 3; }, []],
    ['wrong kind', s => { s.kind = 'DICE_TURN'; }, []],
    ['wrong schema version', s => { s.schemaVersion = 2; }, []],
    ['negative version', s => { s.version = -1; }, []],
    ['fractional run', s => { s.runIndex = 1.5; }, []],
    ['route over a field that does not exist', s => { s.geometry.routes[0].route[1] = 'tx'; }, ['ROUTE_FIELD_UNKNOWN']],
    ['field no route uses', s => { s.geometry.fields.push({ id: 'tz', capacity: 1 }); }, ['FIELD_UNUSED']],
    ['two owners with the same start', s => { s.geometry.routes[1].route[0] = 'sa'; }, ['START_SHARED']],
    ['duplicate field id', s => { s.geometry.fields[3].id = 't1'; }, ['FIELD_DUPLICATE']],
    ['route that revisits a field', s => { s.geometry.routes[0].route.splice(2, 0, 't1'); }, ['ROUTE_FIELD_DUPLICATE']],
    ['home field of one owner on another route', s => { s.geometry.routes[1].route.splice(2, 0, 'ha'); }, ['ROUTE_HOME_CONFLICT']],
    ['start field of one owner on another route', s => { s.geometry.routes[1].route.splice(2, 0, 'sa'); }, ['ROUTE_START_CONFLICT']],
    ['duplicate owner route', s => { s.geometry.routes[1].ownerId = 'a'; }, ['ROUTE_OWNER_DUPLICATE']],
    ['too many figures', s => { s.figures = Array.from({ length: 25 }, (_, i) => ({ id: `f${i}`, ownerId: 'a', at: 'sa' })); }, ['LIMIT_EXCEEDED']],
  ];
  for (const [name, mutate, expectedIssues] of cases) {
    it(`refused: ${name}`, () => {
      const copy = clone(base);
      mutate(copy);
      expect(codeOf(() => parseBoardState(copy))).toBe('BOARD_STATE_INVALID');
      if (expectedIssues.length) expect(issuesOf(() => parseBoardState(copy))).toEqual(expect.arrayContaining(expectedIssues));
      // the damaged state also stops every operation that loads it — nothing is repaired on the way
      expect(codeOf(() => moveFigure(copy, { ...boardActionArgsFromIntent(intentFor(w, 'a1', 't3')), sequence: w.seq, dice: w.dice, caller: callerOf(w.seq), gate: OPEN_GATE, eligibility: everyone(w.seq), policy: ALLOW }))).toBe('BOARD_STATE_INVALID');
    });
  }
  it('prepare refuses a bad configuration with code-only issues and never corrects it', () => {
    const seq = w.seq;
    const ok = { scope: sc(seq), boardId: 'b', geometry: GEOMETRY, figures: FIGURES, sequence: seq };
    expect(codeOf(() => prepareBoard(ok))).toBe('NO_ERROR');
    expect(codeOf(() => prepareBoard({ ...ok, figures: [...FIGURES, { id: 'a1', ownerId: 'a' }] }))).toBe('BOARD_CONFIG_INVALID');
    expect(codeOf(() => prepareBoard({ ...ok, figures: [{ id: 'a1', ownerId: 'q' }] }))).toBe('BOARD_CONFIG_INVALID');
    expect(codeOf(() => prepareBoard({ ...ok, figures: FIGURES.filter(f => f.ownerId === 'a') }))).toBe('BOARD_CONFIG_INVALID'); // b has a route but no figure
    expect(codeOf(() => prepareBoard({ ...ok, geometry: { ...GEOMETRY, fields: [] } as Draft }))).toBe('BOARD_CONFIG_INVALID');
    expect(codeOf(() => prepareBoard({ ...ok, geometry: { ...GEOMETRY, extra: 1 } as Draft }))).toBe('BOARD_CONFIG_INVALID');
    expect(codeOf(() => prepareBoard({ ...ok, scope: { ...sc(seq), runIndex: 2 } }))).toBe('BOARD_SCOPE_STALE');
    expect(codeOf(() => prepareBoard({ ...ok, boardId: 'not valid!' }))).toBe('BOARD_ARGS_INVALID');
    expect(boardGeometryIssues(GEOMETRY)).toEqual([]);
    for (const code of Object.values(BOARD_ERROR_CODES)) expect(typeof code).toBe('string');
  });
});

describe('N11 board: the pure transition', () => {
  it('re-derives and re-checks the target at apply time: a decided result that does not equal the derived one is refused, nothing is repaired', () => {
    const w = world(3, { b1: 't3' });
    const ok = { expectedVersion: 0, ownerId: 'a', figureId: 'a1', to: 't3', captured: ['b1'], steps: 3, policy: ALLOW, roll: { diceId: 'dice-1', rollCount: 1, turnNumber: 1 } };
    expect(codeOf(() => applyDecidedBoardMove(w.board, ok))).toBe('NO_ERROR');
    expect(codeOf(() => applyDecidedBoardMove(w.board, { ...ok, captured: [] }))).toBe('BOARD_RESULT_INVALID'); // a capture without its reset
    expect(codeOf(() => applyDecidedBoardMove(w.board, { ...ok, captured: ['b2'] }))).toBe('BOARD_RESULT_INVALID');
    expect(codeOf(() => applyDecidedBoardMove(w.board, { ...ok, steps: 2 }))).toBe('BOARD_TARGET_ILLEGAL');
    expect(codeOf(() => applyDecidedBoardMove(w.board, { ...ok, to: 't4' }))).toBe('BOARD_TARGET_ILLEGAL');
    expect(codeOf(() => applyDecidedBoardMove(w.board, { ...ok, ownerId: 'b' }))).toBe('BOARD_FIGURE_NOT_OWNED');
    expect(codeOf(() => applyDecidedBoardMove(w.board, { ...ok, figureId: 'zz' }))).toBe('BOARD_FIGURE_UNKNOWN');
    expect(codeOf(() => applyDecidedBoardMove(w.board, { ...ok, expectedVersion: 1 }))).toBe('BOARD_VERSION_STALE');
    expect(codeOf(() => applyDecidedBoardMove(w.board, { ...ok, policy: FORBID }))).toBe('BOARD_TARGET_ILLEGAL');
    expect(codeOf(() => applyDecidedBoardMove(w.board, { ...ok, steps: 0 }))).toBe('BOARD_ARGS_INVALID');
    expect(codeOf(() => applyDecidedBoardMove(w.board, { ...ok, extra: 1 } as Draft))).toBe('BOARD_ARGS_INVALID');
    const once = applyDecidedBoardMove(w.board, ok);
    expect(codeOf(() => applyDecidedBoardMove(once.state, { ...ok, expectedVersion: 1, figureId: 'a2', to: 't3', captured: [] }))).toBe('BOARD_ROLL_SPENT');
    expect(applyDecidedBoardMove(w.board, ok)).toEqual(once); // deterministic: no random source, no clock
  });
  it('the board draws nothing and reads no clock', () => {
    const random = Math.random;
    const now = Date.now;
    Math.random = () => { throw new Error('RANDOM_USED'); };
    Date.now = () => { throw new Error('CLOCK_USED'); };
    try {
      const w = world(3, { b1: 't3' });
      expect(move(w, intentFor(w, 'a1', 't3')).state.version).toBe(1);
      projectBoard({ role: 'PLAYER', participantId: 'a', teamId: null }, w.board, { scope: sc(w.seq), sequence: w.seq, dice: w.dice, policy: ALLOW, release: 'FIGURES', stateVersion: 5 });
    } finally { Math.random = random; Date.now = now; }
  });
  it('a capture on a field with capacity 2: coexisting is not capturing; only a FULL field of foreign figures is captured, all of them', () => {
    const geometry: BoardGeometry = { ...GEOMETRY, fields: GEOMETRY.fields.map(f => (f.id === 't3' ? { ...f, capacity: 2 } : f)) };
    const coexist = world(3, { b1: 't3' }, geometry);
    expect(move(coexist, intentFor(coexist, 'a1', 't3')).state.lastMove!.captured).toEqual([]);
    const full = world(3, { b1: 't3', b2: 't3' }, geometry);
    const result = move(full, intentFor(full, 'a1', 't3'));
    expect(result.state.lastMove!.captured).toEqual(['b1', 'b2']);
    expect(positions(result.state)).toEqual({ a1: 't3', a2: 'sa', b1: 'sb', b2: 'sb' });
  });
});

describe('N11 board: team mode — the owner is the TEAM, the responsible member acts', () => {
  const TEAMS = [{ teamId: 'T1', members: ['A', 'B'] }, { teamId: 'T2', members: ['C', 'D'] }];
  const geometry: BoardGeometry = { fields: [{ id: 's1', capacity: 1 }, { id: 'r1', capacity: 1 }, { id: 'r2', capacity: 1 }, { id: 'h1', capacity: 1 }, { id: 's2', capacity: 1 }, { id: 'h2', capacity: 1 }],
    routes: [{ ownerId: 'T1', route: ['s1', 'r1', 'r2', 'h1'] }, { ownerId: 'T2', route: ['s2', 'r1', 'r2', 'h2'] }] };
  const build = () => {
    const prepared = prepareTurnSequence({ ...BASE, unit: 'TEAM', mode: 'FIXED', order: ['T1', 'T2'], teams: TEAMS });
    const seq = startTurnSequence(prepared, { scope: sc(prepared), expectedVersion: 0, eligibility: tel(['T1', 'T2'], ['A', 'B', 'C', 'D']) }).state;
    const holder = currentTurnHolder(seq)!;
    const caller = { role: 'PLAYER' as const, participantId: holder.playerId, teamId: holder.teamId };
    const dice = rollDice(openDice(seq), { scope: sc(seq), diceId: 'dice-1', sequence: seq, expectedTurnNumber: 1, expectedSequenceVersion: seq.version, expectedVersion: 0, expectedRollCount: 0, caller, gate: OPEN_GATE, eligibility: everyone(seq), source: () => 1 }).state;
    const board = prepareBoard({ scope: sc(seq), boardId: 'board-t', geometry, figures: [{ id: 'x1', ownerId: 'T1' }, { id: 'y1', ownerId: 'T2' }], sequence: seq });
    return { seq, dice, board, caller };
  };
  it('the responsible member of the holding team moves the TEAM\'s figure; a team mate or the other team cannot', () => {
    const { seq, dice, board, caller } = build();
    const intent = { scope: sc(seq), boardId: 'board-t', turnNumber: 1, sequenceVersion: seq.version, boardVersion: 0, diceId: 'dice-1', diceVersion: dice.version, rollCount: 1, figureId: 'x1', to: 'r1' };
    const args = (who: Draft) => ({ ...boardActionArgsFromIntent(readBoardMoveIntent(intent)), sequence: seq, dice, caller: who, gate: OPEN_GATE, eligibility: everyone(seq), policy: ALLOW });
    expect(moveFigure(board, args(caller)).state.figures.find(f => f.id === 'x1')!.at).toBe('r1');
    expect(codeOf(() => moveFigure(board, args({ role: 'PLAYER', participantId: 'B', teamId: 'T1' })))).toBe('TURN_SEQ_NOT_CURRENT_ACTOR'); // advises only
    expect(codeOf(() => moveFigure(board, args({ role: 'PLAYER', participantId: 'C', teamId: 'T2' })))).toBe('TURN_SEQ_NOT_CURRENT_ACTOR');
    expect(codeOf(() => moveFigure(board, args({ role: 'PLAYER', participantId: 'A', teamId: 'T2' })))).toBe('TURN_SEQ_NOT_CURRENT_ACTOR'); // a self-chosen team id
    expect(codeOf(() => moveFigure(board, { ...args(caller), ...{ figureId: 'y1' } }))).toBe('BOARD_FIGURE_NOT_OWNED');
  });
});

describe('N11 board: projections', () => {
  const w = world(3, { b1: 't3' });
  const project = (audience: Draft, over: Draft = {}) => projectBoard(audience, w.board, { scope: sc(w.seq), sequence: w.seq, dice: w.dice, policy: ALLOW, release: 'FIGURES', stateVersion: 7, ...over });
  it('the holder gets the server-offered targets; every other audience gets none and no `you`', () => {
    const holder = project({ role: 'PLAYER', participantId: 'a', teamId: null });
    expect(holder.release).toBe('FIGURES');
    if (holder.release !== 'FIGURES') return;
    expect(holder.you).toEqual({ holdsTurn: true, teamHoldsTurn: null, canMove: true });
    expect(holder.recipientId).toBe('a');
    expect(holder.roll).toEqual({ diceId: 'dice-1', diceVersion: 1, rollCount: 1, steps: 3, spent: false });
    expect(holder.targets).toEqual([{ figureId: 'a1', to: 't3', captures: ['b1'] }, { figureId: 'a2', to: 't3', captures: ['b1'] }]);
    for (const audience of [{ role: 'PLAYER', participantId: 'b', teamId: null }, { role: 'PLAYER', participantId: 'c', teamId: null }, { role: 'VIEWER' }, { role: 'DISPLAY' }, { role: 'HOST' }]) {
      const p = project(audience);
      if (p.release !== 'FIGURES') throw new Error('expected FIGURES');
      expect(p.targets).toEqual([]);
      if (audience.role === 'PLAYER') expect(p.you).toMatchObject({ holdsTurn: false, canMove: false }); else expect(p.you).toBeNull();
      expect(p.recipientId).toBe(audience.role === 'PLAYER' ? audience.participantId : null);
    }
  });
  it('release NONE carries no geometry, figure, roll or target; the packet validates as a client projection and is a fresh copy', () => {
    const none = project({ role: 'PLAYER', participantId: 'a', teamId: null }, { release: 'NONE' });
    expect(Object.keys(none).sort()).toEqual(['boardId', 'boardVersion', 'contract', 'recipientId', 'release', 'scope', 'sequenceVersion', 'stateVersion', 'turnNumber']);
    const full = project({ role: 'PLAYER', participantId: 'a', teamId: null });
    expect(parseBoardProjection(JSON.parse(JSON.stringify(full)))).toMatchObject({ ok: true });
    const text = JSON.stringify(full);
    for (const secret of ['password', 'session', 'eligibility', 'knownIds', 'activeIds', 'order', 'cursor', 'seed']) expect(text).not.toContain(secret);
  });
  it('after a move the roll is shown as spent and NO target is offered; a dice state of a moved-on turn yields no roll', () => {
    const moved = move(w, intentFor(w, 'a1', 't3')).state;
    const p = projectBoard({ role: 'PLAYER', participantId: 'a', teamId: null }, moved, { scope: sc(w.seq), sequence: w.seq, dice: w.dice, policy: ALLOW, release: 'FIGURES', stateVersion: 8 });
    if (p.release !== 'FIGURES') throw new Error('expected FIGURES');
    expect(p.roll).toMatchObject({ spent: true });
    expect(p.targets).toEqual([]);
    expect(p.you).toMatchObject({ holdsTurn: true, canMove: false });
    expect(p.lastMove).toMatchObject({ figureId: 'a1', captured: ['b1'] });
    const seq2 = advanceTurnSequence(w.seq, { scope: sc(w.seq), expectedVersion: w.seq.version, expectedTurnNumber: 1, outcome: 'COMPLETE', eligibility: everyone(w.seq) }).state;
    const later = projectBoard({ role: 'PLAYER', participantId: 'a', teamId: null }, moved, { scope: sc(seq2), sequence: seq2, dice: w.dice, policy: ALLOW, release: 'FIGURES', stateVersion: 9 });
    if (later.release !== 'FIGURES') throw new Error('expected FIGURES');
    expect(later.roll).toBeNull();
    expect(later.targets).toEqual([]);
    expect(later.you).toMatchObject({ holdsTurn: false, canMove: false });
    expect(later.turnNumber).toBe(2);
  });
  it('malformed audience / release / scope / stale scope are code-only errors', () => {
    expect(codeOf(() => project({ role: 'ADMIN' }))).toBe('BOARD_AUDIENCE_INVALID');
    expect(codeOf(() => project({ role: 'PLAYER', participantId: '' , teamId: 5 }))).toBe('BOARD_AUDIENCE_INVALID');
    expect(codeOf(() => project({ role: 'VIEWER' }, { release: 'ALL' }))).toBe('BOARD_RELEASE_INVALID');
    expect(codeOf(() => project({ role: 'VIEWER' }, { release: undefined }))).toBe('BOARD_RELEASE_INVALID');
    expect(codeOf(() => project({ role: 'VIEWER' }, { scope: { ...sc(w.seq), runIndex: 2 } }))).toBe('BOARD_SCOPE_STALE');
    expect(codeOf(() => project({ role: 'VIEWER' }, { stateVersion: -1 }))).toBe('BOARD_ARGS_INVALID');
    expect(codeOf(() => project({ role: 'VIEWER' }, { policy: undefined }))).toBe('BOARD_POLICY_INVALID');
  });
  it('the binding key separates every part of the origin but NOT figure or target (two alternative targets share one lock)', () => {
    const i = intentFor(w, 'a1', 't3');
    const key = boardActionBindingKey(i);
    expect(boardActionBindingKey({ ...i, figureId: 'a2', to: 't4' } as Draft)).toBe(key);
    const variants: Draft[] = [
      { scope: { ...i.scope, runIndex: 2 } }, { scope: { ...i.scope, sequenceId: 'x' } }, { scope: { ...i.scope, rosterRevision: 'x' } }, { scope: { ...i.scope, unit: 'TEAM' } },
      { boardId: 'x' }, { turnNumber: 2 }, { sequenceVersion: 9 }, { boardVersion: 9 }, { diceId: 'x' }, { diceVersion: 9 }, { rollCount: 9 },
    ];
    for (const v of variants) expect(boardActionBindingKey({ ...i, ...v }), JSON.stringify(v)).not.toBe(key);
  });
});

// ── N11-01 (independent review PR #41): a contradictory last move must not survive recovery ─────────────────────────────────────────────────────────────
describe('N11-01 recovery: the last move must be explainable by the state, and board, N8 and N9 must fit together', () => {
  const capturing = () => { const w = world(3, { b1: 't3' }); return { w, moved: move(w, intentFor(w, 'a1', 't3')).state }; };
  const plain = () => { const w = world(3); return { w, moved: move(w, intentFor(w, 'a1', 't3')).state }; };
  const lastMoveOf = (state: BoardState, over: Draft) => ({ ...clone(state), lastMove: { ...state.lastMove!, ...over } });

  it('loading refuses a last move whose steps contradict the route distance (also every other wrong number)', () => {
    const { moved } = plain(); // a1: sa → t3 is 3 route steps
    for (const steps of [1, 2, 4, 5, 200]) expect(issuesOf(() => parseBoardState(lastMoveOf(moved, { steps }))), String(steps)).toContain('LASTMOVE_CONFLICT');
    expect(codeOf(() => parseBoardState(lastMoveOf(moved, { steps: 3 })))).toBe('NO_ERROR'); // positive control: the true distance
  });
  it('loading refuses a last move that does not run forward on the mover\'s route, or does not start on it', () => {
    const { moved } = plain();
    for (const over of [{ from: 't3' }, { from: 'ha' }, { from: 't6', steps: 1 }, { from: 'nowhere' }, { from: 't2' }]) { // equal to the target, behind it, on the other owner's route only, unknown, right place but the old step count
      expect(codeOf(() => parseBoardState(lastMoveOf(moved, over))), JSON.stringify(over)).toBe('BOARD_STATE_INVALID');
    }
    expect(codeOf(() => parseBoardState(lastMoveOf(moved, { from: 't2', steps: 1 })))).toBe('NO_ERROR'); // t2 → t3 is a consistent claim for the same final position
  });
  const captureCorruptions: Array<[string, (s: Draft) => void]> = [
    ['a capture claimed on a field whose capacity is not the number of captured figures', s => { s.lastMove.captured = ['b1', 'b2']; }],
    ['a capture claimed on a HOME field (ha: exclusive to a, never capturable, not on the victim\'s route; the step count itself is consistent)', s => { s.lastMove.from = 't3'; s.lastMove.to = 'ha'; s.lastMove.steps = 2; s.lastMove.captured = ['b1', 'b2']; s.figures.find((f: Draft) => f.id === 'a1').at = 'ha'; }],
    ['the captured figure belongs to the mover\'s own owner', s => { s.lastMove.captured = ['a2']; }],
    ['the captured figure does not stand on its start (it stands on another field of its own route)', s => { s.figures.find((f: Draft) => f.id === 'b1').at = 't4'; }],
    ['the same figure captured twice', s => { s.lastMove.captured = ['b1', 'b1']; }],
    ['an unknown figure captured', s => { s.lastMove.captured = ['zz']; }],
  ];
  it.each(captureCorruptions)('loading refuses: %s', (_name, mutate) => {
    const { moved } = capturing();
    const damaged = clone(moved) as Draft;
    mutate(damaged);
    expect(codeOf(() => parseBoardState(damaged))).toBe('BOARD_STATE_INVALID');
  });
  it('a claimed capture on a field that only ONE owner has on its route is refused (victim could never have stood there)', () => {
    // t1 lies on a\'s route only: a b-figure can never have been captured there
    const w = world(1);
    const moved = move(w, intentFor(w, 'a1', 't1')).state;
    const damaged = { ...clone(moved), lastMove: { ...moved.lastMove!, captured: ['b1'] } } as Draft;
    damaged.figures.find((f: Draft) => f.id === 'b1').at = 'sb';
    expect(issuesOf(() => parseBoardState(damaged))).toContain('LASTMOVE_CONFLICT');
  });

  it('a spent-roll marker for a roll the SAME process has not made yet is refused at the move, never treated as an unused roll', () => {
    const { w, moved } = plain();
    const damaged = lastMoveOf(moved, { diceId: w.dice.diceId, rollCount: w.dice.rollCount + 1 });
    const parsed = parseBoardState(damaged); // locally consistent — the contradiction only exists together with the dice
    const world2: World = { ...w, board: parsed };
    expect(codeOf(() => move(world2, { ...intentFor(world2, 'a1', 't4') }))).toBe('BOARD_STATE_INVALID');
    expect(codeOf(() => assertBoardConsistent(parsed, w.seq, w.dice))).toBe('BOARD_STATE_INVALID');
    expect(issuesOf(() => assertBoardConsistent(parsed, w.seq, w.dice))).toEqual(['LASTMOVE_CONFLICT']);
    for (const release of ['FIGURES', 'NONE'] as const) {
      expect(codeOf(() => projectBoard({ role: 'PLAYER', participantId: 'a', teamId: null }, parsed, { scope: sc(w.seq), sequence: w.seq, dice: w.dice, policy: ALLOW, release, stateVersion: 3 })), release).toBe('BOARD_STATE_INVALID');
    }
  });
  it('a marker that names this dice process but another turn than the process belongs to is refused', () => {
    const { w, moved } = plain();
    const parsed = parseBoardState(lastMoveOf(moved, { turnNumber: 1 })); // positive control first: the real turn
    expect(codeOf(() => assertBoardConsistent(parsed, w.seq, w.dice))).toBe('NO_ERROR');
    const seq3 = (() => { let q = w.seq; for (let i = 0; i < 2; i++) q = advanceTurnSequence(q, { scope: sc(q), expectedVersion: q.version, expectedTurnNumber: q.turnNumber, outcome: 'COMPLETE', eligibility: everyone(q) }).state; return q; })();
    const claimed = parseBoardState(lastMoveOf(moved, { turnNumber: 2 })); // turn 2 is reached by the sequence, but the process dice-1 belongs to turn 1
    expect(codeOf(() => assertBoardConsistent(claimed, seq3, w.dice))).toBe('BOARD_STATE_INVALID');
  });
  it('a marker of THIS turn that names ANOTHER dice process is refused (one process per turn): the current roll must not look unspent', () => {
    const { w, moved } = plain();
    const swapped = parseBoardState(lastMoveOf(moved, { diceId: 'dice-other' })); // locally consistent; the roll the move really used is now "forgotten"
    const damaged: World = { ...w, board: swapped };
    expect(codeOf(() => assertBoardConsistent(swapped, w.seq, w.dice))).toBe('BOARD_STATE_INVALID');
    expect(codeOf(() => move(damaged, intentFor(damaged, 'a1', 't4')))).toBe('BOARD_STATE_INVALID');
    expect(codeOf(() => projectBoard({ role: 'VIEWER' }, swapped, { scope: sc(w.seq), sequence: w.seq, dice: w.dice, policy: ALLOW, release: 'NONE', stateVersion: 3 }))).toBe('BOARD_STATE_INVALID');
    // positive control: the same marker is fine when the supplied process belongs to ANOTHER turn (an older history)
    const seq2 = advanceTurnSequence(w.seq, { scope: sc(w.seq), expectedVersion: w.seq.version, expectedTurnNumber: 1, outcome: 'COMPLETE', eligibility: everyone(w.seq) }).state;
    expect(codeOf(() => assertBoardConsistent(swapped, seq2, rollWith(openDice(seq2, 'dice-2'), seq2, 2)))).toBe('NO_ERROR');
  });
  it('a recovered board claiming a move from a turn the bound N8 sequence has not reached is refused by projection (every release) and by the move', () => {
    const { w, moved } = plain();
    const future = parseBoardState(lastMoveOf(moved, { turnNumber: w.seq.turnNumber + 1 }));
    const audiences = [{ role: 'VIEWER' }, { role: 'DISPLAY' }, { role: 'HOST' }, { role: 'PLAYER', participantId: 'a', teamId: null }, { role: 'PLAYER', participantId: 'b', teamId: null }];
    for (const audience of audiences) for (const release of ['FIGURES', 'NONE'] as const) {
      expect(codeOf(() => projectBoard(audience as Draft, future, { scope: sc(w.seq), sequence: w.seq, dice: null, policy: ALLOW, release, stateVersion: 3 })), `${audience.role}/${release}`).toBe('BOARD_STATE_INVALID');
    }
    const next = world(1);
    expect(codeOf(() => move({ ...next, board: future }, intentFor({ ...next, board: future }, 'a2', 't1')))).toBe('BOARD_STATE_INVALID');
  });
  it('the refusal changes nothing: the input is not mutated and no state, roll or sequence is returned', () => {
    const { w, moved } = plain();
    const damaged = deepFreeze(parseBoardState(lastMoveOf(moved, { rollCount: w.dice.rollCount + 1, diceId: w.dice.diceId })));
    const frozen = deepFreeze({ ...w, board: damaged });
    const before = JSON.stringify(frozen);
    expect(codeOf(() => move(frozen, intentFor(frozen, 'a2', 't1')))).toBe('BOARD_STATE_INVALID');
    expect(JSON.stringify(frozen)).toBe(before);
  });
  it('the check runs AFTER the N8 authorisation: a caller who may not act learns the N8 reason, not the damage', () => {
    const { w, moved } = plain();
    const damaged = parseBoardState(lastMoveOf(moved, { turnNumber: w.seq.turnNumber + 1 }));
    expect(codeOf(() => move({ ...w, board: damaged }, intentFor({ ...w, board: damaged }, 'a2', 't1'), { caller: { role: 'PLAYER', participantId: 'b', teamId: null } }))).toBe('TURN_SEQ_NOT_CURRENT_ACTOR');
    expect(codeOf(() => move({ ...w, board: damaged }, intentFor({ ...w, board: damaged }, 'a2', 't1'), { gate: { ...OPEN_GATE, paused: true } }))).toBe('TURN_SEQ_ACTION_BLOCKED');
  });

  describe('positive controls: regular histories stay valid', () => {
    const TWO_ROLLS: DiceConfig = { diceCount: 1, sides: 6, maxRolls: 2, holdAllowed: false };
    it('a NEWER roll of the same process (same turn) after an older, spent one is usable; the old roll stays spent', () => {
      const seq = playerSequence();
      const opened = openDiceTurn({ scope: sc(seq), diceId: 'dice-1', config: TWO_ROLLS, sequence: seq, expectedTurnNumber: 1 });
      const first = rollWith(opened, seq, 1);
      const board0 = prepareBoard({ scope: sc(seq), boardId: 'board-1', geometry: GEOMETRY, figures: FIGURES, sequence: seq });
      const w1: World = { seq, dice: first, board: board0 };
      const afterFirst = move(w1, intentFor(w1, 'a1', 't1')).state;
      expect(afterFirst.lastMove).toMatchObject({ rollCount: 1, diceId: 'dice-1' });
      const second = rollWith(first, seq, 2);
      expect(second.rollCount).toBe(2);
      const w2: World = { seq, dice: second, board: afterFirst };
      expect(codeOf(() => assertBoardConsistent(afterFirst, seq, second))).toBe('NO_ERROR');
      const view = projectBoard({ role: 'PLAYER', participantId: 'a', teamId: null }, afterFirst, { scope: sc(seq), sequence: seq, dice: second, policy: ALLOW, release: 'FIGURES', stateVersion: 6 });
      if (view.release !== 'FIGURES') throw new Error('expected FIGURES');
      expect(view.roll).toMatchObject({ rollCount: 2, steps: 2, spent: false });
      expect(view.targets.length).toBeGreaterThan(0);
      const afterSecond = move(w2, intentFor(w2, 'a2', 't2'));
      expect(afterSecond.state.lastMove).toMatchObject({ rollCount: 2, diceId: 'dice-1', figureId: 'a2' });
      expect(afterSecond.state.version).toBe(2);
      // the older roll can neither be replayed against the newer marker nor spent again
      expect(codeOf(() => applyDecidedBoardMove(afterSecond.state, { expectedVersion: 2, ownerId: 'a', figureId: 'a1', to: 't3', captured: [], steps: 2, policy: ALLOW, roll: { diceId: 'dice-1', rollCount: 1, turnNumber: 1 } }))).toBe('BOARD_ROLL_SPENT');
    });
    it('a LATER turn with a NEW process is valid with the marker of the earlier turn (the same person and another person)', () => {
      const { w, moved } = plain();
      let seq = w.seq;
      let dice = w.dice;
      for (let i = 0; i < 3; i++) {
        seq = advanceTurnSequence(seq, { scope: sc(seq), expectedVersion: seq.version, expectedTurnNumber: seq.turnNumber, outcome: 'COMPLETE', eligibility: everyone(seq) }).state;
        dice = closeDiceTurn(dice, { scope: diceTurnScopeOf(dice), diceId: dice.diceId, expectedTurnNumber: dice.binding.turnNumber, expectedVersion: dice.version }).state;
        dice = openDice(seq, `dice-t${seq.turnNumber}`);
        expect(codeOf(() => assertBoardConsistent(moved, seq, dice)), `turn ${seq.turnNumber} (no roll yet)`).toBe('NO_ERROR');
      }
      dice = rollWith(dice, seq, 1);
      expect(move({ seq, dice, board: moved }, intentFor({ seq, dice, board: moved }, 'a2', 't1')).state.version).toBe(2);
    });
    it('regular moves, captures and home moves survive a JSON round trip; the damaged-state checks do not reject any of them', () => {
      const normal = world(3);
      const normalMoved = move(normal, intentFor(normal, 'a1', 't3')).state;
      const capture = world(3, { b1: 't3' });
      const captured = move(capture, intentFor(capture, 'a1', 't3')).state;
      const full = world(3, { b1: 't3', b2: 't3' }, { ...GEOMETRY, fields: GEOMETRY.fields.map(f => (f.id === 't3' ? { ...f, capacity: 2 } : f)) });
      const double = move(full, intentFor(full, 'a1', 't3')).state;
      const home = world(1, { a1: 't4' });
      const homed = move(home, intentFor(home, 'a1', 'ha')).state;
      const direct = world(5);
      const homedDirect = move(direct, intentFor(direct, 'a1', 'ha')).state;
      for (const state of [normalMoved, captured, double, homed, homedDirect]) {
        expect(parseBoardState(JSON.parse(JSON.stringify(state)))).toEqual(state);
      }
      expect(double.lastMove!.captured).toEqual(['b1', 'b2']);
      expect(homedDirect.lastMove).toMatchObject({ from: 'sa', to: 'ha', steps: 5 });
      // and the client projection of each of them validates
      for (const [state, w] of [[captured, capture], [homedDirect, direct]] as const) {
        const view = projectBoard({ role: 'VIEWER' }, state, { scope: sc(w.seq), sequence: w.seq, dice: w.dice, policy: ALLOW, release: 'FIGURES', stateVersion: 8 });
        expect(parseBoardProjection(JSON.parse(JSON.stringify(view))).ok).toBe(true);
      }
    });
    it('the client projection schema refuses a contradictory last move too (steps, capture on a protected field)', () => {
      const { w, moved } = capturing();
      const good = JSON.parse(JSON.stringify(projectBoard({ role: 'VIEWER' }, moved, { scope: sc(w.seq), sequence: w.seq, dice: w.dice, policy: ALLOW, release: 'FIGURES', stateVersion: 8 })));
      expect(parseBoardProjection(good).ok).toBe(true);
      expect(parseBoardProjection({ ...good, lastMove: { ...good.lastMove, steps: 1 } }).ok).toBe(false);
      expect(parseBoardProjection({ ...good, lastMove: { ...good.lastMove, captured: ['b1', 'b2'] } }).ok).toBe(false);
    });
  });
});
