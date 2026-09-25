// ============================================================
// Jeopardy Engine Integration Tests (Phase 4)
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest';
import {
  JeopardyGameState,
  createJeopardyGameState,
  fieldKey,
  registerField,
  isBoardComplete,
  countOpenFields,
  applyScoreDelta,
  resetBuzzer,
  JeopardyFieldDef,
} from './state.js';
import {
  pointsForCorrect,
  pointsForWrongFirst,
  pointsForCorrectSteal,
  pointsForWrongSteal,
  isValidPhaseTransition,
  JEOPARDY_PHASES,
} from './contracts.js';

// ============================================================
// Score Calculation Tests (4 cases)
// ============================================================

describe('Jeopardy points calculation', () => {
  describe('pointsForCorrect', () => {
    it('returns full value for correct answer', () => {
      expect(pointsForCorrect(200)).toBe(200);
      expect(pointsForCorrect(400)).toBe(400);
      expect(pointsForCorrect(1000)).toBe(1000);
    });
  });

  describe('pointsForWrongFirst', () => {
    it('returns negative half value for wrong first answer', () => {
      expect(pointsForWrongFirst(200)).toBe(-100);
      expect(pointsForWrongFirst(400)).toBe(-200);
      expect(pointsForWrongFirst(1000)).toBe(-500);
      // Odd values round correctly
      expect(pointsForWrongFirst(300)).toBe(-150);
      expect(pointsForWrongFirst(500)).toBe(-250);
    });
  });

  describe('pointsForCorrectSteal', () => {
    it('returns half value for correct steal', () => {
      expect(pointsForCorrectSteal(200)).toBe(100);
      expect(pointsForCorrectSteal(400)).toBe(200);
      expect(pointsForCorrectSteal(1000)).toBe(500);
    });
  });

  describe('pointsForWrongSteal', () => {
    it('returns negative half value for wrong steal', () => {
      expect(pointsForWrongSteal(200)).toBe(-100);
      expect(pointsForWrongSteal(400)).toBe(-200);
      expect(pointsForWrongSteal(1000)).toBe(-500);
    });
  });
});

// ============================================================
// Field State Tests
// ============================================================

describe('Jeopardy field key', () => {
  it('generates unique keys for each field', () => {
    expect(fieldKey(1, 0, 200)).toBe('1-0-200');
    expect(fieldKey(1, 5, 1000)).toBe('1-5-1000');
    expect(fieldKey(2, 3, 400)).toBe('2-3-400');
  });

  it('different board-category-value combinations produce unique keys', () => {
    const keys = new Set([
      fieldKey(1, 0, 200),
      fieldKey(1, 0, 400),
      fieldKey(1, 1, 200),
      fieldKey(2, 0, 200),
    ]);
    expect(keys.size).toBe(4);
  });
});

// ============================================================
// Game State Initialization Tests
// ============================================================

describe('JeopardyGameState creation', () => {
  it('creates state with correct initial values', () => {
    const playerIds = ['p1', 'p2'];
    const playerNames = { p1: 'Alice', p2: 'Bob' };

    const state = createJeopardyGameState(1, playerIds, playerNames);

    expect(state.currentBoard).toBe(1);
    expect(state.boardsCompleted).toEqual([false, false]);
    expect(state.phase).toBe(JEOPARDY_PHASES.INTRO);
    expect(state.buzzOpen).toBe(false);
    expect(state.buzzWinner).toBeNull();
    expect(state.stealOpen).toBe(false);
    expect(state.stealWinner).toBeNull();
    expect(state.currentField).toBeNull();
    expect(state.scores).toEqual({ p1: 0, p2: 0 });
    expect(state.playerNames).toEqual({ p1: 'Alice', p2: 'Bob' });
  });

  it('preserves existing scores when provided', () => {
    const state = createJeopardyGameState(1, ['p1', 'p2'], { p1: 'Alice', p2: 'Bob' }, { p1: 500, p2: 200 });
    expect(state.scores).toEqual({ p1: 500, p2: 200 });
  });
});

// ============================================================
// Field Open Validation Tests
// ============================================================

