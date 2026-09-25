// ============================================================
// Jeopardy contracts.test.ts — Phase 3
// Tests: phase transitions, point calculations, field playability
// ============================================================

import { describe, it, expect } from 'vitest';
import {
  JEOPARDY_PHASES,
  JEOPARDY_PHASE_TRANSITIONS,
  isValidPhaseTransition,
  pointsForCorrect,
  pointsForWrongFirst,
  pointsForCorrectSteal,
  pointsForWrongSteal,
  type JeopardyPhase,
} from './contracts.js';

import {
  createJeopardyGameState,
  transitionPhase,
  markFieldAnswered,
  registerField,
  fieldKey,
  countOpenFields,
  isBoardComplete,
  applyScoreDelta,
  calcWrongFirstDelta,
  calcCorrectStealDelta,
  calcWrongStealDelta,
  openBuzzer,
  lockBuzzer,
  resetBuzzer,
  openStealBuzzer,
  lockStealBuzzer,
  JEOPARDY_PHASES as STATE_PHASES,
} from './state.js';

// ============================================================
// Point calculation — all 4 cases
// ============================================================

describe('point calculations (server-side, no client secrets)', () => {
  const VALUE = 200;

  it('correct first answer: full value', () => {
    expect(pointsForCorrect(VALUE)).toBe(200);
  });

  it('wrong first answer: 50% penalty, rounded (Math.round)', () => {
    // 200 / 2 = 100 → Math.round(100) = 100
    expect(pointsForWrongFirst(VALUE)).toBe(-100);
  });

  it('correct steal: 50% of value, rounded', () => {
    // 200 / 2 = 100 → Math.round(100) = 100
    expect(pointsForCorrectSteal(VALUE)).toBe(100);
  });

  it('wrong steal: 50% penalty, rounded', () => {
    // 200 / 2 = 100 → Math.round(100) = 100
    expect(pointsForWrongSteal(VALUE)).toBe(-100);
  });

  // Edge cases — rounding at .5 boundary
  it('rounding: odd value → exact half, .5 rounds to nearest even (JS Math.round)', () => {
    // Math.round(150 / 2) = Math.round(75) = 75
    expect(pointsForWrongFirst(150)).toBe(-75);
  });

  it('rounding: value not divisible by 2', () => {
    // 300 / 2 = 150 → Math.round(150) = 150
    expect(pointsForWrongFirst(300)).toBe(-150);
    expect(pointsForCorrectSteal(300)).toBe(150);
    expect(pointsForWrongSteal(300)).toBe(-150);
  });

  it('rounding: small value (100)', () => {
    expect(pointsForWrongFirst(100)).toBe(-50);
    expect(pointsForCorrectSteal(100)).toBe(50);
    expect(pointsForWrongSteal(100)).toBe(-50);
  });

  it('rounding: large value (1000)', () => {
    expect(pointsForWrongFirst(1000)).toBe(-500);
    expect(pointsForCorrectSteal(1000)).toBe(500);
    expect(pointsForWrongSteal(1000)).toBe(-500);
  });
});

// ============================================================
// Phase transitions
// ============================================================

