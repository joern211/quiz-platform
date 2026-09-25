// ============================================================
// Jeopardy Engine Tests
// Phase 7: Unit tests for engine.ts
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  JeopardyGameState,
  createJeopardyGameState,
  registerField,
  fieldKey,
  markFieldAnswered,
  resetBuzzer,
  countOpenFields,
  isBoardComplete,
  applyScoreDelta,
  JeopardyFieldDef,
} from './state.js';
import {
  pointsForCorrect,
  pointsForWrongFirst,
  pointsForCorrectSteal,
  pointsForWrongSteal,
} from './contracts.js';

// ── Test Fixtures ──────────────────────────────────────────────

const PLAYER_A = 'player-a';
const PLAYER_B = 'player-b';

function makeFieldDef(categoryIndex: number, value: number): JeopardyFieldDef {
  return { categoryIndex, value, question: `Q: ${value}`, answer: `A: ${value}` };
}

function makeInitialState(): JeopardyGameState {
  let state = createJeopardyGameState(
    1,
    [PLAYER_A, PLAYER_B],
    { [PLAYER_A]: 'Alice', [PLAYER_B]: 'Bob' }
  );

  // Register 6 categories × 5 values = 30 fields
  for (let ci = 0; ci < 6; ci++) {
    for (const value of [100, 200, 300, 400, 500]) {
      state = registerField(state, 1, ci, value, makeFieldDef(ci, value));
    }
  }
  state.phase = 'SELECTING';
  return state;
}

// ── Points Calculations ─────────────────────────────────────────

describe('pointsForCorrect', () => {
  it('returns the full field value', () => {
    expect(pointsForCorrect(100)).toBe(100);
    expect(pointsForCorrect(200)).toBe(200);
    expect(pointsForCorrect(500)).toBe(500);
    expect(pointsForCorrect(1000)).toBe(1000);
  });
});

describe('pointsForWrongFirst', () => {
  it('returns -50% of field value, rounded', () => {
    expect(pointsForWrongFirst(100)).toBe(-50);
    expect(pointsForWrongFirst(200)).toBe(-100);
    expect(pointsForWrongFirst(300)).toBe(-150);
    expect(pointsForWrongFirst(500)).toBe(-250);
    expect(pointsForWrongFirst(1000)).toBe(-500);
  });

  it('rounds correctly for odd values', () => {
    expect(pointsForWrongFirst(150)).toBe(-75);
    expect(pointsForWrongFirst(350)).toBe(-175);
  });
});

describe('pointsForCorrectSteal', () => {
  it('returns +50% of field value, rounded', () => {
    expect(pointsForCorrectSteal(100)).toBe(50);
    expect(pointsForCorrectSteal(200)).toBe(100);
    expect(pointsForCorrectSteal(300)).toBe(150);
    expect(pointsForCorrectSteal(500)).toBe(250);
    expect(pointsForCorrectSteal(1000)).toBe(500);
  });
});

describe('pointsForWrongSteal', () => {
  it('returns -50% of field value, rounded', () => {
    expect(pointsForWrongSteal(100)).toBe(-50);
    expect(pointsForWrongSteal(200)).toBe(-100);
    expect(pointsForWrongSteal(1000)).toBe(-500);
  });
});

// ── State Helpers ───────────────────────────────────────────────

describe('createJeopardyGameState', () => {
  it('initializes with zero scores for all players', () => {
    const state = createJeopardyGameState(1, [PLAYER_A, PLAYER_B], { [PLAYER_A]: 'Alice', [PLAYER_B]: 'Bob' });
    expect(state.scores[PLAYER_A]).toBe(0);
    expect(state.scores[PLAYER_B]).toBe(0);
  });

  it('starts on board 1', () => {
    const state = createJeopardyGameState(1, [PLAYER_A], { [PLAYER_A]: 'Alice' });
    expect(state.currentBoard).toBe(1);
  });

  it('starts with INTRO phase', () => {
    const state = createJeopardyGameState(1, [PLAYER_A], { [PLAYER_A]: 'Alice' });
    expect(state.phase).toBe('INTRO');
  });

  it('starts with buzzer locked', () => {
    const state = createJeopardyGameState(1, [PLAYER_A], { [PLAYER_A]: 'Alice' });
    expect(state.buzzOpen).toBe(false);
    expect(state.buzzWinner).toBeNull();
    expect(state.stealOpen).toBe(false);
    expect(state.stealWinner).toBeNull();
  });
});

describe('fieldKey', () => {
  it('creates unique keys for board, category, value', () => {
    expect(fieldKey(1, 0, 100)).toBe('1-0-100');
    expect(fieldKey(1, 5, 500)).toBe('1-5-500');
    expect(fieldKey(2, 0, 200)).toBe('2-0-200');
  });

  it('distinguishes same value in different categories', () => {
    expect(fieldKey(1, 0, 100)).not.toBe(fieldKey(1, 1, 100));
  });
});