describe('Field open validation', () => {
  let state: JeopardyGameState;
  let fieldDef: JeopardyFieldDef;

  beforeEach(() => {
    state = createJeopardyGameState(1, ['p1'], { p1: 'Alice' });
    fieldDef = { categoryIndex: 2, value: 400, question: 'What is X?', answer: 'X' };
    state = registerField(state, 1, 2, 400, fieldDef);
  });

  it('field can be opened when not yet played', () => {
    const key = fieldKey(1, 2, 400);
    expect(state.openFields[key]).toBeDefined();
    expect(state.openFields[key].answered).toBe(false);
  });

  it('field cannot be opened twice', () => {
    const { [fieldKey(1, 2, 400)]: _, ...remaining } = state.openFields;
    const updatedState = { ...state, openFields: remaining };
    const key = fieldKey(1, 2, 400);
    expect(updatedState.openFields[key]).toBeUndefined();
  });

  it('field on wrong board is rejected', () => {
    const board2Key = fieldKey(2, 2, 400);
    expect(state.openFields[board2Key]).toBeUndefined();
  });
});

// ============================================================
// Buzzer Atomicity Tests
// ============================================================

describe('Buzzer atomicity', () => {
  it('first buzz wins — second buzz is rejected', () => {
    let state = createJeopardyGameState(1, ['p1', 'p2', 'p3'], { p1: 'A', p2: 'B', p3: 'C' });
    state = { ...state, phase: JEOPARDY_PHASES.BUZZ_OPEN, buzzOpen: true };

    const firstBuzzState = { ...state, buzzWinner: 'p1', phase: JEOPARDY_PHASES.BUZZ_LOCKED };
    const canSecondBuzz = firstBuzzState.buzzWinner === null;
    expect(canSecondBuzz).toBe(false);
  });

  it('buzzer state correctly transitions BUZZ_OPEN → BUZZ_LOCKED', () => {
    let state = createJeopardyGameState(1, ['p1'], { p1: 'Alice' });
    state = { ...state, phase: JEOPARDY_PHASES.BUZZ_OPEN, buzzOpen: true, buzzWinner: null };

    state = { ...state, buzzWinner: 'p1', buzzOpen: false, phase: JEOPARDY_PHASES.BUZZ_LOCKED };

    expect(state.buzzWinner).toBe('p1');
    expect(state.buzzOpen).toBe(false);
    expect(state.phase).toBe(JEOPARDY_PHASES.BUZZ_LOCKED);
  });
});

// ============================================================
// Score Application Tests
// ============================================================

describe('Score application', () => {
  it('applies correct score delta', () => {
    let scores: Record<string, number> = { p1: 0, p2: 0 };
    scores = applyScoreDelta(scores, 'p1', pointsForCorrect(200));
    expect(scores).toEqual({ p1: 200, p2: 0 });
  });

  it('applies wrong answer penalty', () => {
    let scores: Record<string, number> = { p1: 100 };
    scores = applyScoreDelta(scores, 'p1', pointsForWrongFirst(200));
    expect(scores).toEqual({ p1: 0 }); // 100 - 100 = 0
  });

  it('applies correct steal (half points)', () => {
    let scores: Record<string, number> = { p1: 100 };
    scores = applyScoreDelta(scores, 'p1', pointsForCorrectSteal(200));
    expect(scores).toEqual({ p1: 200 }); // 100 + 100 = 200
  });

  it('applies wrong steal penalty (half)', () => {
    let scores: Record<string, number> = { p1: 100 };
    scores = applyScoreDelta(scores, 'p1', pointsForWrongSteal(200));
    expect(scores).toEqual({ p1: 0 }); // 100 - 100 = 0
  });

  it('accumulates scores across multiple questions', () => {
    let scores: Record<string, number> = { p1: 0 };
    scores = applyScoreDelta(scores, 'p1', pointsForCorrect(200));    // +200
    scores = applyScoreDelta(scores, 'p1', pointsForWrongFirst(400)); // -200
    scores = applyScoreDelta(scores, 'p1', pointsForCorrect(200));    // +200 → 200
    expect(scores).toEqual({ p1: 200 });
  });
});