describe('phase transitions', () => {
  it('INTRO → SELECTING is valid', () => {
    expect(isValidPhaseTransition(JEOPARDY_PHASES.INTRO, JEOPARDY_PHASES.SELECTING)).toBe(true);
  });

  it('SELECTING → BUZZ_OPEN is valid', () => {
    expect(isValidPhaseTransition(JEOPARDY_PHASES.SELECTING, JEOPARDY_PHASES.BUZZ_OPEN)).toBe(true);
  });

  it('BUZZ_OPEN → BUZZ_LOCKED is valid', () => {
    expect(isValidPhaseTransition(JEOPARDY_PHASES.BUZZ_OPEN, JEOPARDY_PHASES.BUZZ_LOCKED)).toBe(true);
  });

  it('BUZZ_LOCKED → STEAL_OPEN is valid (wrong first answer)', () => {
    expect(isValidPhaseTransition(JEOPARDY_PHASES.BUZZ_LOCKED, JEOPARDY_PHASES.STEAL_OPEN)).toBe(true);
  });

  it('BUZZ_LOCKED → FIELD_DONE is valid (correct first answer)', () => {
    expect(isValidPhaseTransition(JEOPARDY_PHASES.BUZZ_LOCKED, JEOPARDY_PHASES.FIELD_DONE)).toBe(true);
  });

  it('STEAL_OPEN → STEAL_LOCKED is valid', () => {
    expect(isValidPhaseTransition(JEOPARDY_PHASES.STEAL_OPEN, JEOPARDY_PHASES.STEAL_LOCKED)).toBe(true);
  });

  it('STEAL_LOCKED → FIELD_DONE is valid', () => {
    expect(isValidPhaseTransition(JEOPARDY_PHASES.STEAL_LOCKED, JEOPARDY_PHASES.FIELD_DONE)).toBe(true);
  });

  it('FIELD_DONE → SELECTING is valid (more fields available)', () => {
    expect(isValidPhaseTransition(JEOPARDY_PHASES.FIELD_DONE, JEOPARDY_PHASES.SELECTING)).toBe(true);
  });

  it('FIELD_DONE → BOARD_COMPLETE is valid (board exhausted)', () => {
    expect(isValidPhaseTransition(JEOPARDY_PHASES.FIELD_DONE, JEOPARDY_PHASES.BOARD_COMPLETE)).toBe(true);
  });

  it('BOARD_COMPLETE → GAME_END is valid', () => {
    expect(isValidPhaseTransition(JEOPARDY_PHASES.BOARD_COMPLETE, JEOPARDY_PHASES.GAME_END)).toBe(true);
  });

  it('GAME_END has no valid transitions', () => {
    expect(JEOPARDY_PHASE_TRANSITIONS[JEOPARDY_PHASES.GAME_END]).toHaveLength(0);
  });

  it('invalid backward transition throws', () => {
    expect(isValidPhaseTransition(JEOPARDY_PHASES.BUZZ_LOCKED, JEOPARDY_PHASES.SELECTING)).toBe(false);
  });

  it('invalid skip transition BUZZ_OPEN → FIELD_DONE throws', () => {
    expect(isValidPhaseTransition(JEOPARDY_PHASES.BUZZ_OPEN, JEOPARDY_PHASES.FIELD_DONE)).toBe(false);
  });

  it('invalid transition from GAME_END throws', () => {
    expect(isValidPhaseTransition(JEOPARDY_PHASES.GAME_END, JEOPARDY_PHASES.SELECTING)).toBe(false);
  });

  it('transitionPhase helper throws on invalid transition', () => {
    const state = createJeopardyGameState(1, ['p1'], { p1: 'Alice' });
    expect(() => transitionPhase(state, JEOPARDY_PHASES.BOARD_COMPLETE)).toThrow();
  });

  it('transitionPhase helper succeeds on valid transition', () => {
    const state = createJeopardyGameState(1, ['p1'], { p1: 'Alice' });
    const next = transitionPhase(state, JEOPARDY_PHASES.SELECTING);
    expect(next.phase).toBe(JEOPARDY_PHASES.SELECTING);
  });
});

// ============================================================
// Field playability — each field can only be played once
// ============================================================