describe('registerField', () => {
  it('registers a field in openFields', () => {
    let state = createJeopardyGameState(1, [PLAYER_A], { [PLAYER_A]: 'Alice' });
    state = registerField(state, 1, 0, 100, makeFieldDef(0, 100));

    expect(state.openFields['1-0-100']).toBeDefined();
    expect(state.openFields['1-0-100'].answered).toBe(false);
    expect(state.openFields['1-0-100'].answeredBy).toBeNull();
  });

  it('does not overwrite existing field', () => {
    let state = createJeopardyGameState(1, [PLAYER_A], { [PLAYER_A]: 'Alice' });
    state = registerField(state, 1, 0, 100, makeFieldDef(0, 100));
    state = registerField(state, 1, 0, 100, makeFieldDef(0, 100)); // duplicate

    const keys = Object.keys(state.openFields).filter((k) => k.startsWith('1-0-100'));
    expect(keys.length).toBe(1);
  });
});

describe('countOpenFields', () => {
  it('returns 0 for fresh state', () => {
    const state = createJeopardyGameState(1, [PLAYER_A], { [PLAYER_A]: 'Alice' });
    expect(countOpenFields(state, 1)).toBe(0);
  });

  it('counts only fields on the requested board', () => {
    let state = createJeopardyGameState(1, [PLAYER_A], { [PLAYER_A]: 'Alice' });
    state = registerField(state, 1, 0, 100, makeFieldDef(0, 100));
    state = registerField(state, 1, 1, 100, makeFieldDef(1, 100));
    state = registerField(state, 2, 0, 200, makeFieldDef(0, 200));

    expect(countOpenFields(state, 1)).toBe(2);
    expect(countOpenFields(state, 2)).toBe(1);
  });
});

describe('isBoardComplete', () => {
  it('true when no open fields', () => {
    const state = createJeopardyGameState(1, [PLAYER_A], { [PLAYER_A]: 'Alice' });
    expect(isBoardComplete(state, 1)).toBe(true);
  });

  it('false when open fields remain', () => {
    let state = createJeopardyGameState(1, [PLAYER_A], { [PLAYER_A]: 'Alice' });
    state = registerField(state, 1, 0, 100, makeFieldDef(0, 100));
    expect(isBoardComplete(state, 1)).toBe(false);
  });
});

describe('applyScoreDelta', () => {
  it('adds positive delta to score', () => {
    const scores = { [PLAYER_A]: 0 };
    const updated = applyScoreDelta(scores, PLAYER_A, 100);
    expect(updated[PLAYER_A]).toBe(100);
  });

  it('subtracts negative delta from score', () => {
    const scores = { [PLAYER_A]: 200 };
    const updated = applyScoreDelta(scores, PLAYER_A, -100);
    expect(updated[PLAYER_A]).toBe(100);
  });

  it('creates entry for unknown player', () => {
    const scores: Record<string, number> = {};
    const updated = applyScoreDelta(scores, PLAYER_A, 50);
    expect(updated[PLAYER_A]).toBe(50);
  });
});

describe('markFieldAnswered', () => {
  it('removes field from openFields', () => {
    let state = createJeopardyGameState(1, [PLAYER_A], { [PLAYER_A]: 'Alice' });
    state = registerField(state, 1, 0, 100, makeFieldDef(0, 100));
    state = markFieldAnswered(state, 0, 100, PLAYER_A, true, 100);

    expect(state.openFields['1-0-100']).toBeUndefined();
  });

  it('clears currentField and buzzer state', () => {
    let state = makeInitialState();
    state.currentField = { categoryIndex: 0, value: 100, fieldDef: makeFieldDef(0, 100) };
    state.phase = 'FIELD_DONE';
    state.buzzWinner = PLAYER_A;
    state.buzzOpen = true;

    const updated = markFieldAnswered(state, 0, 100, PLAYER_A, true, 100);

    expect(updated.currentField).toBeNull();
    expect(updated.buzzWinner).toBeNull();
    expect(updated.buzzOpen).toBe(false);
  });
});

describe('resetBuzzer', () => {
  it('resets all buzzer state', () => {
    let state = makeInitialState();
    state.buzzWinner = PLAYER_A;
    state.buzzOpen = true;
    state.stealWinner = PLAYER_B;
    state.stealOpen = true;

    const updated = resetBuzzer(state);

    expect(updated.buzzOpen).toBe(false);
    expect(updated.buzzWinner).toBeNull();
    expect(updated.stealOpen).toBe(false);
    expect(updated.stealWinner).toBeNull();
  });
});

// ── Game Flow Simulation ────────────────────────────────────────