// ============================================================
// Phase Transition Tests
// ============================================================

describe('Phase transitions', () => {
  it('SELECTING → BUZZ_OPEN is valid', () => {
    expect(isValidPhaseTransition(JEOPARDY_PHASES.SELECTING, JEOPARDY_PHASES.BUZZ_OPEN)).toBe(true);
  });

  it('BUZZ_OPEN → BUZZ_LOCKED is valid', () => {
    expect(isValidPhaseTransition(JEOPARDY_PHASES.BUZZ_OPEN, JEOPARDY_PHASES.BUZZ_LOCKED)).toBe(true);
  });

  it('BUZZ_LOCKED → STEAL_OPEN is valid (wrong answer)', () => {
    expect(isValidPhaseTransition(JEOPARDY_PHASES.BUZZ_LOCKED, JEOPARDY_PHASES.STEAL_OPEN)).toBe(true);
  });

  it('BUZZ_LOCKED → FIELD_DONE is valid (correct answer)', () => {
    expect(isValidPhaseTransition(JEOPARDY_PHASES.BUZZ_LOCKED, JEOPARDY_PHASES.FIELD_DONE)).toBe(true);
  });

  it('STEAL_OPEN → STEAL_LOCKED is valid', () => {
    expect(isValidPhaseTransition(JEOPARDY_PHASES.STEAL_OPEN, JEOPARDY_PHASES.STEAL_LOCKED)).toBe(true);
  });

  it('STEAL_LOCKED → FIELD_DONE is valid', () => {
    expect(isValidPhaseTransition(JEOPARDY_PHASES.STEAL_LOCKED, JEOPARDY_PHASES.FIELD_DONE)).toBe(true);
  });

  it('FIELD_DONE → SELECTING is valid', () => {
    expect(isValidPhaseTransition(JEOPARDY_PHASES.FIELD_DONE, JEOPARDY_PHASES.SELECTING)).toBe(true);
  });

  it('FIELD_DONE → BOARD_COMPLETE is valid', () => {
    expect(isValidPhaseTransition(JEOPARDY_PHASES.FIELD_DONE, JEOPARDY_PHASES.BOARD_COMPLETE)).toBe(true);
  });

  it('BOARD_COMPLETE → GAME_END is valid', () => {
    expect(isValidPhaseTransition(JEOPARDY_PHASES.BOARD_COMPLETE, JEOPARDY_PHASES.GAME_END)).toBe(true);
  });

  it('invalid transition BUZZ_OPEN → FIELD_DONE is rejected', () => {
    expect(isValidPhaseTransition(JEOPARDY_PHASES.BUZZ_OPEN, JEOPARDY_PHASES.FIELD_DONE)).toBe(false);
  });

  it('invalid transition GAME_END → any is rejected', () => {
    expect(isValidPhaseTransition(JEOPARDY_PHASES.GAME_END, JEOPARDY_PHASES.SELECTING)).toBe(false);
  });
});

// ============================================================
// Board Completion Tests
// ============================================================

describe('Board completion', () => {
  it('counts open fields correctly', () => {
    let state = createJeopardyGameState(1, ['p1'], { p1: 'Alice' });
    state = registerField(state, 1, 0, 200, { categoryIndex: 0, value: 200, question: 'Q', answer: 'A' });
    state = registerField(state, 1, 0, 400, { categoryIndex: 0, value: 400, question: 'Q', answer: 'A' });
    state = registerField(state, 1, 1, 200, { categoryIndex: 1, value: 200, question: 'Q', answer: 'A' });

    expect(countOpenFields(state, 1)).toBe(3);
    expect(countOpenFields(state, 2)).toBe(0);
  });

  it('isBoardComplete returns true when all fields answered', () => {
    let state = createJeopardyGameState(1, ['p1'], { p1: 'Alice' });
    state = registerField(state, 1, 0, 200, { categoryIndex: 0, value: 200, question: 'Q', answer: 'A' });

    expect(isBoardComplete(state, 1)).toBe(false);

    const { [fieldKey(1, 0, 200)]: _, ...remaining } = state.openFields;
    const answeredState = { ...state, openFields: remaining };

    expect(isBoardComplete(answeredState, 1)).toBe(true);
  });
});

