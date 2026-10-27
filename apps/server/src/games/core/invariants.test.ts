import { expect, it } from 'vitest';
import { checkGameInvariants, assertGameInvariants } from './invariants.js';
import { createJeopardyGameState } from '../jeopardy/state.js';
import { buzz, createWerIstDasState, openRoundBuzzer } from '../weristdas/state.js';
import { createTurn } from './roundFlow.js';

it('accepts explicit legacy state and detects phase/round/score corruption without content in diagnostics', () => {
  const state = createWerIstDasState(1, { alice: 'SECRET_NAME' });
  expect(checkGameInvariants('weristdas', state, state.phase)).toEqual([]);
  expect(checkGameInvariants('wer-ist-das', { ...state, roundIndex: 9 })).toContain('ROUND_INDEX');
  expect(checkGameInvariants('wer-ist-das', { ...state, scores: { alice: NaN } })).toEqual(['STATE_SHAPE']);
  expect(checkGameInvariants('wer-ist-das', state, 'ANSWERING')).toContain('PHASE_MISMATCH');
  expect(() => assertGameInvariants('wer-ist-das', { ...state, roundIndex: 9 }, state.phase)).toThrow('STATE_INVARIANT_FAILED');
});
it('validates winner/turn/phase in both buzzer engines and preserves frozen pause state', () => {
  const wid = buzz(openRoundBuzzer(createWerIstDasState(1, { alice: 'Alice', bob: 'Bob' })), 'alice');
  expect(checkGameInvariants('wer-ist-das', wid)).toEqual([]);
  expect(checkGameInvariants('wer-ist-das', { ...wid, answerTurn: createTurn(['bob']) })).toContain('TURN_OWNER');
  expect(checkGameInvariants('wer-ist-das', { ...wid, phase: 'PAUSED', _roomPause: wid })).toEqual([]);
  const jp = { ...createJeopardyGameState(1, ['alice'], { alice: 'Alice' }), phase: 'BUZZ_OPEN', buzzOpen: true,
    currentField: { fieldDef: { answer: 'SECRET', question: 'Q' } } };
  expect(checkGameInvariants('jeopardy', jp)).toEqual([]);
  expect(checkGameInvariants('jeopardy', { ...jp, currentField: null })).toContain('FIELD_MISSING');
  expect(checkGameInvariants('jeopardy', { ...jp, phase: 'SELECTING' })).toContain('BUZZER_PHASE');
  expect(checkGameInvariants('jeopardy', { ...jp, phase: 'PAUSED', _roomPause: jp })).toEqual([]);
});
