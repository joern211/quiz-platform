// INDEPENDENT REVIEW PROBES (PR #41, 06.11.2026), adopted unchanged as regression tests for N11-01.
import { describe, expect, it } from 'vitest';
import { prepareTurnSequence, startTurnSequence } from './turnSequence.js';
import { prepareBoard, moveFigure, parseBoardState, projectBoard } from './boardState.js';
import { openDiceTurn, rollDice } from './diceTurn.js';
import { DICE_CONFIG_SINGLE_D6 } from '@quiz/shared/dice';
const scope = { runIndex: 1, sequenceId: 'seq', rosterRevision: 'roster', unit: 'PLAYER' as const };
const eligibility = { actors: { runIndex: 1, trackId: 'players', rosterRevision: 'players-r', version: 1, knownIds: ['a', 'b'], activeIds: ['a', 'b'] }, members: null };
function fixture(face = 3) {
  const fresh = prepareTurnSequence({ ...scope, mode: 'FIXED', order: ['a', 'b'] });
  const sequence = startTurnSequence(fresh, { scope, expectedVersion: 0, eligibility }).state;
  const board = prepareBoard({ scope, boardId: 'board', sequence, geometry: {
    fields: [{ id: 'sa', capacity: 2 }, { id: 'sb', capacity: 2 }, { id: 't1', capacity: 1 }, { id: 't2', capacity: 1 }, { id: 't3', capacity: 1 }, { id: 'ha', capacity: 2 }, { id: 'hb', capacity: 2 }],
    routes: [{ ownerId: 'a', route: ['sa', 't1', 't2', 't3', 'ha'] }, { ownerId: 'b', route: ['sb', 't3', 't2', 't1', 'hb'] }],
  }, figures: [{ id: 'a1', ownerId: 'a' }, { id: 'a2', ownerId: 'a' }, { id: 'b1', ownerId: 'b' }] });
  const opened = openDiceTurn({ scope, diceId: 'dice', sequence, expectedTurnNumber: sequence.turnNumber, config: DICE_CONFIG_SINGLE_D6 });
  const dice = rollDice(opened, { scope, diceId: 'dice', sequence, expectedTurnNumber: sequence.turnNumber, expectedSequenceVersion: sequence.version, expectedVersion: 0, expectedRollCount: 0, caller: { role: 'PLAYER', participantId: 'a', teamId: null }, gate: { admitted: true, phaseOpen: true, paused: false }, eligibility, source: () => face }).state;
  const moved = moveFigure(board, { scope, boardId: 'board', diceId: 'dice', expectedTurnNumber: sequence.turnNumber, expectedSequenceVersion: sequence.version, expectedBoardVersion: board.version, expectedDiceVersion: dice.version, expectedRollCount: dice.rollCount, figureId: 'a1', to: face === 1 ? 't1' : 't3', sequence, dice, caller: { role: 'PLAYER', participantId: 'a', teamId: null }, gate: { admitted: true, phaseOpen: true, paused: false }, eligibility, policy: { capture: 'ALLOWED' } }).state;
  return { sequence, board: moved, dice };
}
describe('independent N11 recovery counterprobes', () => {
  it('rejects a future consumed roll before the current stored roll can move the same figure twice', () => {
    const { board, sequence, dice } = fixture(1);
    const corrupted = { ...board, lastMove: { ...board.lastMove!, rollCount: dice.rollCount + 1 } };
    expect(() => moveFigure(corrupted, { scope, boardId: board.boardId, diceId: dice.diceId, expectedTurnNumber: sequence.turnNumber, expectedSequenceVersion: sequence.version, expectedBoardVersion: board.version, expectedDiceVersion: dice.version, expectedRollCount: dice.rollCount, figureId: 'a1', to: 't2', sequence, dice, caller: { role: 'PLAYER', participantId: 'a', teamId: null }, gate: { admitted: true, phaseOpen: true, paused: false }, eligibility, policy: { capture: 'ALLOWED' } })).toThrow('BOARD_STATE_INVALID');
  });
  it('rejects a last move whose steps contradict the route distance', () => {
    const { board } = fixture();
    const corrupted = { ...board, lastMove: { ...board.lastMove!, steps: 1 } };
    expect(() => parseBoardState(corrupted)).toThrow('BOARD_STATE_INVALID');
  });
  it('rejects a claimed capture on a field outside the captured owner route', () => {
    const { board } = fixture();
    const corrupted = { ...board, lastMove: { ...board.lastMove!, from: 't3', to: 'ha', steps: 1, captured: ['b1'] }, figures: board.figures.map(f => f.id === 'a1' ? { ...f, at: 'ha' } : f) };
    expect(() => parseBoardState(corrupted)).toThrow('BOARD_STATE_INVALID');
  });
  it('rejects a recovered board claiming a movement from a future turn', () => {
    const { board, sequence, dice } = fixture();
    const corrupted = { ...board, lastMove: { ...board.lastMove!, turnNumber: sequence.turnNumber + 1 } };
    expect(() => projectBoard({ role: 'VIEWER' }, corrupted, { scope, sequence, dice, policy: { capture: 'ALLOWED' }, release: 'FIGURES', stateVersion: 10 })).toThrow();
  });
});