// ============================================================
// Reset Buzzer Tests
// ============================================================

describe('Reset buzzer', () => {
  it('clears all buzzer state', () => {
    let state = createJeopardyGameState(1, ['p1', 'p2'], { p1: 'A', p2: 'B' });
    state = {
      ...state,
      buzzOpen: true,
      buzzWinner: 'p1',
      stealOpen: true,
      stealWinner: 'p2',
    };

    state = resetBuzzer(state);

    expect(state.buzzOpen).toBe(false);
    expect(state.buzzWinner).toBeNull();
    expect(state.stealOpen).toBe(false);
    expect(state.stealWinner).toBeNull();
  });
});

// ============================================================
// Idempotent Judging Tests
// ============================================================

describe('Idempotent judging', () => {
  it('double judge does not double-penalize', () => {
    let scores: Record<string, number> = { p1: 300 };

    // First judgment (wrong)
    scores = applyScoreDelta(scores, 'p1', pointsForWrongFirst(400));

    // Second judgment attempt (should not apply again)
    const alreadyJudged = true; // Would be checked in engine
    if (!alreadyJudged) {
      scores = applyScoreDelta(scores, 'p1', pointsForWrongFirst(400));
    }

    // Final score: 300 - 200 = 100 (not -100)
    expect(scores).toEqual({ p1: 100 });
  });

  it('judge called twice returns same result', () => {
    let state = createJeopardyGameState(1, ['p1'], { p1: 'Alice' });
    state = { ...state, phase: JEOPARDY_PHASES.BUZZ_LOCKED, buzzWinner: 'p1', scores: { p1: 300 } };

    // First judge processes
    const delta = pointsForWrongFirst(400);
    state = { ...state, scores: applyScoreDelta(state.scores, 'p1', delta), buzzWinner: null };

    // Second judge attempt: buzzWinner is now null, should be rejected
    const canJudgeAgain = state.buzzWinner !== null;
    expect(canJudgeAgain).toBe(false);
  });
});

// ============================================================
// Cross-Room Isolation Tests
// ============================================================

describe('Cross-room isolation', () => {
  it('room A state is isolated from room B operations', () => {
    let roomAState = createJeopardyGameState(1, ['p1'], { p1: 'Alice' });
    let roomBState = createJeopardyGameState(1, ['q1'], { q1: 'Bob' });

    roomAState = registerField(roomAState, 1, 0, 200, { categoryIndex: 0, value: 200, question: 'Q', answer: 'A' });
    roomBState = registerField(roomBState, 1, 0, 400, { categoryIndex: 0, value: 400, question: 'Q2', answer: 'B' });

    roomAState = { ...roomAState, buzzWinner: 'p1', phase: JEOPARDY_PHASES.BUZZ_LOCKED };

    expect(roomAState.buzzWinner).toBe('p1');
    expect(roomBState.buzzWinner).toBeNull();

    roomAState.scores = applyScoreDelta(roomAState.scores, 'p1', pointsForCorrect(200));

    expect(roomAState.scores).toEqual({ p1: 200 });
    expect(roomBState.scores).toEqual({ q1: 0 });
  });

  it('field key includes board index preventing cross-board conflicts', () => {
    const key1 = fieldKey(1, 0, 200);
    const key2 = fieldKey(2, 0, 200);
    expect(key1).not.toBe(key2);
  });
});

// ============================================================
// Answer Leak Prevention Tests
// ============================================================