describe('field playability — field can only be played once', () => {
  it('field is added to openFields on registration', () => {
    let state = createJeopardyGameState(1, ['p1', 'p2'], { p1: 'Alice', p2: 'Bob' });
    state = registerField(state, 1, 0, 200, {
      categoryIndex: 0, value: 200, question: 'Clue', answer: 'Answer',
    });

    expect(state.openFields[fieldKey(1, 0, 200)]).toBeDefined();
    expect(state.openFields[fieldKey(1, 0, 200)].answered).toBe(false);
  });

  it('field is removed from openFields after correct answer', () => {
    let state = createJeopardyGameState(1, ['p1'], { p1: 'Alice' });
    state = registerField(state, 1, 2, 400, {
      categoryIndex: 2, value: 400, question: 'Clue', answer: 'Answer',
    });
    expect(countOpenFields(state, 1)).toBe(1);

    state = markFieldAnswered(state, 2, 400, 'p1', true, 400);
    expect(state.openFields[fieldKey(1, 2, 400)]).toBeUndefined();
    expect(countOpenFields(state, 1)).toBe(0);
  });

  it('field is removed from openFields after wrong answer (no second attempt)', () => {
    let state = createJeopardyGameState(1, ['p1'], { p1: 'Alice' });
    state = registerField(state, 1, 3, 500, {
      categoryIndex: 3, value: 500, question: 'Clue', answer: 'Answer',
    });

    state = markFieldAnswered(state, 3, 500, 'p1', false, -250);
    // Wrong answer → field is removed (not available for re-selection)
    expect(state.openFields[fieldKey(1, 3, 500)]).toBeUndefined();
    expect(countOpenFields(state, 1)).toBe(0);
  });

  it('board is marked complete when all fields are answered', () => {
    let state = createJeopardyGameState(1, ['p1'], { p1: 'Alice' });
    state = registerField(state, 1, 0, 200, {
      categoryIndex: 0, value: 200, question: 'Clue', answer: 'Answer',
    });

    expect(isBoardComplete(state, 1)).toBe(false);
    state = markFieldAnswered(state, 0, 200, 'p1', true, 200);
    expect(isBoardComplete(state, 1)).toBe(true);
  });

  it('same field cannot be registered twice', () => {
    let state = createJeopardyGameState(1, ['p1'], { p1: 'Alice' });
    state = registerField(state, 1, 0, 200, {
      categoryIndex: 0, value: 200, question: 'Clue A', answer: 'Answer A',
    });
    // Register again with different data
    state = registerField(state, 1, 0, 200, {
      categoryIndex: 0, value: 200, question: 'Clue B', answer: 'Answer B',
    });

    // Last registration wins for the key
    expect(state.openFields[fieldKey(1, 0, 200)].answered).toBe(false);
    expect(countOpenFields(state, 1)).toBe(1);
  });

  it('fields on different boards are independent', () => {
    let state = createJeopardyGameState(1, ['p1'], { p1: 'Alice' });
    state = registerField(state, 1, 0, 200, {
      categoryIndex: 0, value: 200, question: 'Clue', answer: 'Answer',
    });
    state = registerField(state, 2, 0, 400, {
      categoryIndex: 0, value: 400, question: 'Clue', answer: 'Answer',
    });

    state = markFieldAnswered(state, 0, 200, 'p1', true, 200);

    expect(countOpenFields(state, 1)).toBe(0);
    expect(countOpenFields(state, 2)).toBe(1);
    expect(isBoardComplete(state, 1)).toBe(true);
    expect(isBoardComplete(state, 2)).toBe(false);
  });
});

// ============================================================
// Score helpers
// ============================================================

describe('score helpers', () => {
  it('applyScoreDelta adds positive delta', () => {
    const scores = { p1: 0, p2: 0 };
    expect(applyScoreDelta(scores, 'p1', 200)).toEqual({ p1: 200, p2: 0 });
  });

  it('applyScoreDelta adds negative delta (penalty)', () => {
    const scores = { p1: 200, p2: 0 };
    expect(applyScoreDelta(scores, 'p1', -100)).toEqual({ p1: 100, p2: 0 });
  });

  it('applyScoreDelta initializes new player', () => {
    const scores: Record<string, number> = {};
    expect(applyScoreDelta(scores, 'p1', 500)).toEqual({ p1: 500 });
  });

  it('calcWrongFirstDelta uses Math.round(value/2)', () => {
    expect(calcWrongFirstDelta(200)).toBe(-100);
    expect(calcWrongFirstDelta(100)).toBe(-50);
    expect(calcWrongFirstDelta(300)).toBe(-150);
  });

  it('calcCorrectStealDelta returns Math.round(value/2)', () => {
    expect(calcCorrectStealDelta(200)).toBe(100);
    expect(calcCorrectStealDelta(100)).toBe(50);
    expect(calcCorrectStealDelta(300)).toBe(150);
  });

  it('calcWrongStealDelta returns -Math.round(value/2)', () => {
    expect(calcWrongStealDelta(200)).toBe(-100);
    expect(calcWrongStealDelta(100)).toBe(-50);
    expect(calcWrongStealDelta(300)).toBe(-150);
  });
});