describe('Full game flow simulation', () => {
  it('simulates: field open → buzz → correct → next → field done', () => {
    let state = makeInitialState();

    // 1. Open a field (SELECTING → BUZZ_OPEN)
    expect(state.phase).toBe('SELECTING');
    state.phase = 'BUZZ_OPEN';
    state.buzzOpen = true;
    state.currentField = { categoryIndex: 0, value: 100, fieldDef: makeFieldDef(0, 100) };

    expect(state.phase).toBe('BUZZ_OPEN');
    expect(state.buzzOpen).toBe(true);

    // 2. Player A buzzes (BUZZ_OPEN → BUZZ_LOCKED)
    expect(state.buzzWinner).toBeNull();
    state.buzzWinner = PLAYER_A;
    state.phase = 'BUZZ_LOCKED';
    state.buzzOpen = false;

    expect(state.phase).toBe('BUZZ_LOCKED');
    expect(state.buzzWinner).toBe(PLAYER_A);

    // 3. Moderator judges correct (BUZZ_LOCKED → FIELD_DONE)
    state.scores = applyScoreDelta(state.scores, PLAYER_A, pointsForCorrect(100));
    state = markFieldAnswered(state, 0, 100, PLAYER_A, true, 100);
    state.phase = 'FIELD_DONE';

    expect(state.scores[PLAYER_A]).toBe(100);
    expect(state.currentField).toBeNull();
    expect(state.openFields['1-0-100']).toBeUndefined();

    // 4. Moderator next (FIELD_DONE → SELECTING)
    state.phase = 'SELECTING';
    state = resetBuzzer(state);

    expect(state.phase).toBe('SELECTING');
    expect(state.buzzWinner).toBeNull();
  });

  it('simulates: wrong answer → steal round → steal wrong', () => {
    let state = makeInitialState();

    // Open field + buzz + wrong answer
    state.phase = 'BUZZ_LOCKED';
    state.buzzWinner = PLAYER_A;
    state.currentField = { categoryIndex: 0, value: 200, fieldDef: makeFieldDef(0, 200) };

    // Moderator judges wrong
    state.scores = applyScoreDelta(state.scores, PLAYER_A, pointsForWrongFirst(200));
    state.phase = 'STEAL_OPEN';
    state.buzzWinner = null;
    state.stealOpen = true;
    state.buzzOpen = false;

    expect(state.scores[PLAYER_A]).toBe(-100); // 0 - 100
    expect(state.phase).toBe('STEAL_OPEN');
    expect(state.stealOpen).toBe(true);

    // Player B steals buzz
    state.stealWinner = PLAYER_B;
    state.phase = 'STEAL_LOCKED';
    state.stealOpen = false;

    expect(state.phase).toBe('STEAL_LOCKED');
    expect(state.stealWinner).toBe(PLAYER_B);

    // Moderator judges steal wrong
    state.scores = applyScoreDelta(state.scores, PLAYER_B, pointsForWrongSteal(200));
    state = markFieldAnswered(state, 0, 200, PLAYER_B, false, pointsForWrongSteal(200));
    state = resetBuzzer(state);
    state.phase = 'FIELD_DONE';

    expect(state.scores[PLAYER_B]).toBe(-100); // 0 - 100
    expect(state.openFields['1-0-200']).toBeUndefined();
  });

  it('simulates: correct steal → thief gets half points', () => {
    let state = makeInitialState();

    // Wrong first answer → steal
    state.phase = 'STEAL_LOCKED';
    state.stealWinner = PLAYER_B;
    state.currentField = { categoryIndex: 0, value: 500, fieldDef: makeFieldDef(0, 500) };

    // Steal correct → thief gets 50% = 250
    const stealDelta = pointsForCorrectSteal(500);
    expect(stealDelta).toBe(250);

    state.scores = applyScoreDelta(state.scores, PLAYER_B, stealDelta);
    state = markFieldAnswered(state, 0, 500, PLAYER_B, true, stealDelta);

    expect(state.scores[PLAYER_B]).toBe(250);
  });

  it('all fields playable exactly once', () => {
    let state = makeInitialState();

    // All 30 fields on board 1
    expect(countOpenFields(state, 1)).toBe(30);
    expect(isBoardComplete(state, 1)).toBe(false);

    // Play all fields
    let ci = 0;
    let vi = 0;
    const values = [100, 200, 300, 400, 500];

    for (let i = 0; i < 30; i++) {
      const catIdx = i % 6;
      const valIdx = Math.floor(i / 6);
      const value = values[valIdx];

      state.phase = 'BUZZ_OPEN';
      state.currentField = { categoryIndex: catIdx, value, fieldDef: makeFieldDef(catIdx, value) };
      state.buzzWinner = PLAYER_A;
      state.phase = 'BUZZ_LOCKED';

      state.scores = applyScoreDelta(state.scores, PLAYER_A, pointsForCorrect(value));
      state = markFieldAnswered(state, catIdx, value, PLAYER_A, true, pointsForCorrect(value));
      state.phase = 'FIELD_DONE';
      state = resetBuzzer(state);
      state.phase = 'SELECTING';
    }

    expect(countOpenFields(state, 1)).toBe(0);
    expect(isBoardComplete(state, 1)).toBe(true);
  });
});