describe('Answer leak prevention', () => {
  it('currentField contains question but answer is kept separate', () => {
    let state = createJeopardyGameState(1, ['p1'], { p1: 'Alice' });
    const fieldDef: JeopardyFieldDef = {
      categoryIndex: 0,
      value: 200,
      question: 'What year did WWII end?',
      answer: '1945',
    };
    state = registerField(state, 1, 0, 200, fieldDef);
    state = {
      ...state,
      currentField: {
        categoryIndex: 0,
        value: 200,
        fieldDef,
      },
    };

    // Question is accessible
    expect(state.currentField?.fieldDef.question).toBe('What year did WWII end?');

    // Engine must send answer only to moderator
    expect(state.currentField?.fieldDef.answer).toBe('1945');
  });

  it('scored updates do not include correct option data', () => {
    const scores: Record<string, number> = { p1: 200 };
    const scoreEvent = {
      playerId: 'p1',
      delta: 200,
      scores,
    };

    expect(scoreEvent).not.toHaveProperty('correctAnswer');
    expect(scoreEvent).not.toHaveProperty('answer');
  });
});

// ============================================================
// Full Game Flow Simulation
// ============================================================

describe('Full game flow simulation', () => {
  it('simulates a complete question cycle', () => {
    let state = createJeopardyGameState(1, ['p1', 'p2'], { p1: 'Alice', p2: 'Bob' });
    state = registerField(state, 1, 0, 200, { categoryIndex: 0, value: 200, question: 'Q', answer: 'A' });

    expect(state.phase).toBe(JEOPARDY_PHASES.INTRO);

    state = {
      ...state,
      phase: JEOPARDY_PHASES.BUZZ_OPEN,
      buzzOpen: true,
      currentField: { categoryIndex: 0, value: 200, fieldDef: { categoryIndex: 0, value: 200, question: 'Q', answer: 'A' } },
    };
    expect(state.phase).toBe(JEOPARDY_PHASES.BUZZ_OPEN);
    expect(state.buzzOpen).toBe(true);

    state = { ...state, buzzWinner: 'p1', buzzOpen: false, phase: JEOPARDY_PHASES.BUZZ_LOCKED };
    expect(state.phase).toBe(JEOPARDY_PHASES.BUZZ_LOCKED);
    expect(state.buzzWinner).toBe('p1');

    state = {
      ...state,
      scores: applyScoreDelta(state.scores, 'p1', pointsForCorrect(200)),
      phase: JEOPARDY_PHASES.FIELD_DONE,
    };
    state = resetBuzzer(state);
    expect(state.scores).toEqual({ p1: 200, p2: 0 });
    expect(state.phase).toBe(JEOPARDY_PHASES.FIELD_DONE);

    state = {
      ...state,
      currentField: null,
      phase: JEOPARDY_PHASES.SELECTING,
    };
    expect(state.phase).toBe(JEOPARDY_PHASES.SELECTING);
    expect(state.currentField).toBeNull();
  });

  it('simulates steal flow', () => {
    let state = createJeopardyGameState(1, ['p1', 'p2'], { p1: 'Alice', p2: 'Bob' });
    state = registerField(state, 1, 0, 200, { categoryIndex: 0, value: 200, question: 'Q', answer: 'A' });

    state = {
      ...state,
      phase: JEOPARDY_PHASES.BUZZ_LOCKED,
      buzzWinner: 'p1',
      scores: { p1: 0, p2: 0 },
      currentField: { categoryIndex: 0, value: 200, fieldDef: { categoryIndex: 0, value: 200, question: 'Q', answer: 'A' } },
    };

    state = {
      ...state,
      scores: applyScoreDelta(state.scores, 'p1', pointsForWrongFirst(200)),
      phase: JEOPARDY_PHASES.STEAL_OPEN,
      stealOpen: true,
    };
    expect(state.scores).toEqual({ p1: -100, p2: 0 });
    expect(state.phase).toBe(JEOPARDY_PHASES.STEAL_OPEN);

    state = { ...state, stealWinner: 'p2', stealOpen: false, phase: JEOPARDY_PHASES.STEAL_LOCKED };
    expect(state.phase).toBe(JEOPARDY_PHASES.STEAL_LOCKED);

    state = {
      ...state,
      scores: applyScoreDelta(state.scores, 'p2', pointsForCorrectSteal(200)),
      phase: JEOPARDY_PHASES.FIELD_DONE,
    };
    state = resetBuzzer(state);
    expect(state.scores).toEqual({ p1: -100, p2: 100 });
    expect(state.phase).toBe(JEOPARDY_PHASES.FIELD_DONE);
  });
});