// ============================================================
// Buzzer helpers
// ============================================================

describe('buzzer helpers', () => {
  it('openBuzzer sets buzzOpen=true, clears winner', () => {
    const state = createJeopardyGameState(1, ['p1'], { p1: 'Alice' });
    const next = openBuzzer(state);
    expect(next.buzzOpen).toBe(true);
    expect(next.buzzWinner).toBeNull();
  });

  it('lockBuzzer records winner and closes buzzer', () => {
    let state = createJeopardyGameState(1, ['p1', 'p2'], { p1: 'Alice', p2: 'Bob' });
    state = openBuzzer(state);
    state = lockBuzzer(state, 'p1');
    expect(state.buzzOpen).toBe(false);
    expect(state.buzzWinner).toBe('p1');
  });

  it('openStealBuzzer opens steal, closes main buzzer', () => {
    let state = createJeopardyGameState(1, ['p1'], { p1: 'Alice' });
    state = openStealBuzzer(state);
    expect(state.stealOpen).toBe(true);
    expect(state.stealWinner).toBeNull();
    expect(state.buzzOpen).toBe(false);
  });

  it('lockStealBuzzer records steal winner', () => {
    let state = createJeopardyGameState(1, ['p1'], { p1: 'Alice' });
    state = openStealBuzzer(state);
    state = lockStealBuzzer(state, 'p1');
    expect(state.stealOpen).toBe(false);
    expect(state.stealWinner).toBe('p1');
  });

  it('resetBuzzer clears all buzzer state', () => {
    let state = createJeopardyGameState(1, ['p1'], { p1: 'Alice' });
    state = openBuzzer(state);
    state = lockBuzzer(state, 'p1');
    state = resetBuzzer(state);
    expect(state.buzzOpen).toBe(false);
    expect(state.buzzWinner).toBeNull();
    expect(state.stealOpen).toBe(false);
    expect(state.stealWinner).toBeNull();
  });
});

// ============================================================
// State factory
// ============================================================

describe('createJeopardyGameState', () => {
  it('initializes with INTRO phase', () => {
    const state = createJeopardyGameState(1, ['p1'], { p1: 'Alice' });
    expect(state.phase).toBe(JEOPARDY_PHASES.INTRO);
  });

  it('initializes scores for all players', () => {
    const state = createJeopardyGameState(
      1,
      ['p1', 'p2'],
      { p1: 'Alice', p2: 'Bob' }
    );
    expect(state.scores).toEqual({ p1: 0, p2: 0 });
  });

  it('accepts pre-existing scores', () => {
    const state = createJeopardyGameState(
      1,
      ['p1'],
      { p1: 'Alice' },
      { p1: 500 }
    );
    expect(state.scores).toEqual({ p1: 500 });
  });

  it('stores playerNames for broadcast events', () => {
    const state = createJeopardyGameState(
      1,
      ['p1', 'p2'],
      { p1: 'Alice', p2: 'Bob' }
    );
    expect(state.playerNames).toEqual({ p1: 'Alice', p2: 'Bob' });
  });

  it('starts with buzz/steal closed', () => {
    const state = createJeopardyGameState(1, ['p1'], { p1: 'Alice' });
    expect(state.buzzOpen).toBe(false);
    expect(state.buzzWinner).toBeNull();
    expect(state.stealOpen).toBe(false);
    expect(state.stealWinner).toBeNull();
    expect(state.currentField).toBeNull();
  });
});
